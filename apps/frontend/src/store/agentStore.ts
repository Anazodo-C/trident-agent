import { create } from 'zustand'

interface AgentState {
  /**
   * Whether the passphrase has been confirmed this session.
   *
   * This used to be implied by holding a decrypted key, because unlocking meant
   * decrypting one and every money operation needed it. Signing now happens
   * inside Circle, so there is no key to hold and no key to send, and what the
   * prompt establishes is only that the person acting knows the passphrase.
   *
   * That is still worth establishing. A session token alone should not be
   * enough to move real money.
   */
  unlocked: boolean

  /*
   * `unlockedKey` used to live here: the decrypted EOA key, held in memory for
   * the migration sweep. Migration is gone and nothing ever read it afterwards,
   * so it was a private key kept in application state for no purpose at all.
   * Removed rather than left "just in case", because the only thing it could
   * still do is leak.
   */

  unlockModalOpen: boolean
  /** Runs once the wallet is unlocked, so an interrupted action can resume. */
  pendingAction: (() => void) | null

  /** Record a confirmed passphrase for this session. */
  unlock: () => void
  lock: () => void
  requestUnlock: (onUnlocked?: () => void) => void
  closeUnlockModal: () => void
}

export const useAgentStore = create<AgentState>((set, get) => ({
  unlocked: false,
  unlockModalOpen: false,
  pendingAction: null,

  unlock: () => {
    const { pendingAction } = get()
    set({ unlocked: true, unlockModalOpen: false, pendingAction: null })
    pendingAction?.()
  },

  lock: () => set({ unlocked: false }),

  requestUnlock: (onUnlocked) => {
    if (get().unlocked) {
      onUnlocked?.()
      return
    }
    set({ unlockModalOpen: true, pendingAction: onUnlocked ?? null })
  },

  closeUnlockModal: () => set({ unlockModalOpen: false, pendingAction: null }),
}))
