/**
 * AuthContext — holds the current Trident user session (JWT + profile).
 * Supports both Google OAuth (Web2) and wallet sign-in (Web3).
 *
 * Persists JWT to localStorage. On load, re-fetches /auth/me to validate.
 */
import {
  createContext, useContext, useState, useEffect, useCallback,
  type ReactNode,
} from "react";
import axios from "axios";
import { useAccount, useSignMessage } from "wagmi";

const API = import.meta.env.VITE_API_URL || "https://backend-production-149a.up.railway.app";
const JWT_KEY = "trident_jwt";

export interface TridentUser {
  id: number;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
  wallet_address: string | null;
  agent_address: string | null;
  agent_created: boolean;
  max_trid_budget: number;
  trid_spent: number;
  budget_remaining: number;
}

interface AuthContextValue {
  user: TridentUser | null;
  token: string | null;
  loading: boolean;
  signInWithGoogle: (idToken: string) => Promise<void>;
  signInWithWallet: () => Promise<void>;
  signOut: () => void;
  refreshUser: () => Promise<void>;
  setBudget: (microTrid: number) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({} as AuthContextValue);
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser]     = useState<TridentUser | null>(null);
  const [token, setToken]   = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { address }           = useAccount();
  const { signMessageAsync }  = useSignMessage();

  // Restore session on mount
  useEffect(() => {
    const saved = localStorage.getItem(JWT_KEY);
    if (saved) {
      setToken(saved);
      axios.defaults.headers.common["Authorization"] = `Bearer ${saved}`;
      axios.get(`${API}/auth/me`)
        .then(r => setUser(r.data))
        .catch(() => {
          localStorage.removeItem(JWT_KEY);
          delete axios.defaults.headers.common["Authorization"];
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const _persist = (jwt: string, userData: TridentUser) => {
    localStorage.setItem(JWT_KEY, jwt);
    axios.defaults.headers.common["Authorization"] = `Bearer ${jwt}`;
    setToken(jwt);
    setUser(userData);
  };

  const signInWithGoogle = useCallback(async (idToken: string) => {
    const r = await axios.post(`${API}/auth/google`, { id_token: idToken });
    _persist(r.data.token, r.data.user);
  }, []);

  const signInWithWallet = useCallback(async () => {
    if (!address) throw new Error("No wallet connected");
    const nonceRes = await axios.get(`${API}/auth/nonce`, { params: { address } });
    const { message } = nonceRes.data;
    const signature = await signMessageAsync({ message });
    const r = await axios.post(`${API}/auth/wallet`, { address, signature });
    _persist(r.data.token, r.data.user);
  }, [address, signMessageAsync]);

  const refreshUser = useCallback(async () => {
    if (!token) return;
    const r = await axios.get(`${API}/auth/me`);
    setUser(r.data);
  }, [token]);

  const setBudget = useCallback(async (microTrid: number) => {
    await axios.put(`${API}/auth/me/budget`, { max_trid_budget: microTrid });
    await refreshUser();
  }, [refreshUser]);

  const signOut = useCallback(() => {
    localStorage.removeItem(JWT_KEY);
    delete axios.defaults.headers.common["Authorization"];
    setToken(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{
      user, token, loading,
      signInWithGoogle, signInWithWallet,
      signOut, refreshUser, setBudget,
    }}>
      {children}
    </AuthContext.Provider>
  );
}
