create extension if not exists pgcrypto;

create table if not exists imports (
  id text primary key,
  filename text not null,
  uploaded_by text not null,
  uploaded_at text not null,
  detected_count integer not null,
  valid_count integer not null,
  invalid_count integer not null,
  duplicate_count integer not null
);

create table if not exists customers (
  id text primary key,
  phone text not null unique,
  created_at text not null,
  created_by text not null
);

create table if not exists payment_sessions (
  id text primary key,
  import_id text not null references imports(id),
  operator text not null,
  amount integer not null,
  description text not null,
  status text not null,
  started_at text,
  completed_at text,
  created_at text not null
);

create table if not exists session_customers (
  session_id text not null references payment_sessions(id) on delete cascade,
  customer_id text not null references customers(id),
  position integer not null,
  status text not null default 'WAITING',
  primary key (session_id, customer_id)
);

create table if not exists transactions (
  id text primary key,
  session_id text not null references payment_sessions(id),
  customer_id text not null references customers(id),
  phone text not null,
  amount integer not null,
  description text not null,
  reference text not null unique,
  provider_transaction_id text,
  mpesa_receipt text,
  status text not null,
  failure_reason text,
  request_time text not null,
  completion_time text,
  operator text not null,
  provider_metadata text
);

create table if not exists webhook_events (
  provider_event_id text primary key,
  received_at text not null
);

create table if not exists audit_logs (
  id text primary key,
  event text not null,
  operator text not null,
  resource_id text,
  metadata text,
  created_at text not null
);

create index if not exists idx_customers_phone on customers(phone);
create index if not exists idx_payment_sessions_import_id on payment_sessions(import_id);
create index if not exists idx_session_customers_session_id on session_customers(session_id);
create index if not exists idx_transactions_session_id on transactions(session_id);
create index if not exists idx_transactions_customer_id on transactions(customer_id);
create index if not exists idx_audit_logs_resource_id on audit_logs(resource_id);
