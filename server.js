import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { db, all, one, run, transaction } from './db.js';
import { extractPdfText, isPdfFile } from './pdf.js';
import { extractKenyanPhones, maskPhone } from './phone.js';
import { requestPayment, verifyWebhook } from './payhero.js';

const app = express();
const port = Number(process.env.PORT || 4173);
const maxSessionSize = Number(process.env.MAX_SESSION_SIZE || 250);
const maxPaymentAmount = Number(process.env.MAX_PAYMENT_AMOUNT || 150000);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: Number(process.env.MAX_UPLOAD_BYTES || 10485760), files: 1 } });
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const operator = request => request.get('x-operator-id') || 'local-operator';
const audit = (event, actor, resourceId, metadata = {}) => run('INSERT INTO audit_logs (id,event,operator,resource_id,metadata,created_at) VALUES (?,?,?,?,?,?)', [id(), event, actor, resourceId || null, JSON.stringify(metadata), now()]);
const publicCustomer = customer => ({ id: customer.id, phone: maskPhone(customer.phone), status: customer.status });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true }));
app.set('trust proxy', 1);
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));
app.use('/api/payhero/webhook', express.raw({ type: 'application/json', limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static('.'));

function requireOperator(request, response, next) {
  if (process.env.NODE_ENV === 'production' && !process.env.OPERATOR_API_KEY) return response.status(503).json({ error: 'Operator authentication is not configured' });
  if (process.env.OPERATOR_API_KEY && request.get('authorization') !== `Bearer ${process.env.OPERATOR_API_KEY}`) return response.status(401).json({ error: 'Unauthorized' });
  next();
}

app.get('/api/health', (request, response) => response.json({ ok: true, service: 'kijani-pay', time: now() }));

app.post('/api/imports', requireOperator, upload.single('pdf'), async (request, response, next) => {
  try {
    if (!request.file || !isPdfFile(request.file)) return response.status(400).json({ error: 'A valid PDF file is required' });
    const text = await extractPdfText(request.file);
    const { numbers, invalidCount, duplicateCount } = extractKenyanPhones(text);
    const importId = id();
    const actor = operator(request);
    transaction(() => {
      run('INSERT INTO imports VALUES (?,?,?,?,?,?,?,?)', [importId, request.file.originalname, actor, now(), numbers.length + invalidCount + duplicateCount, numbers.length, invalidCount, duplicateCount]);
      numbers.forEach(phone => {
        const existing = one('SELECT id FROM customers WHERE phone = ?', [phone]);
        if (!existing) run('INSERT INTO customers VALUES (?,?,?,?)', [id(), phone, now(), actor]);
      });
      audit('PDF_UPLOADED', actor, importId, { filename: request.file.originalname });
      audit('PHONE_NUMBERS_EXTRACTED', actor, importId, { valid: numbers.length, invalid: invalidCount });
    });
    response.status(201).json({ id: importId, filename: request.file.originalname, detected: numbers.length + invalidCount + duplicateCount, valid: numbers.length, invalid: invalidCount, duplicates: duplicateCount, customers: numbers.map(phone => publicCustomer({ id: one('SELECT id FROM customers WHERE phone = ?', [phone]).id, phone, status: 'READY' })) });
  } catch (error) { next(error); }
});

app.post('/api/payment-sessions', requireOperator, (request, response, next) => {
  try {
    const { importId, customerIds, amount, description = 'M-Pesa payment request', authorizationConfirmed, amountConfirmed } = request.body || {};
    if (!authorizationConfirmed || !amountConfirmed) return response.status(400).json({ error: 'Authorization and amount confirmation are required' });
    if (!Array.isArray(customerIds) || customerIds.length === 0 || customerIds.length > maxSessionSize) return response.status(400).json({ error: `Select between 1 and ${maxSessionSize} customers` });
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0 || Number(amount) > maxPaymentAmount) return response.status(400).json({ error: `Amount must be greater than 0 and no more than KES ${maxPaymentAmount}` });
    if (!importId || customerIds.some(customerId => !one('SELECT id FROM customers WHERE id = ?', [customerId]))) return response.status(400).json({ error: 'Invalid import or customer selection' });
    const sessionId = `PS-${new Date().getFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const actor = operator(request);
    transaction(() => {
      run('INSERT INTO payment_sessions VALUES (?,?,?,?,?,?,?,?,?)', [sessionId, importId, actor, Math.round(Number(amount)), description, 'READY', null, null, now()]);
      customerIds.forEach((customerId, position) => run('INSERT INTO session_customers VALUES (?,?,?,?)', [sessionId, customerId, position + 1, 'WAITING']));
      audit('PAYMENT_SESSION_CREATED', actor, sessionId, { count: customerIds.length, amount: Number(amount) });
    });
    response.status(201).json({ id: sessionId, status: 'READY', totalCustomers: customerIds.length });
  } catch (error) { next(error); }
});

app.post('/api/payment-sessions/:sessionId/start', requireOperator, (request, response, next) => {
  try {
    const session = one('SELECT * FROM payment_sessions WHERE id = ?', [request.params.sessionId]);
    if (!session || session.status !== 'READY') return response.status(409).json({ error: 'Session is not ready to start' });
    run('UPDATE payment_sessions SET status = ?, started_at = ? WHERE id = ?', ['RUNNING', now(), session.id]);
    audit('PAYMENT_SESSION_STARTED', operator(request), session.id);
    response.json({ id: session.id, status: 'RUNNING' });
  } catch (error) { next(error); }
});

app.post('/api/payment-sessions/:sessionId/advance', requireOperator, async (request, response, next) => {
  let reserved;
  try {
    reserved = transaction(() => {
      const session = one('SELECT * FROM payment_sessions WHERE id = ?', [request.params.sessionId]);
      if (!session || session.status !== 'RUNNING') throw Object.assign(new Error('Session is not running'), { statusCode: 409 });
      const active = one("SELECT id FROM transactions WHERE session_id = ? AND status IN ('PROCESSING','PENDING')", [session.id]);
      if (active) throw Object.assign(new Error('A payment is already awaiting a result'), { statusCode: 409 });
      const nextCustomer = one("SELECT sc.*, c.phone FROM session_customers sc JOIN customers c ON c.id = sc.customer_id WHERE sc.session_id = ? AND sc.status = 'WAITING' ORDER BY sc.position LIMIT 1", [session.id]);
      if (!nextCustomer) { run('UPDATE payment_sessions SET status = ?, completed_at = ? WHERE id = ?', ['COMPLETED', now(), session.id]); audit('PAYMENT_SESSION_COMPLETED', operator(request), session.id); return null; }
      const transactionId = id(); const reference = `PAY-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
      run('UPDATE session_customers SET status = ? WHERE session_id = ? AND customer_id = ?', ['PROCESSING', session.id, nextCustomer.customer_id]);
      run('INSERT INTO transactions (id,session_id,customer_id,phone,amount,description,reference,status,request_time,operator) VALUES (?,?,?,?,?,?,?,?,?,?)', [transactionId, session.id, nextCustomer.customer_id, nextCustomer.phone, session.amount, session.description, reference, 'PROCESSING', now(), operator(request)]);
      audit('PAYMENT_REQUEST_SENT', operator(request), transactionId, { sessionId: session.id, customerId: nextCustomer.customer_id });
      return { session, customer: nextCustomer, transactionId, reference };
    });
    if (!reserved) return response.json({ status: 'COMPLETED' });
    try {
      const provider = await requestPayment({ phone: reserved.customer.phone, amount: reserved.session.amount, reference: reserved.reference, description: reserved.session.description, sessionId: reserved.session.id, transactionId: reserved.transactionId });
      run('UPDATE transactions SET status = ?, provider_transaction_id = ?, provider_metadata = ? WHERE id = ?', ['PENDING', provider.providerId, JSON.stringify(provider.body), reserved.transactionId]);
      run('UPDATE session_customers SET status = ? WHERE session_id = ? AND customer_id = ?', ['PENDING', reserved.session.id, reserved.customer.customer_id]);
      response.status(202).json({ transactionId: reserved.transactionId, status: 'PENDING', phone: maskPhone(reserved.customer.phone), reference: reserved.reference });
    } catch (error) {
      run('UPDATE transactions SET status = ?, failure_reason = ?, completion_time = ? WHERE id = ?', ['FAILED', error.message, now(), reserved.transactionId]);
      run('UPDATE session_customers SET status = ? WHERE session_id = ? AND customer_id = ?', ['FAILED', reserved.session.id, reserved.customer.customer_id]);
      audit('PAYMENT_FAILED', operator(request), reserved.transactionId, { reason: error.message });
      response.status(502).json({ error: 'PayHero request failed', transactionId: reserved.transactionId });
    }
  } catch (error) { response.status(error.statusCode || 500).json({ error: error.message }); }
});

