import { Router } from 'express'
import { z } from 'zod'
import db from '../db.ts'
import { FRONTEND_URL } from '../env.ts'
import { asyncRoute, httpError } from '../http.ts'
import { generateAndEncryptEoa } from '../auth/keySetup.ts'
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
  passphrase: z.string().min(8, 'Passphrase must be at least 8 characters'),
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
    // Re-running setup would orphan any funds already held by the existing EOA.
    if (!needsPassphraseSetup(fresh)) {
      throw httpError(409, 'Agent wallet already exists for this account')
    }

    const eoa = generateAndEncryptEoa(parsed.data.passphrase)
    db.prepare(
      `UPDATE users
       SET eoa_address = ?, encrypted_payment_key = ?, payment_key_salt = ?, payment_key_iv = ?
       WHERE id = ?`,
    ).run(eoa.eoaAddress, eoa.encryptedKey, eoa.salt, eoa.iv, user.id)

    const updated = findUserById(user.id)!
    res.json({ token: signFullToken(user.id), user: publicUser(updated) })
  }),
)

router.get('/key-material', requireAuth, (req, res) => {
  const user = currentUser(req)
  const row = findUserById(user.id)
  if (!row?.encrypted_payment_key || !row.payment_key_salt || !row.payment_key_iv) {
    res.status(404).json({ error: 'No agent wallet has been set up for this account' })
    return
  }
  // Ciphertext only — the server cannot and does not derive the raw key here.
  res.json({
    encryptedKey: row.encrypted_payment_key,
    salt: row.payment_key_salt,
    iv: row.payment_key_iv,
    eoaAddress: row.eoa_address,
  })
})

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
