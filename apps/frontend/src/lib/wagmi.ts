import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import {
  arcTestnet,
  arbitrumSepolia,
  avalancheFuji,
  baseSepolia,
  optimismSepolia,
  polygonAmoy,
  sepolia,
} from 'viem/chains'

/**
 * WalletConnect needs a project id for QR / mobile wallets. Without one the
 * config still works for injected wallets (MetaMask, Rabby, Coinbase extension),
 * which covers the only place Trident uses a Web3 wallet: funding the agent EOA.
 */
const projectId = import.meta.env['VITE_WALLETCONNECT_PROJECT_ID'] ?? 'trident-local-dev'

export const WALLETCONNECT_CONFIGURED = Boolean(
  import.meta.env['VITE_WALLETCONNECT_PROJECT_ID'],
)

export const wagmiConfig = getDefaultConfig({
  appName: 'Trident',
  projectId,
  chains: [
    arcTestnet,
    baseSepolia,
    sepolia,
    arbitrumSepolia,
    optimismSepolia,
    avalancheFuji,
    polygonAmoy,
  ],
  ssr: false,
})
