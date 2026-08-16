import { Router } from 'express'
import { randomBytes } from 'node:crypto'
import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import db from '../db.ts'
import { FRONTEND_URL } from '../env.ts'
import { asyncRoute, httpError } from '../http.ts'
import { verifyMessage } from 'viem'
import {
  PBKDF2_ITERATIONS,
  PBKDF2_ITERATIONS_LEGACY,
  buildRotationMessage,
  buildVerifierMessage,
  derivePassphraseVerifier,
} from '../auth/keySetup.ts'
import { passphraseProblem } from '../auth/passphrase.ts'
import { circleEnabled, circleEnvFor, provisionWallet } from '../circle/circleWallets.ts'
import { walletChainsFor } from '../circle/chainPolicy.ts'
import {
  currentUser,
  requireAuth,
  requireSetupAuth,
  signFullToken,
  signSetupToken,
} from '../auth/jwt.ts'
import {
  GOOGLE_ENABLED,
  consentUrl,
  createState,
  exchangeCodeForProfile,
  verifyState,
} from '../auth/google.ts'
import { issueNonce, verifySiwe } from '../auth/siwe.ts'
import { needsPassphraseSetup, upsertGoogleUser, upsertWalletUser, findUserById } from '../auth/users.ts'
import type { UserRow } from '../db.ts'

const router = Router()

/** Both login paths converge here: new users set a passphrase, returning users go to the app. */
function redirectForUser(user: UserRow): string {
  if (needsPassphraseSetup(user)) {
    return `${FRONTEND_URL}/setup-passphrase?token=${encodeURIComponent(signSetupToken(user.id))}`
  }
  return `${FRONTEND_URL}/app?token=${encodeURIComponent(signFullToken(user.id))}`
}

router.get('/google', (_req, res) => {
  if (!GOOGLE_ENABLED) {
    res.status(503).json({ error: 'Google OAuth is not configured on this server' })
    return
  }
  res.redirect(consentUrl(createState()))
})

router.get(
  '/google/callback',
  asyncRoute(async (req, res) => {
    const fail = (reason: string) =>
      res.redirect(`${FRONTEND_URL}/?authError=${encodeURIComponent(reason)}`)

    if (!GOOGLE_ENABLED) return fail('google_not_configured')
    if (typeof req.query['error'] === 'string') return fail(req.query['error'])
    if (!verifyState(req.query['state'])) return fail('invalid_state')

    const code = req.query['code']
    if (typeof code !== 'string') return fail('missing_code')

    try {
      const profile = await exchangeCodeForProfile(code)
      const user = upsertGoogleUser(profile.googleId, profile.email)
      return res.redirect(redirectForUser(user))
    } catch {
      return fail('google_exchange_failed')
    }
  }),
)

router.get('/siwe/nonce', (_req, res) => {
  res.json({ nonce: issueNonce() })
})

const SiweVerifyBody = z.object({
  message: z.string().min(1),
  signature: z.string().min(1),
})

router.post(
  '/siwe/verify',
  asyncRoute(async (req, res) => {
    const parsed = SiweVerifyBody.safeParse(req.body)
    if (!parsed.success) throw httpError(400, 'message and signature are required')

    const { address } = await verifySiwe(parsed.data.message, parsed.data.signature)
    const user = upsertWalletUser(address)

    if (needsPassphraseSetup(user)) {
      res.json({ needsSetup: true, setupToken: signSetupToken(user.id) })
      return
    }
    res.json({ needsSetup: false, token: signFullToken(user.id), user: publicUser(user) })
  }),
)

const SetupBody = z.object({
  // The real rule lives in passphrase.ts and is applied below; zod only keeps
  // a non-string out of it. Duplicating the length here would let the two
  // drift, and the weaker of the pair would be the one that mattered.
  passphrase: z.string(),
})

