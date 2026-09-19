import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const databasePath = process.env.DATABASE_PATH || './data/kijani-pay.sqlite';
fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
export const db = new DatabaseSync(databasePath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
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

export function one(sql, params = []) { return db.prepare(sql).get(...params); }
export function all(sql, params = []) { return db.prepare(sql).all(...params); }
export function run(sql, params = []) { return db.prepare(sql).run(...params); }
export function transaction(callback) { db.exec('BEGIN IMMEDIATE'); try { const result = callback(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }