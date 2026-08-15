/**
 * Browser half of the agent-wallet key encryption.
 *
 * The scheme MUST stay identical to `apps/node-backend/src/auth/keySetup.ts`
 * (PBKDF2-SHA256, AES-256-GCM with a 16-byte tag appended to the ciphertext).
 * Any drift makes every decryption fail.
 *
 * The iteration count is no longer a constant here: it travels with each
 * wallet, because raising it for new wallets must not strand the ones already
 * encrypted at the old count.
 */
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

async function deriveAesKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
  usage: 'encrypt' | 'decrypt',
): Promise<CryptoKey> {
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
      iterations,
      hash: PBKDF2_HASH,
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  )
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Domain separator for the passphrase verifier.
 *
 * The verifier must share no output with the AES key, or storing it would be
 * storing something derived from the key that protects the wallet. Appending
 * this to the salt gives PBKDF2 a different input and therefore an independent
 * result, while keeping one passphrase and one iteration count.
 */
const VERIFIER_DOMAIN = 'trident-passphrase-verifier-v1'

/**
 * Prove knowledge of the passphrase without a key to decrypt.
 *
 * Once a wallet has migrated to Circle there is no ciphertext left to try the
 * passphrase against, so the unlock prompt has nothing to fail on. This gives it
 * something: a value only the right passphrase produces, stored server-side and
 * compared on each spend.
 *
 * It is a password-equivalent, not a signing key. Someone who intercepts it can
 * pass this gate but cannot move funds with it, because the backend only ever
 * signs for the wallet belonging to the authenticated session. That is a large
 * step down in sensitivity from the private key this replaces, though it is not
 * nothing: a challenge-response would remove the replay entirely and is the
 * upgrade if this gate ever needs to stand on its own.
 */
/**
 * The message signed to install a passphrase verifier.
 *
 * MUST stay byte-identical to `buildVerifierMessage` in the backend's
 * `auth/keySetup.ts`, or installing a verifier fails signature verification.
 */
export function buildVerifierMessage(input: { userId: string; verifier: string }): string {
  return [
    'Trident passphrase verifier',
    `user: ${input.userId}`,
    `verifier: ${input.verifier}`,
  ].join('\n')
}

export async function derivePassphraseVerifier(
  passphrase: string,
  saltHex: string,
  iterations: number,
): Promise<string> {
  const salt = hexToBytes(saltHex)
  const domain = new TextEncoder().encode(VERIFIER_DOMAIN)
  const verifierSalt = new Uint8Array(salt.length + domain.length)
  verifierSalt.set(salt, 0)
  verifierSalt.set(domain, salt.length)

  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: verifierSalt as BufferSource, iterations, hash: PBKDF2_HASH },
    baseKey,
    256,
  )
  return bytesToHex(new Uint8Array(bits))
}

/**
 * Decrypt the agent wallet private key. Throws on a wrong passphrase, because AES-GCM
 * authentication fails rather than returning garbage.
 */
export async function decryptEoaKey(
  passphrase: string,
  encryptedHex: string,
  saltHex: string,
  ivHex: string,
  iterations: number,
): Promise<string> {
  const salt = hexToBytes(saltHex)
  const iv = hexToBytes(ivHex)
  const payload = hexToBytes(encryptedHex)

  const aesKey = await deriveAesKey(passphrase, salt, iterations, 'decrypt')

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

/**
 * Re-encrypt an already-decrypted wallet key at a new iteration count, with a
 * fresh salt and IV.
 *
 * Only ever called with a key the browser just decrypted successfully, so the
 * passphrase is known-correct: re-encrypting under a wrong one would replace
 * the stored blob with something nobody can open.
 */
export async function encryptEoaKey(
  passphrase: string,
  privateKey: string,
  iterations: number,
): Promise<{ encryptedKey: string; salt: string; iv: string; iterations: number }> {
  const salt = crypto.getRandomValues(new Uint8Array(32))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const aesKey = await deriveAesKey(passphrase, salt, iterations, 'encrypt')

  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    aesKey,
    new TextEncoder().encode(privateKey),
  )

  // WebCrypto appends the 16-byte GCM tag to the ciphertext, which is exactly
  // the layout the Node side reads back.
  return {
    encryptedKey: bytesToHex(new Uint8Array(sealed)),
    salt: bytesToHex(salt),
    iv: bytesToHex(iv),
    iterations,
  }
}

/**
 * MUST stay byte-identical to `buildRotationMessage` in the backend's
 * `auth/keySetup.ts`, or the server rejects every rotation.
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
