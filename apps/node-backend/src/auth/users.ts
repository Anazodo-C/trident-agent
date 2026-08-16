import { randomUUID } from 'node:crypto'
import db, { type UserRow } from '../db.ts'

export function findUserById(id: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined
}

/**
 * Find-or-create by Google subject id. Email is kept in sync but is not the
 * identity key — Google ids are stable, emails are not.
 */
export function upsertGoogleUser(googleId: string, email: string | null): UserRow {
  const existing = db.prepare('SELECT * FROM users WHERE google_id = ?').get(googleId) as
    | UserRow
    | undefined
  if (existing) {
    if (email && email !== existing.email) {
      db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, existing.id)
    }
    return findUserById(existing.id)!
  }

  // An account may already exist from a SIWE-first signup that carries this email.
  if (email) {
    const byEmail = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as
      | UserRow
      | undefined
    if (byEmail) {
      db.prepare('UPDATE users SET google_id = ? WHERE id = ?').run(googleId, byEmail.id)
      return findUserById(byEmail.id)!
    }
  }

  const id = randomUUID()
  db.prepare('INSERT INTO users (id, email, google_id) VALUES (?, ?, ?)').run(id, email, googleId)
  return findUserById(id)!
}

/** Find-or-create by external Web3 wallet address (SIWE). Addresses are stored lowercased. */
export function upsertWalletUser(walletAddress: string): UserRow {
  const address = walletAddress.toLowerCase()
  const existing = db.prepare('SELECT * FROM users WHERE lower(wallet_address) = ?').get(address) as
    | UserRow
    | undefined
  if (existing) return existing

  const id = randomUUID()
  db.prepare('INSERT INTO users (id, wallet_address) VALUES (?, ?)').run(id, address)
  return findUserById(id)!
}

/** True when the user has not yet created their agent wallet. */
/**
 * Whether this account still needs to be set up before it can pay.
 *
 * Keyed on the Circle wallet, which is the only thing that can sign. It used to
 * test for an encrypted EOA, which no account gets any more, so leaving it
 * would have sent every user to the passphrase screen on every visit and
 * refused them when they arrived.
 *
 * The testnet wallet is the minimum: the free tier meters on it, so an account
 * without one cannot run anything at all.
 */
export function needsPassphraseSetup(user: UserRow): boolean {
  return !user.circle_wallet_id_testnet && !user.circle_wallet_id
}
