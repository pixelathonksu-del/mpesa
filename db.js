import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

const { Pool } = pg;
const asyncLocalStorage = new AsyncLocalStorage();
const usePostgres = Boolean(process.env.DATABASE_URL || process.env.SUPABASE_URL);

const postgresize = (sql, params = []) => {
  let index = 1;
  const text = sql.replace(/\?/g, () => `$${index++}`);
  return { text, values: params };
};

const sqliteSetup = () => {
  const databasePath = process.env.DATABASE_PATH || './data/kijani-pay.sqlite';
  fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  const sqliteDb = new DatabaseSync(databasePath);
  sqliteDb.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS imports (
      id TEXT PRIMARY KEY, filename TEXT NOT NULL, uploaded_by TEXT NOT NULL, uploaded_at TEXT NOT NULL,
      detected_count INTEGER NOT NULL, valid_count INTEGER NOT NULL, invalid_count INTEGER NOT NULL, duplicate_count INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY, phone TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, created_by TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payment_sessions (
      id TEXT PRIMARY KEY, import_id TEXT NOT NULL, operator TEXT NOT NULL, amount INTEGER NOT NULL,
      description TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT, completed_at TEXT, created_at TEXT NOT NULL,
      FOREIGN KEY (import_id) REFERENCES imports(id)
    );
    CREATE TABLE IF NOT EXISTS session_customers (
      session_id TEXT NOT NULL, customer_id TEXT NOT NULL, position INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'WAITING', PRIMARY KEY (session_id, customer_id),
      FOREIGN KEY (session_id) REFERENCES payment_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, customer_id TEXT NOT NULL, phone TEXT NOT NULL,
      amount INTEGER NOT NULL, description TEXT NOT NULL, reference TEXT NOT NULL UNIQUE,
      provider_transaction_id TEXT, mpesa_receipt TEXT, status TEXT NOT NULL, failure_reason TEXT,
      request_time TEXT NOT NULL, completion_time TEXT, operator TEXT NOT NULL, provider_metadata TEXT,
      FOREIGN KEY (session_id) REFERENCES payment_sessions(id), FOREIGN KEY (customer_id) REFERENCES customers(id)
    );
    CREATE TABLE IF NOT EXISTS webhook_events (
      provider_event_id TEXT PRIMARY KEY, received_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY, event TEXT NOT NULL, operator TEXT NOT NULL, resource_id TEXT, metadata TEXT, created_at TEXT NOT NULL
    );
  `);
  return sqliteDb;
};

let pool = null;
let db = null;

if (usePostgres) {
  const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_URL;
  pool = new Pool({ connectionString });
  db = {
    close: () => pool.end(),
    exec: async sql => {
      const client = await pool.connect();
      try {
        await client.query(sql);
      } finally {
        client.release();
      }
    }
  };
} else {
  db = sqliteSetup();
}

const getClient = async () => {
  const transactionClient = asyncLocalStorage.getStore()?.client;
  if (transactionClient) return transactionClient;
  if (usePostgres) {
    return await pool.connect();
  }
  return null;
};

const releaseClient = async client => {
  if (usePostgres && client && !asyncLocalStorage.getStore()?.client) {
    client.release();
  }
};

export { db };

export async function one(sql, params = []) {
  if (usePostgres) {
    const client = await getClient();
    const { text, values } = postgresize(sql, params);
    try {
      const result = await client.query(text, values);
      return result.rows[0] || undefined;
    } finally {
      await releaseClient(client);
    }
  }
  return db.prepare(sql).get(...params);
}

export async function all(sql, params = []) {
  if (usePostgres) {
    const client = await getClient();
    const { text, values } = postgresize(sql, params);
    try {
      const result = await client.query(text, values);
      return result.rows;
    } finally {
      await releaseClient(client);
    }
  }
  return db.prepare(sql).all(...params);
}

export async function run(sql, params = []) {
  if (usePostgres) {
    const client = await getClient();
    const { text, values } = postgresize(sql, params);
    try {
      const result = await client.query(text, values);
      return result;
    } finally {
      await releaseClient(client);
    }
  }
  return db.prepare(sql).run(...params);
}

export async function transaction(callback) {
  if (usePostgres) {
    const client = await pool.connect();
    await client.query('BEGIN');
    try {
      const result = await asyncLocalStorage.run({ client }, () => callback());
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}