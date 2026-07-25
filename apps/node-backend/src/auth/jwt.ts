import jwt from 'jsonwebtoken'
import type { NextFunction, Request, Response } from 'express'
import db, { type UserRow } from '../db.ts'
import { JWT_SECRET } from '../env.ts'

export interface AuthedUser {
  id: string
  email: string | null
  walletAddress: string | null
  eoaAddress: string | null
  spendingCap: number
  defaultChain: string
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser
    }
  }
}

type TokenScope = 'full' | 'setup'

interface TridentClaims {
  sub: string
  scope: TokenScope
}

export function signFullToken(userId: string): string {
  return jwt.sign({ scope: 'full' } satisfies Omit<TridentClaims, 'sub'>, JWT_SECRET, {
    subject: userId,
    expiresIn: '7d',
  })
}

/** Short-lived token that authorises only POST /auth/setup-passphrase. */
export function signSetupToken(userId: string): string {
  return jwt.sign({ scope: 'setup' } satisfies Omit<TridentClaims, 'sub'>, JWT_SECRET, {
    subject: userId,
    expiresIn: '15m',
  })
}

export function verifyToken(token: string): TridentClaims {
  const decoded = jwt.verify(token, JWT_SECRET)
  if (typeof decoded === 'string' || !decoded.sub) throw new Error('Malformed token')
  const scope = (decoded as jwt.JwtPayload)['scope']
  if (scope !== 'full' && scope !== 'setup') throw new Error('Malformed token scope')
  return { sub: decoded.sub, scope }
}

function bearer(req: Request): string | null {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  return header.slice(7).trim() || null
}

function loadUser(userId: string): AuthedUser | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined
  if (!row) return null
  return {
    id: row.id,
    email: row.email,
    walletAddress: row.wallet_address,
    eoaAddress: row.eoa_address,
    spendingCap: row.spending_cap_usdc,
    defaultChain: row.default_chain,
  }
}

function authenticate(scope: TokenScope) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = bearer(req)
    if (!token) {
      res.status(401).json({ error: 'Missing bearer token' })
      return
    }
    let claims: TridentClaims
    try {
      claims = verifyToken(token)
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' })
      return
    }
    if (claims.scope !== scope) {
      res.status(403).json({ error: `Token scope '${claims.scope}' cannot access this endpoint` })
      return
    }
    const user = loadUser(claims.sub)
    if (!user) {
      res.status(401).json({ error: 'User no longer exists' })
      return
    }
    req.user = user
    next()
  }
}

/** Full JWT required. */
export const requireAuth = authenticate('full')

/** One-time setup token required (passphrase creation only). */
export const requireSetupAuth = authenticate('setup')

/** Narrowing helper so route bodies get a non-optional user without `!`. */
export function currentUser(req: Request): AuthedUser {
  if (!req.user) throw new Error('currentUser() called on an unauthenticated request')
  return req.user
}
