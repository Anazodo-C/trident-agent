import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AlertTriangle, Loader2, ShieldCheck } from 'lucide-react'
import { api } from '../../lib/api.ts'
import { useAuthStore } from '../../store/authStore.ts'
import { TridentMark } from '../layout/TridentMark.tsx'
import {
  MIN_PASSPHRASE_LENGTH,
  estimateStrength,
  passphraseProblem,
  type StrengthLevel,
} from '../../lib/passphrase.ts'

export function SetupPassphrasePage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const setupToken = params.get('token')
  const setSession = useAuthStore((s) => s.setSession)

  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Same rule the server applies, so the form never submits something that
  // will come straight back as a 400.
  const problem = passphrase.length > 0 ? passphraseProblem(passphrase) : null
  const strength = estimateStrength(passphrase)
  const mismatch = confirm.length > 0 && passphrase !== confirm
  const canSubmit = !problem && passphrase.length > 0 && passphrase === confirm && acknowledged && !busy

  if (!setupToken) {
    return (
      <CenteredCard>
        <p className="text-sm text-[#FF4466]">
          Missing setup token. Start again from the sign-in page.
        </p>
        <button className="btn-ghost mt-5 w-full" onClick={() => navigate('/signin')}>
          Back to sign in
        </button>
      </CenteredCard>
    )
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit || !setupToken) return
    setBusy(true)
    setError(null)
    try {
      const { token, user } = await api.setupPassphrase(passphrase, setupToken)
      setSession(token, user)
      navigate('/app')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create your agent wallet')
    } finally {
      setBusy(false)
    }
  }

  return (
    <CenteredCard>
      <div className="mb-8 text-center">
        <TridentMark className="mx-auto mb-3 h-16 w-16" />
        <h1 className="font-mono text-lg uppercase tracking-widest text-slate-100">
          Create Agent Wallet
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          Your passphrase encrypts the private key for your agent wallet.
        </p>
      </div>

      <div className="mb-6 flex items-start gap-3 rounded-lg border border-[#FFA040]/40 bg-[#FFA040]/10 p-4">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#FFA040]" />
        <p className="text-xs leading-relaxed text-[#FFA040]">
          <strong className="font-semibold">
            If you forget your passphrase, your agent wallet cannot be recovered.
          </strong>{' '}
          Trident never stores it and cannot reset it. Any USDC held by the wallet would be
          permanently inaccessible. Write it down somewhere safe.
        </p>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="heading-mono">Passphrase</span>
          <input
            type="password"
            className="field"
            autoComplete="new-password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder={`At least ${MIN_PASSPHRASE_LENGTH} characters`}
          />
          {passphrase.length > 0 && <StrengthMeter strength={strength} />}
          {problem && <span className="text-xs text-[#FF4466]">{problem}</span>}
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="heading-mono">Confirm passphrase</span>
          <input
            type="password"
            className="field"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Re-enter it"
          />
          {mismatch && <span className="text-xs text-[#FF4466]">Passphrases do not match.</span>}
        </label>

        <label className="mt-1 flex cursor-pointer items-start gap-2.5 text-xs text-slate-400">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 accent-[#00D4FF]"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>I understand this passphrase cannot be recovered or reset.</span>
        </label>

        {error && (
          <div className="rounded-lg border border-[#FF4466]/40 bg-[#FF4466]/10 p-3 text-sm text-[#FF4466]">
            {error}
          </div>
        )}

        <button type="submit" className="btn-primary mt-2 w-full" disabled={!canSubmit}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          {busy ? 'Generating' : 'Create wallet'}
        </button>
      </form>
    </CenteredCard>
  )
}

const METER: Record<StrengthLevel, { bars: number; tone: string; label: string }> = {
  weak: { bars: 1, tone: 'bg-[#FF4466]', label: 'Weak' },
  fair: { bars: 2, tone: 'bg-[#FFA040]', label: 'Fair' },
  good: { bars: 3, tone: 'bg-[#00D4FF]', label: 'Good' },
  strong: { bars: 4, tone: 'bg-[#00FF88]', label: 'Strong' },
}

/**
 * Advisory only — the length and denylist rules decide what is accepted, and
 * they are enforced on the server. This exists to move people off short clever
 * strings and onto long ordinary ones, which is the change that actually
 * matters against offline guessing.
 */
function StrengthMeter({ strength }: { strength: ReturnType<typeof estimateStrength> }) {
  const meter = METER[strength.level]

  return (
    <div className="mt-1">
      <div className="flex items-center gap-2">
        <div className="flex flex-1 gap-1" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className={`h-1 flex-1 rounded-full transition-colors ${
                i < meter.bars ? meter.tone : 'bg-[#1A2A4A]'
              }`}
            />
          ))}
        </div>
        <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
          {meter.label}
        </span>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
        {strength.hint}{' '}
        <span className="text-slate-600">≈{strength.bits} bits estimated</span>
      </p>
    </div>
  )
}

function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="panel w-full max-w-md p-6 sm:p-8">{children}</div>
    </div>
  )
}
