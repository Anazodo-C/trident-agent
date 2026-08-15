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

  /**
   * The decrypted EOA key, for migration and nothing else.
   *
   * Only ever set while an unmigrated wallet still has ciphertext to decrypt,
   * and only used to sweep the old address and hand the key back to its owner.
   * Once a user has migrated this stays null forever.
   *
   * In memory only, never localStorage, sessionStorage, cookies, or a URL. A
   * page refresh loses it, which is correct: it should be the hardest thing in
   * the app to still have lying around.
   */
  unlockedKey: string | null

  unlockModalOpen: boolean
  /** Runs once the wallet is unlocked, so an interrupted action can resume. */
  pendingAction: (() => void) | null

  /**
   * Record a confirmed passphrase. `key` is passed only by the pre-migration
   * path that actually decrypted one.
   */
  unlock: (key?: string | null) => void
  lock: () => void
  requestUnlock: (onUnlocked?: () => void) => void
  closeUnlockModal: () => void
}

export const useAgentStore = create<AgentState>((set, get) => ({
  unlocked: false,
  unlockedKey: null,
  unlockModalOpen: false,
  pendingAction: null,

  unlock: (key) => {
    const { pendingAction } = get()
    set({
      unlocked: true,
      unlockedKey: key ?? null,
      unlockModalOpen: false,
      pendingAction: null,
    })
    pendingAction?.()
  },

  lock: () => set({ unlocked: false, unlockedKey: null }),

  requestUnlock: (onUnlocked) => {
    if (get().unlocked) {
      onUnlocked?.()
      return
    }
    set({ unlockModalOpen: true, pendingAction: onUnlocked ?? null })
  },

  closeUnlockModal: () => set({ unlockModalOpen: false, pendingAction: null }),
}))
