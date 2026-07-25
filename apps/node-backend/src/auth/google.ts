import { google } from 'googleapis'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
  GOOGLE_ENABLED,
  JWT_SECRET,
} from '../env.ts'

export { GOOGLE_ENABLED }

export function oauthClient() {
  if (!GOOGLE_ENABLED) throw new Error('Google OAuth is not configured on this server')
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI)
}

/**
 * Stateless CSRF state: `<random>.<hmac>`. Avoids server-side session storage
 * while still making a forged callback unusable.
 */
export function createState(): string {
  const nonce = randomBytes(16).toString('hex')
  const mac = createHmac('sha256', JWT_SECRET).update(nonce).digest('hex')
  return `${nonce}.${mac}`
}

export function verifyState(state: unknown): boolean {
  if (typeof state !== 'string') return false
  const [nonce, mac] = state.split('.')
  if (!nonce || !mac) return false
  const expected = createHmac('sha256', JWT_SECRET).update(nonce).digest('hex')
  const a = Buffer.from(mac, 'hex')
  const b = Buffer.from(expected, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

export function consentUrl(state: string): string {
  return oauthClient().generateAuthUrl({
    access_type: 'online',
    prompt: 'select_account',
    scope: ['openid', 'email', 'profile'],
    state,
  })
}

export interface GoogleProfile {
  googleId: string
  email: string | null
}

export async function exchangeCodeForProfile(code: string): Promise<GoogleProfile> {
  const client = oauthClient()
  const { tokens } = await client.getToken(code)
  if (!tokens.id_token) throw new Error('Google did not return an id_token')

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: GOOGLE_CLIENT_ID,
  })
  const payload = ticket.getPayload()
  if (!payload?.sub) throw new Error('Google id_token has no subject')

  return { googleId: payload.sub, email: payload.email ?? null }
}
