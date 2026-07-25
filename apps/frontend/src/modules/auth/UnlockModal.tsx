import { useEffect, useState } from 'react'
import { privateKeyToAccount } from 'viem/accounts'
import { KeyRound, Loader2, X } from 'lucide-react'
import { api } from '../../lib/api.ts'
import { decryptEoaKey } from '../../lib/crypto.ts'
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
      const key = await decryptEoaKey(
        passphrase,
        material.encryptedKey,
        material.salt,
        material.iv,
      )

      // Confirm the decrypted key really controls the account's agent wallet.
      const derived = privateKeyToAccount(key as `0x${string}`).address
      const expected = material.eoaAddress ?? user?.eoaAddress
      if (expected && derived.toLowerCase() !== expected.toLowerCase()) {
        throw new Error('Wrong passphrase')
      }

      unlock(key)
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
          Your passphrase decrypts the agent wallet key in this browser. The key stays in
          memory only and is cleared when you refresh the page.
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
            {busy ? 'Decrypting' : 'Unlock'}
          </button>
        </form>
      </div>
    </div>
  )
}
