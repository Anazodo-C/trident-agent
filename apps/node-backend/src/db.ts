import type { Database } from 'better-sqlite3'
import { mkdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DB_PATH, IS_PROD } from './env.ts'
import { openDatabase } from './dbEncryption.ts'

/**
 * better-sqlite3 refuses to create the database's parent directory, so a
 * DB_PATH pointing at a not-yet-mounted volume crashes on boot.
 *
 * Creating it is the right call — but doing so silently would be worse than
 * crashing. This database holds the users' encrypted agent-wallet keys, and
 * they are unrecoverable by design: if it lands on a container's ephemeral
 * layer, the next redeploy destroys every wallet with no way back. So we
 * create the directory and then say plainly whether it will actually survive.
 */
/**
 * Whether the database sits on a mounted volume. Surfaced on /health so the
 * mount can be confirmed from outside the platform, rather than by reading a
 * startup log that scrolls away.
 */
export let STORAGE_PERSISTENT: boolean | null = null

function prepareDatabaseDirectory(path: string): void {
  const dir = dirname(resolve(path))
  mkdirSync(dir, { recursive: true })

  // A mounted volume is a different device from the container root filesystem.
  // Same device means the data lives on the ephemeral layer.
  let ephemeral: boolean
  try {
    ephemeral = statSync(dir).dev === statSync('/').dev
  } catch {
    return
  }
  STORAGE_PERSISTENT = !ephemeral

  if (!IS_PROD) return

  if (ephemeral) {
    console.warn(
      [
        '',
        '  ┌─────────────────────────────────────────────────────────────────┐',
        '  │  WARNING: the database is NOT on a persistent volume.           │',
        '  └─────────────────────────────────────────────────────────────────┘',
        `  DB_PATH resolves to ${dir}, which is on the container filesystem.`,
        '  Every redeploy will erase all users and their encrypted agent-wallet',
        '  keys. Those keys cannot be recovered, so any USDC held by a wallet',
        '  would be permanently lost.',
        '  Attach a volume whose mount path matches DB_PATH before real use.',
        '',
      ].join('\n'),
    )
  }
}

prepareDatabaseDirectory(DB_PATH)

// Encrypted with SQLCipher when DB_ENCRYPTION_KEY is set, and converted in
// place on first boot if the existing file is still plaintext.
const db: Database = openDatabase(DB_PATH)

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
  -- Off by default: until a user opts in, the agent can only spend testnet
  -- funds, so no goal can ever cost real money by accident.
  mainnet_enabled       INTEGER DEFAULT 0,
  mainnet_chain         TEXT DEFAULT 'BASE',
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

-- Mirror of the x402 discovery registry (the "Bazaar"). Synced periodically so
-- new services appear without a deploy, and so the planner can retrieve
-- candidates locally instead of shipping 14k services to the model.
CREATE TABLE IF NOT EXISTS services (
  id              TEXT PRIMARY KEY,
  resource        TEXT UNIQUE NOT NULL,
  -- 'x402' = paid, settled through Gateway.
  -- 'free' = public API, still metered by an Arc Testnet verification payment.
  source          TEXT DEFAULT 'x402',
  service_name    TEXT,
  description     TEXT,
  tags            TEXT,
  host            TEXT,
  -- Preferred settlement network, chosen from the accepts list at sync time.
  network         TEXT,
  chain_key       TEXT,
  is_testnet      INTEGER DEFAULT 0,
  -- Every Gateway-settleable option, so the runner can pick per user.
  networks_json   TEXT,
  asset           TEXT,
  price_usdc      REAL,
  scheme          TEXT,
  http_method     TEXT DEFAULT 'GET',
  curated         INTEGER DEFAULT 0,
  calls_30d       INTEGER DEFAULT 0,
  payers_30d      INTEGER DEFAULT 0,
  last_called_at  TEXT,
  icon_url        TEXT,
  synced_at       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_services_rank    ON services(curated DESC, calls_30d DESC);
CREATE INDEX IF NOT EXISTS idx_services_chain   ON services(chain_key, is_testnet);
CREATE INDEX IF NOT EXISTS idx_services_name    ON services(service_name);

CREATE TABLE IF NOT EXISTS registry_sync (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  started_at    INTEGER,
  completed_at  INTEGER,
  total_seen    INTEGER DEFAULT 0,
  total_kept    INTEGER DEFAULT 0,
  status        TEXT,
  error         TEXT
);

-- Chat transcript. The agent answers follow-ups from what it already fetched
-- where it can, so history is part of the product, not just a log.
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  user_id    TEXT REFERENCES users(id),
  task_id    TEXT,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  kind       TEXT DEFAULT 'text',
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS rate_limits (
  user_id      TEXT PRIMARY KEY REFERENCES users(id),
  plan_count   INTEGER DEFAULT 0,
  window_start INTEGER DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_user     ON tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_steps_task     ON task_steps(task_id, step_index);
CREATE UNIQUE INDEX IF NOT EXISTS idx_steps_unique ON task_steps(task_id, step_index);
`)

/**
 * Additive migrations for databases created before a column existed.
 * CREATE TABLE IF NOT EXISTS does nothing to an existing table, and the
 * production volume already holds real users, so new columns have to be added
 * explicitly. Adding a column that is already there is a no-op, not an error.
 */
function addColumnIfMissing(table: string, column: string, definition: string): void {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (existing.some((c) => c.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

addColumnIfMissing('users', 'mainnet_enabled', 'INTEGER DEFAULT 0')
addColumnIfMissing('users', 'mainnet_chain', "TEXT DEFAULT 'BASE'")
addColumnIfMissing('services', 'source', "TEXT DEFAULT 'x402'")
// Verification transfer hash for free-API calls, alongside the x402 tx_ref.
addColumnIfMissing('task_steps', 'verification_tx', 'TEXT')
/**
 * PBKDF2 iteration count this user's key was encrypted with.
 *
 * Per-user because the number has to be able to rise over time. Existing rows
 * default to 200000 — the value in force when they were created — and their
 * ciphertext can only be decrypted with that count, so raising the constant
 * alone would have locked every existing wallet out permanently.
 */
addColumnIfMissing('users', 'kdf_iterations', 'INTEGER DEFAULT 200000')
/**
 * Which upstream catalog the stored services came from.
 *
 * Changing the discovery source does not make the existing rows stale by age,
 * so the boot-time freshness check happily kept serving a catalog from the old
 * provider. Recording the source means a swap forces a rebuild.
 */
addColumnIfMissing('registry_sync', 'source_version', 'TEXT')
/**
 * JSON Schema for the endpoint's inputs, as published by discovery.
 *
 * Without it the planner guesses parameter names, and a service called with
 * none of its required ones answers 400 — after the payment has authorised.
 */
addColumnIfMissing('services', 'input_schema', 'TEXT')

export interface MessageRow {
  id: string
  user_id: string
  task_id: string | null
  role: string
  content: string
  kind: string
  created_at: number
}

export interface ServiceRow {
  id: string
  resource: string
  source: string
  service_name: string | null
  description: string | null
  tags: string | null
  host: string | null
  network: string | null
  chain_key: string | null
  is_testnet: number
  networks_json: string | null
  asset: string | null
  price_usdc: number | null
  scheme: string | null
  http_method: string
  curated: number
  calls_30d: number
  payers_30d: number
  last_called_at: string | null
  icon_url: string | null
  input_schema: string | null
  synced_at: number | null
}

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
  kdf_iterations: number
  mainnet_enabled: number
  mainnet_chain: string
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
