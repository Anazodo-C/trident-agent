import { Suspense, lazy, useEffect } from 'react'
import { Navigate, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { api, setAuthToken } from './lib/api.ts'
import { useAuthStore } from './store/authStore.ts'
import { AuthPage } from './modules/auth/AuthPage.tsx'
import { LandingPage } from './modules/landing/LandingPage.tsx'
import { SetupPassphrasePage } from './modules/auth/SetupPassphrasePage.tsx'
import { AppShell } from './modules/layout/AppShell.tsx'
import { AgentTab } from './modules/agent/AgentTab.tsx'
import { EndpointsPage } from './modules/endpoints/EndpointsPage.tsx'
import { HistoryPage } from './modules/history/HistoryPage.tsx'
import { WalletPage } from './modules/wallet/WalletPage.tsx'
import { DashboardPage } from './modules/dashboard/DashboardPage.tsx'
import { ErrorBoundary } from './modules/layout/ErrorBoundary.tsx'

/**
 * The same page the status subdomain serves, reachable at /status on the main
 * domain too. Lazy so the app's own users never pay for a page they are not on;
 * the subdomain mounts it from main.tsx instead, above the wallet providers.
 */
const StatusPage = lazy(() =>
  import('./modules/status/StatusPage.tsx').then((m) => ({ default: m.StatusPage })),
)

/*
 * Public reading material, long prose that most visitors never open. Lazy so
 * the landing page does not carry it, and each in its own chunk so opening the
 * terms does not also download the docs.
 */
const DocsPage = lazy(() =>
  import('./modules/content/DocsPage.tsx').then((m) => ({ default: m.DocsPage })),
)
const PrivacyPage = lazy(() =>
  import('./modules/content/PrivacyPage.tsx').then((m) => ({ default: m.PrivacyPage })),
)
const TermsPage = lazy(() =>
  import('./modules/content/TermsPage.tsx').then((m) => ({ default: m.TermsPage })),
)

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
        <Route path="/" element={<LandingPage />} />
        <Route
          path="/status"
          element={
            <Suspense fallback={<FullscreenSpinner label="Loading status" />}>
              <StatusPage />
            </Suspense>
          }
        />
        <Route
          path="/docs"
          element={
            <Suspense fallback={<FullscreenSpinner label="Loading docs" />}>
              <DocsPage />
            </Suspense>
          }
        />
        <Route
          path="/privacy"
          element={
            <Suspense fallback={<FullscreenSpinner label="Loading" />}>
              <PrivacyPage />
            </Suspense>
          }
        />
        <Route
          path="/terms"
          element={
            <Suspense fallback={<FullscreenSpinner label="Loading" />}>
              <TermsPage />
            </Suspense>
          }
        />
        <Route path="/signin" element={<AuthPage />} />
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
          <Route path="dashboard" element={<DashboardPage />} />
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
        if (!cancelled) navigate('/signin?authError=invalid_token', { replace: true })
      })
    return () => {
      cancelled = true
    }
  }, [urlToken, setSession, navigate])

  if (urlToken) return <FullscreenSpinner label="Signing in" />
  if (!token) return <Navigate to="/signin" replace />
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
