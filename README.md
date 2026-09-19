# Kijani Pay

Kijani Pay is a responsive operator workspace for sequential Kenyan M-Pesa payment requests. The interface covers the intended workflow: import a customer PDF, review and authorize numbers, set an amount, start a one-customer-at-a-time session, and inspect session, transaction, report, settings, integration, and audit views.

## Run locally

The workspace includes a Node backend and a static frontend:

```bash
npm install
cp .env.example .env
npm start
```

Open `http://localhost:4173` in a browser.

The API uses SQLite at `./data/kijani-pay.sqlite` by default. Set `DATABASE_PATH` to an absolute path for deployments. Run `npm run dev` for Node watch mode.

## What is implemented

- Responsive fintech operations shell with dashboard navigation.
- PDF-only drag-and-drop/file picker with import progress states.
- Kenyan-number review table with search, selection, masking, and removal controls.
- Explicit authorization confirmation and amount confirmation gates.
- Sequential payment-session UI with current-customer status, queue, pause, and cancel controls.
- Session history, customer directory, transaction ledger, collection reports, settings, PayHero connection status, and audit-log views.
- No phone-number scraping, generated numbers, M-Pesa PIN collection, or frontend payment credentials.

The frontend is intentionally thin. PDF extraction, PayHero calls, webhook processing, authentication, and persistence run in the Node API and must remain server-side before handling real customer data or payments.

## API contract

The backend provides these authenticated operator routes:

- `POST /api/imports`: multipart PDF validation, safe text extraction, Kenyan phone normalization, deduplication, and import persistence.
- `POST /api/payment-sessions`: create a confirmation-gated `READY` session.
- `POST /api/payment-sessions/:id/start`: move a session to `RUNNING`.
- `POST /api/payment-sessions/:id/advance`: lock the session and send exactly one PayHero request.
- `POST /api/payhero/webhook`: verify the provider signature, deduplicate events, and save the terminal result.
- `GET /api/payment-sessions/:id`: return masked session progress.

Operator routes accept `Authorization: Bearer <OPERATOR_API_KEY>` when `OPERATOR_API_KEY` is configured. Production refuses to start operator requests without that configuration. The sample local mode uses `x-operator-id` only as an audit label; add real OIDC/session authentication before production.

Persisted tables include `imports`, `customers`, `payment_sessions`, `session_customers`, `transactions`, `webhook_events`, and `audit_logs`. Keep PayHero secrets in environment-backed server secrets, never in browser code or transaction metadata. Mask phone numbers in normal responses, encrypt private values at rest, apply retention/deletion rules, and log every state transition without PINs, tokens, or credentials.

The sequential invariant should be enforced server-side, not trusted to the browser: a session may have at most one non-terminal transaction (`PROCESSING` or `PENDING`) at any time. Retry must use a new, explicitly confirmed attempt and must be blocked while the original attempt is unresolved.