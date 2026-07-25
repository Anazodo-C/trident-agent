import { create } from 'zustand'
import { api } from '../lib/api.ts'
import type { DepositInfo, WalletBalance } from '../lib/types.ts'

interface WalletState {
  balance: WalletBalance | null
  depositInfo: DepositInfo | null
  loading: boolean
  error: string | null
  refresh: (agentPrivateKey?: string) => Promise<void>
  loadDepositInfo: () => Promise<void>
}

export const useWalletStore = create<WalletState>((set) => ({
  balance: null,
  depositInfo: null,
  loading: false,
  error: null,

  refresh: async (agentPrivateKey) => {
    set({ loading: true, error: null })
    try {
      set({ balance: await api.balance(agentPrivateKey), loading: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to load balance', loading: false })
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
