import { create } from 'zustand'

interface AgentState {
  /**
   * Decrypted EOA private key.
   *
   * Deliberately in memory only, never localStorage, sessionStorage, cookies,
   * or a URL. A page refresh loses it and the user re-enters their passphrase.
   */
  unlockedKey: string | null
  unlockModalOpen: boolean
  /** Runs once the wallet is unlocked, so an interrupted action can resume. */
  pendingAction: (() => void) | null

  unlock: (key: string) => void
  lock: () => void
  requestUnlock: (onUnlocked?: () => void) => void
  closeUnlockModal: () => void
}

export const useAgentStore = create<AgentState>((set, get) => ({
  unlockedKey: null,
  unlockModalOpen: false,
  pendingAction: null,

  unlock: (key) => {
    const { pendingAction } = get()
    set({ unlockedKey: key, unlockModalOpen: false, pendingAction: null })
    pendingAction?.()
  },

  lock: () => set({ unlockedKey: null }),

  requestUnlock: (onUnlocked) => {
    const { unlockedKey } = get()
    if (unlockedKey) {
      onUnlocked?.()
      return
    }
    set({ unlockModalOpen: true, pendingAction: onUnlocked ?? null })
  },

  closeUnlockModal: () => set({ unlockModalOpen: false, pendingAction: null }),
}))
