import Database from 'better-sqlite3'
import { DB_PATH } from './env.ts'

const db = new Database(DB_PATH)

db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id                    TEXT PRIMARY KEY,
  email                 TEXT UNIQUE,
  wallet_address        TEXT,
  google_id             TEXT UNIQUE,
  eoa_address           TEXT,
  encrypted_payment_key TEXT,
  payment_key_salt      TEXT,
  payment_key_iv        TEXT,
  spending_cap_usdc     REAL DEFAULT 10.0,
  default_chain         TEXT DEFAULT 'ARC-TESTNET',
  created_at            INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id               TEXT PRIMARY KEY,
  user_id          TEXT REFERENCES users(id),
  goal             TEXT NOT NULL,
  status           TEXT DEFAULT 'pending',
  total_cost_usdc  REAL DEFAULT 0,
  budget_usdc      REAL,
  created_at       INTEGER DEFAULT (strftime('%s','now')),
  completed_at     INTEGER
);

CREATE TABLE IF NOT EXISTS task_steps (
  id                   TEXT PRIMARY KEY,
  task_id              TEXT REFERENCES tasks(id),
  step_index           INTEGER,
  service_name         TEXT,
  endpoint_url         TEXT,
  http_method          TEXT DEFAULT 'GET',
  params               TEXT,
  estimated_cost_usdc  REAL,
  actual_cost_usdc     REAL,
  status               TEXT DEFAULT 'pending',
  response_summary     TEXT,
  tx_ref               TEXT,
  started_at           INTEGER,
  completed_at         INTEGER
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  user_id     TEXT PRIMARY KEY REFERENCES users(id),
  abort_flag  INTEGER DEFAULT 0,
  updated_at  INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS rate_limits (
  user_id      TEXT PRIMARY KEY REFERENCES users(id),
  plan_count   INTEGER DEFAULT 0,
  window_start INTEGER DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_user     ON tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_steps_task     ON task_steps(task_id, step_index);
CREATE UNIQUE INDEX IF NOT EXISTS idx_steps_unique ON task_steps(task_id, step_index);
`)

export interface UserRow {
  id: string
  email: string | null
  wallet_address: string | null
  google_id: string | null
  eoa_address: string | null
  encrypted_payment_key: string | null
  payment_key_salt: string | null
  payment_key_iv: string | null
  spending_cap_usdc: number
  default_chain: string
  created_at: number
}

export interface TaskRow {
  id: string
  user_id: string
  goal: string
  status: string
  total_cost_usdc: number
  budget_usdc: number | null
  created_at: number
  completed_at: number | null
}

export interface TaskStepRow {
  id: string
  task_id: string
  step_index: number
  service_name: string
  endpoint_url: string
  http_method: string
  params: string | null
  estimated_cost_usdc: number
  actual_cost_usdc: number | null
  status: string
  response_summary: string | null
  tx_ref: string | null
  started_at: number | null
  completed_at: number | null
}

export default db
