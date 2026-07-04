import { useState, useEffect, useRef } from "react";
import { BrowserRouter, Routes, Route, NavLink, useNavigate } from "react-router-dom";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { GoogleOAuthProvider } from "@react-oauth/google";

import AgentsPage     from "./modules/agents/AgentsPage";
import RetrobotPage   from "./modules/retrobot/RetrobotPage";
import ReputationPage from "./modules/reputation/ReputationPage";
import DashboardPage  from "./modules/dashboard/DashboardPage";
import ProfilePage    from "./modules/profile/ProfilePage";
import AuthPage       from "./modules/auth/AuthPage";
import { AuthProvider, useAuth } from "./modules/auth/AuthContext";
import { ToastProvider } from "./components/Toast";
import ErrorBoundary from "./components/ErrorBoundary";
import { AGENT_KEY_STORE } from "./modules/auth/AgentKeyModal";

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";

// ── Agent Badge (replaces ConnectButton in nav for authenticated users) ────────
function AgentBadge() {
  const { user, signOut, unlockedKey } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  if (!user) return null;

  const storedMeta = (() => {
    try { return JSON.parse(localStorage.getItem(AGENT_KEY_STORE) || "{}"); } catch { return {}; }
  })();
  const agentName = storedMeta.name || user.name || "My Agent";

  return (
    <div className="relative" ref={ref}>
      {/* Badge button */}
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm font-semibold transition-all"
        style={{
          background: open ? "rgba(0,180,216,0.2)" : "rgba(0,180,216,0.1)",
          border: "1px solid rgba(0,180,216,0.25)",
          color: "var(--text-primary)",
        }}
      >
        {user.avatar_url
          ? <img src={user.avatar_url} className="w-5 h-5 rounded-full" alt="" />
          : <span className="text-base leading-none">🤖</span>
        }
        <span className="hidden sm:inline max-w-28 truncate">{agentName}</span>
        {unlockedKey && <span className="text-xs" title="Agent unlocked">🔓</span>}
        <svg className="w-3 h-3 shrink-0 opacity-50" viewBox="0 0 12 12" fill="none">
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </button>

      {/* Dropdown */}
      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-64 rounded-2xl shadow-xl z-50 overflow-hidden"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
        >
          {/* Identity */}
          <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
            <div className="flex items-center gap-2.5">
              {user.avatar_url
                ? <img src={user.avatar_url} className="w-8 h-8 rounded-full" alt="" />
                : <div className="w-8 h-8 rounded-full flex items-center justify-center text-base"
                    style={{ background: "rgba(0,180,216,0.15)" }}>🤖</div>
              }
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate" style={{ color: "var(--text-primary)" }}>
                  {agentName}
                </div>
                {user.email && (
                  <div className="text-xs truncate" style={{ color: "var(--text-muted)" }}>{user.email}</div>
                )}
              </div>
            </div>
          </div>

          {/* Agent wallet */}
          {user.agent_address && (
            <div className="px-4 py-2.5" style={{ borderBottom: "1px solid var(--border)" }}>
              <div className="text-xs mb-0.5" style={{ color: "var(--text-muted)" }}>Agent wallet</div>
              <div className="flex items-center gap-1.5">
                <code className="text-xs" style={{ color: "var(--text-primary)", fontFamily: "monospace" }}>
                  {user.agent_address.slice(0, 10)}…{user.agent_address.slice(-6)}
                </code>
                <a href={`https://testnet.arcscan.app/address/${user.agent_address}`}
                  target="_blank" rel="noreferrer" className="text-xs" style={{ color: "var(--accent)" }}>↗</a>
              </div>
              <div className="text-xs mt-0.5" style={{ color: unlockedKey ? "#4ade80" : "var(--text-muted)" }}>
                {unlockedKey ? "🔓 Unlocked for payments" : "🔒 Locked — unlock in Dashboard"}
              </div>
            </div>
          )}

          {/* MetaMask wallet (Web3 users) */}
          {user.wallet_address && (
            <div className="px-4 py-2.5" style={{ borderBottom: "1px solid var(--border)" }}>
              <div className="text-xs mb-0.5" style={{ color: "var(--text-muted)" }}>MetaMask wallet</div>
              <div className="flex items-center gap-1.5">
                <code className="text-xs" style={{ color: "var(--text-primary)", fontFamily: "monospace" }}>
                  {user.wallet_address.slice(0, 10)}…{user.wallet_address.slice(-6)}
                </code>
                <a href={`https://testnet.arcscan.app/address/${user.wallet_address}`}
                  target="_blank" rel="noreferrer" className="text-xs" style={{ color: "var(--accent)" }}>↗</a>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="p-2 flex flex-col gap-0.5">
            <button
              onClick={() => { setOpen(false); navigate("/profile"); }}
              className="w-full text-left text-xs px-3 py-2 rounded-xl flex items-center gap-2"
              style={{ color: "var(--text-primary)" }}
              onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.06)")}
              onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
            >
              👤 My Dashboard
            </button>
            <button
              onClick={() => { setOpen(false); signOut(); }}
              className="w-full text-left text-xs px-3 py-2 rounded-xl flex items-center gap-2"
              style={{ color: "#ff8080" }}
              onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,60,60,0.08)")}
              onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
            >
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Nav ───────────────────────────────────────────────────────────────────────
function Nav({ dark, onToggleTheme }: { dark: boolean; onToggleTheme: () => void }) {
  const { user } = useAuth();
  const linkCls = ({ isActive }: { isActive: boolean }) => `nav-link${isActive ? " active" : ""}`;

  return (
    <nav className="sticky top-0 z-50"
      style={{ background: "var(--bg-card)", borderBottom: "1px solid var(--border)", backdropFilter: "blur(16px)" }}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between h-16">
        {/* Logo */}
        <div className="flex items-center gap-2.5">
          <span className="text-2xl">🔱</span>
          <span className="font-extrabold text-lg tracking-tight" style={{ color: "var(--text-primary)" }}>Trident</span>
          <span className="text-xs px-2 py-0.5 rounded-full hidden sm:block"
            style={{ background: "rgba(0,180,216,0.15)", color: "var(--accent)", border: "1px solid rgba(0,180,216,0.25)" }}>
            Arc Testnet
          </span>
        </div>

        {/* Links */}
        <div className="flex items-center gap-1">
          <NavLink to="/" end className={linkCls}>Agents</NavLink>
          <NavLink to="/retrobot" className={linkCls}>
            <span className="flex items-center gap-1.5">
              Retrobot
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            </span>
          </NavLink>
          <NavLink to="/reputation" className={linkCls}>Reputation</NavLink>
          <NavLink to="/dashboard" className={linkCls}>Dashboard</NavLink>
        </div>

        {/* Right */}
        <div className="flex items-center gap-2">
          <button onClick={onToggleTheme} aria-label="Toggle theme"
            className="w-9 h-9 rounded-xl flex items-center justify-center text-base"
            style={{ background: "rgba(0,180,216,0.10)", border: "1px solid rgba(0,180,216,0.20)", color: "var(--accent)" }}>
            {dark ? "☀️" : "🌙"}
          </button>
          {/* Authenticated: show agent badge. Unauthenticated: show RainbowKit */}
          {user ? <AgentBadge /> : <ConnectButton chainStatus="icon" showBalance={false} />}
        </div>
      </div>
    </nav>
  );
}

// ── App shell ─────────────────────────────────────────────────────────────────
function AppShell({ dark, setDark }: {
  dark: boolean;
  setDark: (v: boolean | ((b: boolean) => boolean)) => void;
}) {
  const { user, loading } = useAuth();

  if (loading) return null;
  if (!user) return <AuthPage />;

  return (
    <div className="min-h-screen">
      <Nav dark={dark} onToggleTheme={() => setDark(d => !d)} />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Routes>
          <Route path="/"           element={<ErrorBoundary label="Agents"><AgentsPage /></ErrorBoundary>} />
          <Route path="/retrobot"   element={<ErrorBoundary label="Retrobot"><RetrobotPage /></ErrorBoundary>} />
          <Route path="/reputation" element={<ErrorBoundary label="Reputation"><ReputationPage /></ErrorBoundary>} />
          <Route path="/dashboard"  element={<ErrorBoundary label="Dashboard"><DashboardPage /></ErrorBoundary>} />
          <Route path="/profile"    element={<ErrorBoundary label="Profile"><ProfilePage /></ErrorBoundary>} />
        </Routes>
      </main>
      <footer className="mt-16 py-5 text-center text-xs"
        style={{ borderTop: "1px solid var(--border)", color: "var(--text-muted)" }}>
        Trident Agent · Arc Testnet (Chain ID: 5042002) · Powered by Circle Gateway x402
      </footer>
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [dark, setDark] = useState(() => {
    const stored = localStorage.getItem("trident_theme");
    if (stored) return stored === "dark";
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.body.classList.toggle("dark", dark);
    localStorage.setItem("trident_theme", dark ? "dark" : "light");
  }, [dark]);

  return (
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      <AuthProvider>
        <BrowserRouter>
          <ToastProvider>
            <AppShell dark={dark} setDark={setDark} />
          </ToastProvider>
        </BrowserRouter>
      </AuthProvider>
    </GoogleOAuthProvider>
  );
}
