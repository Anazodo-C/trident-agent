import { BrowserRouter } from 'react-router-dom'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit'
import App from './App.tsx'
import { wagmiConfig } from './lib/wagmi.ts'

/**
 * The app's provider tree, in its own module so main.tsx can import it
 * dynamically.
 *
 * The import itself is the reason. `wagmiConfig` builds a RainbowKit config at
 * module scope, which initialises WalletConnect the moment the module is
 * evaluated, before any component renders. Keeping these imports out of
 * main.tsx is what actually stops a public status page from calling
 * pulse.walletconnect.org; rendering the providers conditionally does not,
 * because by then the damage is done.
 */
const queryClient = new QueryClient()

export default function AppRoot() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={darkTheme({
            accentColor: '#00D4FF',
            accentColorForeground: '#0A0E1A',
            borderRadius: 'medium',
            overlayBlur: 'small',
          })}
        >
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
