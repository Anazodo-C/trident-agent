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
  refresh: (chain?: string) => Promise<void>
  /** Load every chain this account may use, so both are visible side by side. */
  refreshAll: () => Promise<void>
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

  refresh: async (chain) => {
    const target = chain ?? get().activeChain ?? undefined
    set({ loading: true, error: null })
    try {
      const balance = await api.balance(target)
      set((state) => ({
        balances: { ...state.balances, [balance.chain]: balance },
        activeChain: state.activeChain ?? balance.chain,
        loading: false,
      }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to load balance', loading: false })
    }
  },

  refreshAll: async () => {
    set({ loading: true, error: null })
    try {
      /*
       * Always refetched, never reused.
       *
       * This used to keep the first response for the whole session, which meant
       * opting into mainnet added a wallet the panel could not see until a
       * reload, and the deposit panel drew its address from a payload fetched
       * before that wallet existed. The response is a few hundred bytes and
       * carries every address; a stale one is a wrong address.
       */
      const info = await api.depositInfo()
      const chains: ChainOption[] = info.availableChains?.length
        ? info.availableChains
        : [
            {
              chain: info.chain,
              label: info.chain,
              chainId: info.chainId,
              isTestnet: true,
              address: info.address,
            },
          ]

      /*
       * Published before the balances, not with them.
       *
       * Balances are RPC reads across every fundable chain and take seconds
       * when a public endpoint is throttling. The deposit address is already in
       * hand by this point and depends on none of it, so holding it back until
       * the slowest chain answers left the panel reading "Loading your deposit
       * address" for a value it had.
       */
      set((state) => ({
        depositInfo: info,
        activeChain: state.activeChain ?? chains[0]?.chain ?? null,
      }))

      // One failing chain must not blank the others, a mainnet RPC hiccup
      // should not hide the testnet balance the user is actually working with.
      const results = await Promise.allSettled(
        chains.map((c) => api.balance(c.chain)),
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
      /*
       * Left null on purpose. There is no second source for the address, and
       * there must not be: the panel shows nothing rather than guessing.
       */
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
