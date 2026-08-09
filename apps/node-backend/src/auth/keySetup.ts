import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv } from 'node:crypto'

/**
 * Must stay byte-identical to the browser side (`lib/crypto.ts`), otherwise
 * decryption always fails. See ASSUMPTIONS #12 in the build prompt.
 */
/**
 * What new wallets are encrypted with today. OWASP's current floor for
 * PBKDF2-HMAC-SHA256.
 */
export const PBKDF2_ITERATIONS = 600_000

/**
 * What wallets created before that change used. Rows carry their own count in
 * users.kdf_iterations, so this is only the default for rows that predate the
 * column — never a value to encrypt anything new with.
 */
export const PBKDF2_ITERATIONS_LEGACY = 200_000

export const PBKDF2_DIGEST = 'sha256'
const GCM_TAG_BYTES = 16

export interface EncryptedEoa {
  eoaAddress: string
  encryptedKey: string
  salt: string
  iv: string
  iterations: number
}

export function generateAndEncryptEoa(
  passphrase: string,
  iterations: number = PBKDF2_ITERATIONS,
): EncryptedEoa {
  const privateKey = generatePrivateKey()
  const account = privateKeyToAccount(privateKey)

  const salt = randomBytes(32)
  const iv = randomBytes(12)
  const derived = pbkdf2Sync(passphrase, salt, iterations, 32, PBKDF2_DIGEST)

  const cipher = createCipheriv('aes-256-gcm', derived, iv)
  const encrypted = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return {
    eoaAddress: account.address,
    encryptedKey: Buffer.concat([encrypted, tag]).toString('hex'),
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    iterations,
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
  iterations: number = PBKDF2_ITERATIONS,
): string {
  const payload = Buffer.from(encryptedHex, 'hex')
  const salt = Buffer.from(saltHex, 'hex')
  const iv = Buffer.from(ivHex, 'hex')

  const ciphertext = payload.subarray(0, payload.length - GCM_TAG_BYTES)
  const tag = payload.subarray(payload.length - GCM_TAG_BYTES)

  const derived = pbkdf2Sync(passphrase, salt, iterations, 32, PBKDF2_DIGEST)
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

/**
 * The message a client signs to prove it really decrypted the wallet key
 * before asking the server to store a re-encrypted copy.
 *
 * Without this, any holder of a valid JWT could overwrite someone's encrypted
 * key with a blob of their own. They could not steal the funds — the EOA that
 * holds them is unchanged and they still would not know its key — but they
 * could lock the owner out of their own wallet permanently, which is bad
 * enough. A signature that recovers to the stored EOA proves possession of the
 * real key, and binding the ciphertext into the message stops the signature
 * being reused to install a different blob.
 *
 * MUST stay byte-identical to `buildRotationMessage` in the browser's
 * `lib/crypto.ts`, or every rotation fails signature verification.
 */
export function buildRotationMessage(input: {
  userId: string
  encryptedKey: string
  iterations: number
}): string {
  return [
    'Trident agent wallet re-encryption',
    `user: ${input.userId}`,
    `key: ${input.encryptedKey}`,
    `iterations: ${input.iterations}`,
  ].join('\n')
}
