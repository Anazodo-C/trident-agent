import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as DatabaseType } from 'better-sqlite3'
import { copyFileSync, existsSync, openSync, readSync, closeSync, unlinkSync } from 'node:fs'
import { DB_ENCRYPTION_KEY, IS_PROD } from './env.ts'

/**
 * Whole-file encryption for the SQLite database, via SQLCipher.
 *
 * Why: every user's wallet key lives in this file, encrypted under their
 * passphrase but sitting next to its own salt and IV. A copy of the file is a
 * complete offline cracking target. Encrypting the file means a leaked backup,
 * a stolen volume snapshot, or a disk pulled out of a machine is inert.
 *
 * What this does NOT protect against, and it matters: anyone who can read the
 * process environment can read DB_ENCRYPTION_KEY, and with it the database.
 * That includes anyone with access to the hosting project. This raises the bar
 * against the file escaping; it is not a defence against platform access.
 */

const SQLITE_MAGIC = 'SQLite format 3\0'

/** A plaintext SQLite file starts with a known 16-byte header; an encrypted one does not. */
function isPlaintextDatabase(path: string): boolean {
  if (!existsSync(path)) return false
  const fd = openSync(path, 'r')
  try {
    const header = Buffer.alloc(16)
    if (readSync(fd, header, 0, 16, 0) < 16) return false
    return header.toString('latin1') === SQLITE_MAGIC
  } finally {
    closeSync(fd)
  }
}

function keyed(path: string, key: string): DatabaseType {
  const db = new Database(path)
  // Order matters: the cipher must be selected before the key is applied.
  db.pragma(`cipher='sqlcipher'`)
  db.pragma(`key='${key.replace(/'/g, "''")}'`)
  return db
}

/**
 * Encrypt an existing plaintext database in place.
 *
 * `PRAGMA rekey` rewrites every page under the cipher within a transaction.
 * (`sqlcipher_export` is not available in this build — SQLite3MultipleCiphers
 * exposes rekey instead, which is simpler and needs no second file.)
 *
 * A plaintext copy is taken first and kept until the encrypted file has been
 * reopened and its contents confirmed, so a crash or a bad key leaves
 * something to restore. It is deleted on success — leaving a plaintext copy on
 * the volume would defeat the entire exercise.
 */
function migrateToEncrypted(path: string, key: string): void {
  const backup = `${path}.pre-encryption`
  if (existsSync(backup)) unlinkSync(backup)

  console.warn('[trident] database is unencrypted — converting to SQLCipher')

  // Fold the WAL into the main file first, so the backup is a complete
  // snapshot and rekey does not have to reason about uncheckpointed pages.
  const plain = new Database(path)
  plain.pragma('journal_mode = DELETE')
  const expectedUsers = (plain.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n
  plain.close()

  copyFileSync(path, backup)

  const target = new Database(path)
  try {
    target.pragma(`cipher='sqlcipher'`)
    target.pragma(`rekey='${key.replace(/'/g, "''")}'`)
  } finally {
    target.close()
  }

  // Reopen from scratch and prove the data survived before dropping the backup.
  const check = keyed(path, key)
  let gotUsers: number
  try {
    gotUsers = (check.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n
  } finally {
    check.close()
  }

  if (gotUsers !== expectedUsers) {
    throw new Error(
      `Database encryption failed verification: ${gotUsers} users after, ${expectedUsers} before. ` +
        `A plaintext copy of the original is at ${backup} — restore it before retrying.`,
    )
  }

  unlinkSync(backup)
  console.warn(`[trident] database encrypted (${expectedUsers} accounts preserved)`)
}

/**
 * Open the database, encrypted when a key is configured.
 *
 * Refuses to run unencrypted in production: silently falling back would store
 * wallet keys in the clear while the operator believed otherwise, which is a
 * worse outcome than failing to boot.
 */
export function openDatabase(path: string): DatabaseType {
  if (!DB_ENCRYPTION_KEY) {
    if (IS_PROD) {
      throw new Error(
        'DB_ENCRYPTION_KEY is not set. The database holds users’ encrypted wallet keys and ' +
          'will not be opened unencrypted in production. Set DB_ENCRYPTION_KEY and redeploy.',
      )
    }
    console.warn('[trident] DB_ENCRYPTION_KEY not set — database is UNENCRYPTED (development)')
    return new Database(path)
  }

  if (isPlaintextDatabase(path)) migrateToEncrypted(path, DB_ENCRYPTION_KEY)

  const db = keyed(path, DB_ENCRYPTION_KEY)

  // A wrong key does not fail on open — it fails on first read, with an
  // unhelpful "file is not a database". Force that now, with an error that
  // says what actually went wrong.
  try {
    db.prepare('SELECT count(*) FROM sqlite_master').get()
  } catch {
    db.close()
    throw new Error(
      'Could not open the database with DB_ENCRYPTION_KEY. If the key was changed or lost, the ' +
        'existing file cannot be recovered — restore a backup or restore the previous key.',
    )
  }

  return db
}
