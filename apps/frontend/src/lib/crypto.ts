/**
 * Browser half of the agent-wallet key encryption.
 *
 * These constants MUST stay identical to `apps/node-backend/src/auth/keySetup.ts`
 * (PBKDF2-SHA256, 200_000 iterations, AES-256-GCM with a 16-byte tag appended to
 * the ciphertext). Any drift makes every decryption fail.
 */
const PBKDF2_ITERATIONS = 200_000
const PBKDF2_HASH = 'SHA-256'

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (clean.length % 2 !== 0) throw new Error('Invalid hex string')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < clean.length; i += 2) {
    out[i / 2] = Number.parseInt(clean.slice(i, i + 2), 16)
  }
  return out
}

async function deriveAesKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: PBKDF2_HASH,
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  )
}

/**
 * Decrypt the agent wallet private key. Throws on a wrong passphrase — AES-GCM
 * authentication fails rather than returning garbage.
 */
export async function decryptEoaKey(
  passphrase: string,
  encryptedHex: string,
  saltHex: string,
  ivHex: string,
): Promise<string> {
  const salt = hexToBytes(saltHex)
  const iv = hexToBytes(ivHex)
  const payload = hexToBytes(encryptedHex)

  const aesKey = await deriveAesKey(passphrase, salt)

  let plain: ArrayBuffer
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      aesKey,
      payload as BufferSource,
    )
  } catch {
    throw new Error('Wrong passphrase')
  }

  const key = new TextDecoder().decode(plain)
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('Decrypted value is not a valid private key')
  }
  return key
}
