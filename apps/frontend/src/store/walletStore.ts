import { create } from 'zustand'
import { api } from '../lib/api.ts'
import type { ChainOption, DepositInfo, PendingDeposit, WalletBalance } from '../lib/types.ts'

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
  /** Deposits awaiting source-chain finality, keyed by chain. */
  pendingDeposits: Record<string, PendingDeposit>
  loading: boolean
  error: string | null

  setActiveChain: (chain: string) => void
  notePendingDeposit: (deposit: PendingDeposit) => void
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
  pendingDeposits: {},
  loading: false,
  error: null,

  setActiveChain: (activeChain) => set({ activeChain }),

  notePendingDeposit: (deposit) =>
    set((state) => ({ pendingDeposits: { ...state.pendingDeposits, [deposit.chain]: deposit } })),

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

      // One failing chain must not blank the others, a mainnet RPC hiccup
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
        pendingDeposits: settledDeposits(state.pendingDeposits, balances),
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

/**
 * Drop pending markers whose funds have arrived.
 *
 * Compared against the Gateway total captured when the deposit was made, not
 * against zero, the wallet may already hold a balance, so "non-zero" proves
 * nothing. A marker is also dropped once the total can no longer be read,
 * since a locked wallet cannot confirm either way and a stuck banner is worse
 * than none.
 */
function settledDeposits(
  pending: Record<string, PendingDeposit>,
  balances: Record<string, WalletBalance>,
): Record<string, PendingDeposit> {
  const next: Record<string, PendingDeposit> = {}
  for (const [chain, deposit] of Object.entries(pending)) {
    const total = balances[chain]?.gatewayUsdc
    // Gateway balance unreadable (wallet locked), keep waiting.
    if (total == null) {
      next[chain] = deposit
      continue
    }
    const baseline = Number(deposit.baselineTotal ?? '0')
    if (Number(total) > baseline) continue
    next[chain] = deposit
  }
  return next
}