router.post(
  '/setup-passphrase',
  requireSetupAuth,
  asyncRoute(async (req, res) => {
    const user = currentUser(req)
    const parsed = SetupBody.safeParse(req.body)
    if (!parsed.success) {
      throw httpError(400, parsed.error.issues[0]?.message ?? 'Invalid passphrase')
    }

    const fresh = findUserById(user.id)
    if (!fresh) throw httpError(401, 'User no longer exists')
    // Re-running setup would leave a second wallet nobody is watching. Checked
    // before the passphrase rules so an existing wallet reports as such,
    // whatever was typed into the form.
    if (!needsPassphraseSetup(fresh)) {
      throw httpError(409, 'Agent wallet already exists for this account')
    }

    // Enforced here, not just in the browser: the passphrase gates every spend
    // and the client check is a convenience the caller can skip.
    const problem = passphraseProblem(parsed.data.passphrase)
    if (problem) throw httpError(400, problem)

    /*
     * A wallet, not a key.
     *
     * Circle creates and holds the signing key, so nothing here generates,
     * encrypts or stores one. What is stored is a verifier: a value only the
     * right passphrase produces, which opens nothing. The passphrase itself is
     * used for this one derivation and never written down.
     *
     * Repairable rather than all-or-nothing. Each piece is filled in only if
     * missing, so an account that has one and not the other is completed by
     * visiting this route rather than being stuck between two states.
     */
    const salt = fresh.payment_key_salt ?? randomBytes(32).toString('hex')
    /*
     * Always the current count for a new setup.
     *
     * This read `fresh.kdf_iterations || PBKDF2_ITERATIONS`, and the column
     * carries DEFAULT 200000, so the value was never falsy and the 600,000
     * fallback could not fire. Every account was silently set up at a third of
     * the intended work factor, against a verifier that gates spending.
     *
     * An existing salt means an existing verifier derived at whatever count is
     * recorded, so that case keeps its own number rather than being invalidated.
     */
    const iterations = fresh.payment_key_salt ? fresh.kdf_iterations : PBKDF2_ITERATIONS
    const verifier = derivePassphraseVerifier(parsed.data.passphrase, salt, iterations)

    const chains = walletChainsFor(fresh)
    for (const env of [...new Set(chains.map(circleEnvFor))]) {
      const already = env === 'mainnet' ? fresh.circle_wallet_id : fresh.circle_wallet_id_testnet
      if (already || !circleEnabled(env)) continue

      const wallet = await provisionWallet(env, chains)
      const cols =
        env === 'mainnet'
          ? 'circle_wallet_id = ?, circle_wallet_address = ?'
          : 'circle_wallet_id_testnet = ?, circle_wallet_address_testnet = ?'
      db.prepare(`UPDATE users SET ${cols} WHERE id = ?`).run(
        wallet.walletId,
        wallet.address,
        user.id,
      )
    }

    db.prepare(
      `UPDATE users SET payment_key_salt = ?, kdf_iterations = ?, passphrase_verifier = ?
       WHERE id = ?`,
    ).run(salt, iterations, verifier, user.id)

    const updated = findUserById(user.id)!
    /*
     * Refuse rather than hand back a token for an account that cannot pay. A
     * testnet wallet is the minimum: without it the free tier cannot meter and
     * every run would fail at the first step with nothing explaining why.
     */
    if (!updated.circle_wallet_id_testnet && !updated.circle_wallet_id) {
      throw httpError(
        503,
        'Could not create an agent wallet. Circle wallet credentials are not configured ' +
          'for this environment, so nothing was set up. Nothing was charged.',
      )
    }

    res.json({ token: signFullToken(user.id), user: publicUser(updated) })
  }),
)

router.get('/key-material', requireAuth, (req, res) => {
  const user = currentUser(req)
  const row = findUserById(user.id)
  /*
   * Accounts hold no ciphertext, only a salt and an iteration count so the
   * browser can derive the passphrase verifier. Both are parameters rather than
   * secrets: a salt is public by design, and nothing remains for either to
   * decrypt.
   *
   * This used to 404 whenever the ciphertext was absent, which now describes
   * every account and would lock everyone out of their own unlock prompt.
   */
  if (!row?.payment_key_salt) {
    res.status(404).json({ error: 'No agent wallet has been set up for this account' })
    return
  }
  // Ciphertext only — the server cannot and does not derive the raw key here.
  res.json({
    // Included so the browser can build the rotation message without a second
    // round trip; it is the caller's own id, never anybody else's.
    userId: row.id,
    /** Null for every current account: signing is Circle's, so no key is held. */
    encryptedKey: row.encrypted_payment_key,
    salt: row.payment_key_salt,
    iv: row.payment_key_iv,
    eoaAddress: row.eoa_address,
    /** Whether the passphrase can be checked without the ciphertext. */
    hasVerifier: Boolean(row.passphrase_verifier),
    // The browser must derive with the same count this was encrypted at, not
    // with whatever the current default happens to be.
    iterations: row.kdf_iterations || PBKDF2_ITERATIONS_LEGACY,
    // What it should be re-encrypted at, if it is behind.
    targetIterations: PBKDF2_ITERATIONS,
  })
})

const RotateBody = z.object({
  encryptedKey: z.string().regex(/^[0-9a-f]+$/i, 'encryptedKey must be hex'),
  salt: z.string().regex(/^[0-9a-f]+$/i, 'salt must be hex'),
  iv: z.string().regex(/^[0-9a-f]+$/i, 'iv must be hex'),
  iterations: z.number().int(),
  signature: z.string().regex(/^0x[0-9a-f]+$/i, 'signature must be hex'),
})

/**
 * Store a re-encrypted copy of the wallet key at a higher iteration count.
 *
 * The server never sees the passphrase or the key — the browser decrypts with
 * the old count, re-encrypts with the new one, and sends only ciphertext. What
 * makes that safe to accept is the signature: it must recover to the EOA this
 * account already owns, which nobody can produce without the real key.
 */
