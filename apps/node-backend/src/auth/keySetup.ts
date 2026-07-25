import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv } from 'node:crypto'

/**
 * Must stay byte-identical to the browser side (`lib/crypto.ts`), otherwise
 * decryption always fails. See ASSUMPTIONS #12 in the build prompt.
 */
export const PBKDF2_ITERATIONS = 200_000
export const PBKDF2_DIGEST = 'sha256'
const GCM_TAG_BYTES = 16

export interface EncryptedEoa {
  eoaAddress: string
  encryptedKey: string
  salt: string
  iv: string
}

export function generateAndEncryptEoa(passphrase: string): EncryptedEoa {
  const privateKey = generatePrivateKey()
  const account = privateKeyToAccount(privateKey)

  const salt = randomBytes(32)
  const iv = randomBytes(12)
  const derived = pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, 32, PBKDF2_DIGEST)

  const cipher = createCipheriv('aes-256-gcm', derived, iv)
  const encrypted = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return {
    eoaAddress: account.address,
    encryptedKey: Buffer.concat([encrypted, tag]).toString('hex'),
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
  }
}

/**
 * Server-side counterpart of the browser decrypt. Used only by the E2E test to
 * prove the two implementations agree — the running server never decrypts user
 * keys, it only ever stores and returns ciphertext.
 */
export function decryptEoaKey(
  passphrase: string,
  encryptedHex: string,
  saltHex: string,
  ivHex: string,
): string {
  const payload = Buffer.from(encryptedHex, 'hex')
  const salt = Buffer.from(saltHex, 'hex')
  const iv = Buffer.from(ivHex, 'hex')

  const ciphertext = payload.subarray(0, payload.length - GCM_TAG_BYTES)
  const tag = payload.subarray(payload.length - GCM_TAG_BYTES)

  const derived = pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, 32, PBKDF2_DIGEST)
  const decipher = createDecipheriv('aes-256-gcm', derived, iv)
  decipher.setAuthTag(tag)

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/** Cheap structural check so routes can reject junk before handing a key to an SDK. */
export function isValidPrivateKey(key: unknown): key is `0x${string}` {
  return typeof key === 'string' && /^0x[0-9a-fA-F]{64}$/.test(key)
}

/** Derive the public address for a key, to confirm it matches the stored EOA. */
export function addressForKey(privateKey: `0x${string}`): string {
  return privateKeyToAccount(privateKey).address
}
