import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useAccount, useSignMessage } from 'wagmi'
import { SiweMessage } from 'siwe'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { api, apiUrl } from '../../lib/api.ts'
import { useAuthStore } from '../../store/authStore.ts'
import { TridentMark } from '../layout/TridentMark.tsx'

export function AuthPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const setSession = useAuthStore((s) => s.setSession)

  const { address, isConnected } = useAccount()
  const { signMessageAsync } = useSignMessage()

  const [providers, setProviders] = useState<{ google: boolean; siwe: boolean }>({
    google: false,
    siwe: true,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(params.get('authError'))

  useEffect(() => {
    api.authProviders().then(setProviders).catch(() => undefined)
  }, [])

  async function signInWithEthereum() {
    if (!address) return
    setBusy(true)
    setError(null)
    try {
      const { nonce } = await api.siweNonce()
      const message = new SiweMessage({
        domain: window.location.host,
        address,
        statement: 'Sign in to Trident.',
        uri: window.location.origin,
        version: '1',
        chainId: 1,
        nonce,
      }).prepareMessage()

      const signature = await signMessageAsync({ message })
      const result = await api.siweVerify(message, signature)

      if (result.needsSetup) {
        navigate(`/setup-passphrase?token=${encodeURIComponent(result.setupToken)}`)
        return
      }
      setSession(result.token, result.user)
      navigate('/app')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-10 text-center">
          <TridentMark className="mx-auto mb-5 h-12 w-12 text-[#00D4FF]" />
          <h1 className="font-mono text-3xl uppercase tracking-[0.35em] text-slate-100">
            Trident
          </h1>
          <p className="mt-3 text-sm text-slate-400">
            One agent. One wallet. Autonomous execution.
          </p>
        </div>

        <div className="panel p-6">
          <h2 className="heading-mono mb-5">Access Terminal</h2>

          {error && (
            <div className="mb-5 flex items-start gap-2 rounded-lg border border-[#FF4466]/40 bg-[#FF4466]/10 p-3 text-sm text-[#FF4466]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <a
            // Full page navigation to the backend origin, not a SPA route.
            href={providers.google ? apiUrl('/auth/google') : undefined}
            aria-disabled={!providers.google}
            onClick={(e) => {
              if (!providers.google) {
                e.preventDefault()
                setError('Google sign-in is not configured on this server.')
              }
            }}
            className={`btn-ghost w-full ${providers.google ? '' : 'cursor-not-allowed opacity-40'}`}
          >
            <GoogleGlyph />
            Continue with Google
          </a>

          <div className="my-6 flex items-center gap-3">
            <div className="h-px flex-1 bg-[#1A7FFF]/20" />
            <span className="font-mono text-[10px] uppercase tracking-widest text-slate-600">
              or
            </span>
            <div className="h-px flex-1 bg-[#1A7FFF]/20" />
          </div>

          <div className="flex flex-col gap-3">
            <div className="[&_button]:!w-full [&_button]:!font-mono">
              <ConnectButton showBalance={false} chainStatus="none" />
            </div>

            {isConnected && (
              <button className="btn-primary w-full" onClick={signInWithEthereum} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {busy ? 'Verifying' : 'Sign in with Ethereum'}
              </button>
            )}
          </div>

          <p className="mt-6 text-center text-xs leading-relaxed text-slate-500">
            Trident generates a self-custody agent wallet for you. Your private key is
            encrypted with a passphrase only you know.
          </p>
        </div>
      </div>
    </div>
  )
}

function GoogleGlyph() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M21.35 11.1H12v3.2h5.35c-.23 1.4-1.7 4.1-5.35 4.1a6.4 6.4 0 1 1 0-12.8c1.83 0 3.06.78 3.76 1.45l2.56-2.47A9.6 9.6 0 1 0 12 21.6c5.55 0 9.22-3.9 9.22-9.4 0-.63-.06-1.1-.14-1.5"
      />
    </svg>
  )
}
