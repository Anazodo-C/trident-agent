import { SiweMessage, generateNonce } from 'siwe'

const NONCE_TTL_MS = 10 * 60 * 1000

/**
 * In-memory single-use nonce store. Sufficient for a single backend instance;
 * swap for Redis if the backend is ever scaled horizontally.
 */
const nonces = new Map<string, number>()

function sweep(): void {
  const cutoff = Date.now() - NONCE_TTL_MS
  for (const [nonce, issuedAt] of nonces) {
    if (issuedAt < cutoff) nonces.delete(nonce)
  }
}

export function issueNonce(): string {
  sweep()
  const nonce = generateNonce()
  nonces.set(nonce, Date.now())
  return nonce
}

function consumeNonce(nonce: string): boolean {
  sweep()
  if (!nonces.has(nonce)) return false
  nonces.delete(nonce)
  return true
}

export interface SiweVerification {
  address: string
}

export async function verifySiwe(message: string, signature: string): Promise<SiweVerification> {
  let parsed: SiweMessage
  try {
    parsed = new SiweMessage(message)
  } catch {
    throw Object.assign(new Error('Malformed SIWE message'), { status: 400 })
  }

  if (!consumeNonce(parsed.nonce)) {
    throw Object.assign(new Error('Unknown, expired, or already-used nonce'), { status: 401 })
  }

  const result = await parsed.verify({ signature, nonce: parsed.nonce }, { suppressExceptions: true })
  if (!result.success) {
    throw Object.assign(new Error(result.error?.type ?? 'SIWE signature verification failed'), {
      status: 401,
    })
  }

  return { address: result.data.address }
}
