import { create } from 'zustand'
import { api } from '../lib/api.ts'
import type { ChainOption, DepositInfo, WalletBalance } from '../lib/types.ts'

/**
 * Wallet state, keyed by chain.
 *
 * One address holds funds on every chain it is used on, and the agent settles
 * x402 calls on whichever chain the service wants. A single `balance` field
 * could only ever describe one of those at a time, which is how a Gateway
 * deposit could land somewhere other than where the runner spends. Balances
 * are per chain now, and the UI shows all of them at once.
 */
interface WalletState {
  /** Keyed by SDK chain name, e.g. `arcTestnet`, `base`. */
  balances: Record<string, WalletBalance>
  /** The chain deposits, withdrawals and transfers act on. */
  activeChain: string | null
  depositInfo: DepositInfo | null
  loading: boolean
  error: string | null

  setActiveChain: (chain: string) => void
  /** Load one chain. Omit to load the active one. */
  refresh: (agentPrivateKey?: string, chain?: string) => Promise<void>
  /** Load every chain this account may use, so both are visible side by side. */
  refreshAll: (agentPrivateKey?: string) => Promise<void>
  loadDepositInfo: () => Promise<void>
}

export const useWalletStore = create<WalletState>((set, get) => ({
  balances: {},
  activeChain: null,
  depositInfo: null,
  loading: false,
  error: null,

  setActiveChain: (activeChain) => set({ activeChain }),

  refresh: async (agentPrivateKey, chain) => {
    const target = chain ?? get().activeChain ?? undefined
    set({ loading: true, error: null })
    try {
      const balance = await api.balance(agentPrivateKey, target)
      set((state) => ({
        balances: { ...state.balances, [balance.chain]: balance },
        activeChain: state.activeChain ?? balance.chain,
        loading: false,
      }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to load balance', loading: false })
    }
  },

  refreshAll: async (agentPrivateKey) => {
    set({ loading: true, error: null })
    try {
      const info = get().depositInfo ?? (await api.depositInfo())
      const chains: ChainOption[] = info.availableChains?.length
        ? info.availableChains
        : [{ chain: info.chain, label: info.chain, chainId: info.chainId, isTestnet: true }]

      // One failing chain must not blank the others — a mainnet RPC hiccup
      // should not hide the testnet balance the user is actually working with.
      const results = await Promise.allSettled(
        chains.map((c) => api.balance(agentPrivateKey, c.chain)),
      )

      const balances: Record<string, WalletBalance> = {}
      const failed: string[] = []
      results.forEach((result, i) => {
        if (result.status === 'fulfilled') balances[result.value.chain] = result.value
        else failed.push(chains[i]!.chain)
      })

      set((state) => ({
        depositInfo: info,
        balances,
        activeChain: state.activeChain ?? chains[0]?.chain ?? null,
        loading: false,
        error: failed.length ? `Could not load balance for ${failed.join(', ')}` : null,
      }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to load balances', loading: false })
    }
  },

  loadDepositInfo: async () => {
    try {
      set({ depositInfo: await api.depositInfo() })
    } catch {
      /* the deposit panel degrades to showing the address from the user record */
    }
  },
}))
