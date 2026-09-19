import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_URL;

export const pool = connectionString ? new Pool({ connectionString }) : null;

export async function withDb(callback) {
  if (!pool) {
    throw new Error('No database connection configured. Set DATABASE_URL or SUPABASE_URL.');
  }

  const client = await pool.connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

export async function ensureSchema() {
  if (!pool) return;
  const schemaSql = `
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
      import_id text not null,
      operator text not null,
      amount integer not null,
      description text not null,
      status text not null,
      started_at text,
      completed_at text,
      created_at text not null
    );

    create table if not exists session_customers (
      session_id text not null,
      customer_id text not null,
      position integer not null,
      status text not null default 'WAITING',
      primary key (session_id, customer_id)
    );

    create table if not exists transactions (
      id text primary key,
      session_id text not null,
      customer_id text not null,
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
  `;

  await withDb(async client => {
    await client.query(schemaSql);
  });
}
