import React, { Suspense, lazy } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { onStatusHost } from './lib/host.ts'
import './index.css'

/**
 * Two entry points, chosen by hostname, and neither one imports the other's
 * dependencies.
 *
 * Both are dynamic on purpose. `AppRoot` pulls in wagmi and RainbowKit, and
 * `wagmiConfig` initialises WalletConnect at module scope — so a static import
 * here would have a public status page calling pulse.walletconnect.org and
 * api.web3modal.org for every anonymous visitor, no matter which branch
 * rendered. Splitting at the import is what keeps the wallet stack off the
 * status subdomain entirely.
 *
 * `/status` on the main domain still renders inside the full app, through
 * App.tsx's own route.
 */
const AppRoot = lazy(() => import('./AppRoot.tsx'))
const StatusPage = lazy(() =>
  import('./modules/status/StatusPage.tsx').then((m) => ({ default: m.StatusPage })),
)

const root = document.getElementById('root')
if (!root) throw new Error('Root element #root not found')

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <Suspense fallback={null}>
      {onStatusHost() ? (
        <BrowserRouter>
          <StatusPage />
        </BrowserRouter>
      ) : (
        <AppRoot />
      )}
    </Suspense>
  </React.StrictMode>,
)
