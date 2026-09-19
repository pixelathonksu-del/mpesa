import crypto from 'node:crypto';

function getConfig() {
  const { PAYHERO_BASE_URL, PAYHERO_PAYMENT_PATH, PAYHERO_API_USERNAME, PAYHERO_API_PASSWORD, PAYHERO_ACCOUNT_ID, PAYHERO_CHANNEL_ID } = process.env;
  if (!PAYHERO_BASE_URL || !PAYHERO_API_USERNAME || !PAYHERO_API_PASSWORD) throw new Error('PayHero server configuration is incomplete');
  return { baseUrl: PAYHERO_BASE_URL.replace(/\/$/, ''), path: PAYHERO_PAYMENT_PATH || '/api/v2/payments', username: PAYHERO_API_USERNAME, password: PAYHERO_API_PASSWORD, accountId: PAYHERO_ACCOUNT_ID, channelId: PAYHERO_CHANNEL_ID };
}

export async function requestPayment({ phone, amount, reference, description, sessionId, transactionId }) {
  const config = getConfig();
  const payload = { phone_number: phone, amount, external_reference: reference, description, session_id: sessionId, transaction_id: transactionId };
  if (config.accountId) payload.account_id = config.accountId;
  if (config.channelId) payload.channel_id = config.channelId;
  const response = await fetch(`${config.baseUrl}${config.path}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(body.message || `PayHero returned HTTP ${response.status}`); error.providerBody = body; error.statusCode = response.status; throw error; }
  return { providerId: body.transaction_id || body.id || body.reference || null, body };
}

export function verifyWebhook(rawBody, signature) {
  const secret = process.env.PAYHERO_WEBHOOK_SECRET;
  if (!secret) return process.env.NODE_ENV !== 'production';
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const supplied = signature.replace(/^sha256=/, '');
  return supplied.length === expected.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}