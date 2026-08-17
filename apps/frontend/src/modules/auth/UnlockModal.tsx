import { useEffect, useState } from 'react'
import { privateKeyToAccount } from 'viem/accounts'
import { KeyRound, Loader2, X } from 'lucide-react'
import { api } from '../../lib/api.ts'
import {
  buildRotationMessage,
  buildVerifierMessage,
  decryptEoaKey,
  derivePassphraseVerifier,
  encryptEoaKey,
} from '../../lib/crypto.ts'
import type { KeyMaterial } from '../../lib/types.ts'
import { useAgentStore } from '../../store/agentStore.ts'
import { useAuthStore } from '../../store/authStore.ts'

export function UnlockModal() {
  const open = useAgentStore((s) => s.unlockModalOpen)
  const unlock = useAgentStore((s) => s.unlock)
  const close = useAgentStore((s) => s.closeUnlockModal)
  const user = useAuthStore((s) => s.user)

  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setPassphrase('')
      setError(null)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  if (!open) return null

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!passphrase || busy) return
    setBusy(true)
    setError(null)
    try {
      const material = await api.keyMaterial()

      /*
       * Two ways to establish the same thing, depending on whether this wallet
       * still has a key to decrypt.
       *
       * Before migration, decrypting the ciphertext is itself the proof: AES-GCM
       * authenticates, so a wrong passphrase fails rather than yielding garbage.
       * Afterwards there is no ciphertext, and the passphrase is checked against
       * a verifier derived under a separate domain.
       */
      if (!material.encryptedKey || !material.iv) {
        if (!material.hasVerifier) {
          throw new Error(
            'This account has no passphrase set up yet, so there is nothing to check against. ' +
              'Sign out and back in to finish setting one up.',
          )
        }
        const verifier = await derivePassphraseVerifier(
          passphrase,
          material.salt,
          material.iterations,
        )
        // A 403 from here is a wrong passphrase; anything else is a real fault.
        await api.verifyPassphrase(verifier).catch(() => {
          throw new Error('Wrong passphrase')
        })
        unlock()
        return
      }

      const key = await decryptEoaKey(
        passphrase,
        material.encryptedKey,
        material.salt,
        material.iv,
        material.iterations,
      )

      // Confirm the decrypted key really controls the account's agent wallet.
      const account = privateKeyToAccount(key as `0x${string}`)
      const expected = material.eoaAddress ?? user?.eoaAddress
      if (expected && account.address.toLowerCase() !== expected.toLowerCase()) {
        throw new Error('Wrong passphrase')
      }

      /*
       * Unlock, and do not keep the key.
       *
       * It used to be handed to the store for the migration sweep to use. That
       * flow is gone, nothing reads it any more, and a decrypted private key
       * sitting in application state with no consumer can only ever be a
       * liability. It stays a local here, used to sign the two housekeeping
       * calls below and then dropped with the scope.
       *
       * Both of those are housekeeping and must never be the reason someone
       * cannot get into their own wallet, so neither is awaited.
       */
      unlock()
      void upgradeKdf(material, passphrase, key, account)
      void ensureVerifier(material, passphrase, account)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not unlock'
      setError(message === 'Wrong passphrase' ? 'Wrong passphrase' : message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#0A0E1A]/85 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="unlock-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="panel w-full max-w-sm p-6">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <KeyRound className="h-4 w-4 text-[#00D4FF]" />
            <h2 id="unlock-title" className="font-mono text-sm uppercase tracking-widest">
              Unlock Agent Wallet
            </h2>
          </div>
          <button
            onClick={close}
            className="text-slate-500 transition-colors hover:text-slate-300"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mb-5 text-xs leading-relaxed text-slate-400">
          Your passphrase confirms it is you before the agent spends anything. It is checked in
          this browser and is never sent to us.
        </p>

        <form onSubmit={submit} className="flex flex-col gap-4">
          <input
            type="password"
            className="field"
            autoFocus
            autoComplete="current-password"
            placeholder="Passphrase"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />

          {error && (
            <div className="rounded-lg border border-[#FF4466]/40 bg-[#FF4466]/10 p-2.5 text-sm text-[#FF4466]">
              {error}
            </div>
          )}

          <button type="submit" className="btn-primary w-full" disabled={!passphrase || busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {busy ? 'Checking' : 'Unlock'}
          </button>
        </form>
      </div>
    </div>
  )
}

/**
 * Re-encrypt this wallet at the current iteration count, if it is behind.
 *
 * Runs after a successful unlock, when the passphrase is known-correct and the
 * decrypted key is in hand, the only moment this is possible, since the server
 * can never do it itself. Silent on failure by design: the user has already
 * been let in, the old ciphertext still works, and the next unlock will try
 * again. Failing loudly here would turn a background improvement into an alarm
 * about a wallet that is fine.
 */
async function upgradeKdf(
  material: KeyMaterial,
  passphrase: string,
  privateKey: string,
  account: ReturnType<typeof privateKeyToAccount>,
): Promise<void> {
  if (!material.targetIterations || material.iterations >= material.targetIterations) return

  try {
    const sealed = await encryptEoaKey(passphrase, privateKey, material.targetIterations)

    // Proves to the server that whoever is asking really holds this wallet's
    // key, and binds the approval to this exact ciphertext.
    const signature = await account.signMessage({
      message: buildRotationMessage({
        userId: material.userId,
        encryptedKey: sealed.encryptedKey,
        iterations: sealed.iterations,
      }),
    })

    await api.rotateKdf({ ...sealed, signature })
  } catch {
    /* keep the old ciphertext; retried on the next unlock */
  }
}

/**
 * Install a passphrase verifier while the key is still available to sign with.
 *
 * Migration deletes the ciphertext, and after that a passphrase has nothing to
 * be checked against unless this ran first. So it runs on every unlock of an
 * unmigrated wallet, not only during migration: a user who never migrates loses
 * nothing, and one who does is already prepared.
 *
 * Silent on failure, like the KDF upgrade above. The user is already inside
 * their wallet, and the next unlock tries again.
 */
async function ensureVerifier(
  material: KeyMaterial,
  passphrase: string,
  account: ReturnType<typeof privateKeyToAccount>,
): Promise<void> {
  if (material.hasVerifier) return

  try {
    const verifier = await derivePassphraseVerifier(
      passphrase,
      material.salt,
      material.iterations,
    )
    const signature = await account.signMessage({
      message: buildVerifierMessage({ userId: material.userId, verifier }),
    })
    await api.setPassphraseVerifier({ verifier, signature })
  } catch {
    /* retried on the next unlock */
  }
}