app.post('/api/payhero/webhook', (request, response) => {
  if (!verifyWebhook(request.body, request.get('x-payhero-signature'))) return response.status(401).json({ error: 'Invalid webhook signature' });
  let payload; try { payload = JSON.parse(request.body.toString('utf8')); } catch { return response.status(400).json({ error: 'Invalid JSON' }); }
  const eventId = payload.event_id || payload.id || payload.transaction_id;
  if (!eventId) return response.status(400).json({ error: 'Webhook event ID is required' });
  if (one('SELECT provider_event_id FROM webhook_events WHERE provider_event_id = ?', [eventId])) return response.json({ received: true, duplicate: true });
  const providerId = payload.transaction_id || payload.provider_transaction_id || payload.id;
  const providerTransaction = one('SELECT * FROM transactions WHERE provider_transaction_id = ? OR id = ?', [providerId || null, payload.transaction_id || null]);
  run('INSERT INTO webhook_events VALUES (?,?)', [eventId, now()]);
  audit('PAYHERO_WEBHOOK_RECEIVED', 'payhero', providerTransaction?.id || eventId, { eventId });
  if (!providerTransaction) return response.json({ received: true });
  const successful = String(payload.status || payload.result || '').toUpperCase() === 'SUCCESS' || payload.success === true;
  const status = successful ? 'SUCCESS' : 'FAILED';
  const receipt = payload.mpesa_receipt || payload.receipt || null;
  transaction(() => {
    run('UPDATE transactions SET status = ?, mpesa_receipt = ?, failure_reason = ?, completion_time = ?, provider_metadata = ? WHERE id = ?', [status, receipt, successful ? null : (payload.message || 'Payment was not completed'), now(), JSON.stringify(payload), providerTransaction.id]);
    run('UPDATE session_customers SET status = ? WHERE session_id = ? AND customer_id = ?', [status, providerTransaction.session_id, providerTransaction.customer_id]);
    audit(successful ? 'PAYMENT_SUCCESS' : 'PAYMENT_FAILED', 'payhero', providerTransaction.id, { receipt });
  });
  response.json({ received: true });
});

app.get('/api/payment-sessions/:sessionId', requireOperator, (request, response) => {
  const session = one('SELECT * FROM payment_sessions WHERE id = ?', [request.params.sessionId]);
  if (!session) return response.status(404).json({ error: 'Session not found' });
  const customers = all('SELECT sc.position, sc.status, c.id, c.phone FROM session_customers sc JOIN customers c ON c.id = sc.customer_id WHERE sc.session_id = ? ORDER BY sc.position', [session.id]);
  response.json({ ...session, customers: customers.map(publicCustomer), counts: customers.reduce((result, customer) => { result[customer.status] = (result[customer.status] || 0) + 1; return result; }, {}) });
});

app.use((error, request, response, next) => { if (error instanceof multer.MulterError || error.statusCode === 400) return response.status(400).json({ error: error.message }); console.error(error); response.status(500).json({ error: 'Internal server error' }); });
app.listen(port, () => console.log(`Kijani Pay API listening on http://localhost:${port}`));

process.on('SIGTERM', () => { db.close(); process.exit(0); });