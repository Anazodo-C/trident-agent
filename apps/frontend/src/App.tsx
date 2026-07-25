import { useEffect } from 'react'
import { Navigate, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { api, setAuthToken } from './lib/api.ts'
import { useAuthStore } from './store/authStore.ts'
import { AuthPage } from './modules/auth/AuthPage.tsx'
import { SetupPassphrasePage } from './modules/auth/SetupPassphrasePage.tsx'
import { AppShell } from './modules/layout/AppShell.tsx'
import { AgentTab } from './modules/agent/AgentTab.tsx'
import { EndpointsPage } from './modules/endpoints/EndpointsPage.tsx'
import { HistoryPage } from './modules/history/HistoryPage.tsx'
import { WalletPage } from './modules/wallet/WalletPage.tsx'
import { ErrorBoundary } from './modules/layout/ErrorBoundary.tsx'

export default function App() {
  const hydrate = useAuthStore((s) => s.hydrate)
  const loading = useAuthStore((s) => s.loading)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  if (loading) return <FullscreenSpinner label="Initialising" />

  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/" element={<AuthPage />} />
        <Route path="/setup-passphrase" element={<SetupPassphrasePage />} />
        <Route
          path="/app"
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route index element={<AgentTab />} />
          <Route path="endpoints" element={<EndpointsPage />} />
          <Route path="history" element={<HistoryPage />} />
          <Route path="wallet" element={<WalletPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ErrorBoundary>
  )
}

/**
 * The OAuth callback lands on /app?token=<jwt>. Consume the token, then strip it
 * from the address bar so it doesn't linger in history or get shared.
 */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const token = useAuthStore((s) => s.token)
  const setSession = useAuthStore((s) => s.setSession)
  const urlToken = params.get('token')

  useEffect(() => {
    if (!urlToken) return
    let cancelled = false
    setAuthToken(urlToken)
    api
      .me(urlToken)
      .then(({ user }) => {
        if (cancelled) return
        setSession(urlToken, user)
        navigate('/app', { replace: true })
      })
      .catch(() => {
        if (!cancelled) navigate('/?authError=invalid_token', { replace: true })
      })
    return () => {
      cancelled = true
    }
  }, [urlToken, setSession, navigate])

  if (urlToken) return <FullscreenSpinner label="Signing in" />
  if (!token) return <Navigate to="/" replace />
  return <>{children}</>
}

function FullscreenSpinner({ label }: { label: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3">
      <Loader2 className="h-6 w-6 animate-spin text-[#00D4FF]" />
      <span className="font-mono text-xs uppercase tracking-widest text-slate-500">{label}</span>
    </div>
  )
}
