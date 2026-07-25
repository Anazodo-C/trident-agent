import { create } from 'zustand'
import { api, setAuthToken } from '../lib/api.ts'
import type { User } from '../lib/types.ts'

const TOKEN_KEY = 'trident.jwt'

interface AuthState {
  token: string | null
  user: User | null
  loading: boolean
  setSession: (token: string, user: User) => void
  hydrate: () => Promise<void>
  refreshUser: () => Promise<void>
  logout: () => void
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: null,
  user: null,
  loading: true,

  setSession: (token, user) => {
    localStorage.setItem(TOKEN_KEY, token)
    setAuthToken(token)
    set({ token, user, loading: false })
  },

  /** Restore a stored JWT on boot and confirm it is still valid. */
  hydrate: async () => {
    const token = localStorage.getItem(TOKEN_KEY)
    if (!token) {
      set({ loading: false })
      return
    }
    setAuthToken(token)
    try {
      const { user } = await api.me(token)
      set({ token, user, loading: false })
    } catch {
      localStorage.removeItem(TOKEN_KEY)
      setAuthToken(null)
      set({ token: null, user: null, loading: false })
    }
  },

  refreshUser: async () => {
    if (!get().token) return
    try {
      const { user } = await api.me()
      set({ user })
    } catch {
      /* a transient failure shouldn't drop the session */
    }
  },

  logout: () => {
    localStorage.removeItem(TOKEN_KEY)
    setAuthToken(null)
    set({ token: null, user: null })
  },
}))