router.post(
  '/rotate-kdf',
  requireAuth,
  asyncRoute(async (req, res) => {
    const user = currentUser(req)
    const parsed = RotateBody.safeParse(req.body)
    if (!parsed.success) {
      throw httpError(400, parsed.error.issues[0]?.message ?? 'Invalid request body')
    }
    const { encryptedKey, salt, iv, iterations, signature } = parsed.data

    const row = findUserById(user.id)
    if (!row?.eoa_address) throw httpError(404, 'No agent wallet for this account')

    // Never accept a downgrade: a weaker count is either a bug or an attempt to
    // make the stored key cheaper to crack.
    if (iterations < (row.kdf_iterations || PBKDF2_ITERATIONS_LEGACY)) {
      throw httpError(400, 'Refusing to lower the iteration count')
    }
    if (iterations > PBKDF2_ITERATIONS) {
      throw httpError(400, 'Iteration count is higher than this server supports')
    }

    // verifyMessage throws on a structurally invalid signature rather than
    // returning false, and a malformed body is the caller's mistake, not a
    // server fault — treat any failure here as "not verified".
    let valid = false
    try {
      valid = await verifyMessage({
        address: row.eoa_address as `0x${string}`,
        message: buildRotationMessage({ userId: user.id, encryptedKey, iterations }),
        signature: signature as `0x${string}`,
      })
    } catch {
      valid = false
    }
    if (!valid) throw httpError(403, 'Signature does not match this account\u2019s agent wallet')

    db.prepare(
      `UPDATE users
       SET encrypted_payment_key = ?, payment_key_salt = ?, payment_key_iv = ?, kdf_iterations = ?
       WHERE id = ?`,
    ).run(encryptedKey, salt, iv, iterations, user.id)

    res.json({ ok: true, iterations })
  }),
)

/* --------------------------------------------------- passphrase verifier */

const VerifierBody = z.object({
  verifier: z.string().regex(/^[0-9a-f]{64}$/, 'verifier must be 64 lowercase hex chars'),
  signature: z.string().min(1),
})

/**
 * Install the value that will stand in for the passphrase once the wallet key
 * is gone.
 *
 * Gated on a signature from the old EOA, exactly as re-encryption is, because
 * whoever can set this can later pass the gate it guards. A session token is
 * not enough on its own: it proves who is asking, not that they know the
 * passphrase.
 */
router.post(
  '/passphrase-verifier',
  requireAuth,
  asyncRoute(async (req, res) => {
    const user = currentUser(req)
    const parsed = VerifierBody.safeParse(req.body)
    if (!parsed.success) {
      throw httpError(400, parsed.error.issues[0]?.message ?? 'Invalid request body')
    }
    const { verifier, signature } = parsed.data

    const row = findUserById(user.id)
    if (!row?.eoa_address) throw httpError(404, 'No agent wallet for this account')

    let valid = false
    try {
      valid = await verifyMessage({
        address: row.eoa_address as `0x${string}`,
        message: buildVerifierMessage({ userId: user.id, verifier }),
        signature: signature as `0x${string}`,
      })
    } catch {
      valid = false
    }
    if (!valid) throw httpError(403, 'Signature does not match this account\u2019s agent wallet')

    db.prepare('UPDATE users SET passphrase_verifier = ? WHERE id = ?').run(verifier, user.id)
    res.json({ ok: true })
  }),
)

/**
 * Check a passphrase when there is no longer a key to try it against.
 *
 * Compared in constant time. A plain === on a secret leaks it a byte at a time
 * to anyone who can measure the response, and this one is short enough to walk.
 */
router.post(
  '/passphrase-verify',
  requireAuth,
  asyncRoute(async (req, res) => {
    const user = currentUser(req)
    const parsed = z
      .object({ verifier: z.string().regex(/^[0-9a-f]{64}$/) })
      .safeParse(req.body)
    if (!parsed.success) throw httpError(400, 'Invalid request body')

    const row = findUserById(user.id)
    const stored = row?.passphrase_verifier
    if (!stored) throw httpError(409, 'This account has no passphrase verifier set.')

    const a = Buffer.from(stored, 'hex')
    const b = Buffer.from(parsed.data.verifier, 'hex')
    const ok = a.length === b.length && timingSafeEqual(a, b)
    if (!ok) throw httpError(403, 'Wrong passphrase')

    res.json({ ok: true })
  }),
)

router.get('/me', requireAuth, (req, res) => {
  const row = findUserById(currentUser(req).id)
  if (!row) {
    res.status(401).json({ error: 'User no longer exists' })
    return
  }
  res.json({ user: publicUser(row) })
})

router.get('/providers', (_req, res) => {
  res.json({ google: GOOGLE_ENABLED, siwe: true })
})

export function publicUser(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    walletAddress: row.wallet_address,
    eoaAddress: row.eoa_address,
    spendingCapUsdc: row.spending_cap_usdc,
    defaultChain: row.default_chain,
    mainnetEnabled: row.mainnet_enabled === 1,
    mainnetChain: row.mainnet_chain,
  }
}

export default router
