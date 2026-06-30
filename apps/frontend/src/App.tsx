import { useState, useEffect } from "react";
import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";

import AgentsPage     from "./modules/agents/AgentsPage";
import RetrobotPage   from "./modules/retrobot/RetrobotPage";
import ReputationPage from "./modules/reputation/ReputationPage";
import DashboardPage  from "./modules/dashboard/DashboardPage";
import { ToastProvider } from "./components/Toast";
import FaucetModal from "./components/FaucetModal";
import ErrorBoundary from "./components/ErrorBoundary";

function FaucetButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Claim free $TRID"
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-semibold transition-all"
      style={{
        background: "rgba(0,180,216,0.12)",
        border:     "1px solid rgba(0,180,216,0.28)",
        color:      "var(--accent)",
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLElement).style.background = "rgba(0,180,216,0.22)";
        (e.currentTarget as HTMLElement).style.boxShadow = "0 0 12px rgba(0,180,216,0.25)";
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLElement).style.background = "rgba(0,180,216,0.12)";
        (e.currentTarget as HTMLElement).style.boxShadow = "none";
      }}
    >
      💧 <span className="hidden sm:inline">Faucet</span>
    </button>
  );
}

function Nav({
  dark,
  onToggleTheme,
  onFaucet,
}: {
  dark: boolean;
  onToggleTheme: () => void;
  onFaucet: () => void;
}) {
  const { isConnected } = useAccount();
  const linkCls = ({ isActive }: { isActive: boolean }) =>
    `nav-link${isActive ? " active" : ""}`;

  return (
    <nav
      className="sticky top-0 z-50"
      style={{
        background:     "var(--bg-card)",
        borderBottom:   "1px solid var(--border)",
        backdropFilter: "blur(16px)",
      }}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between h-16">
        {/* Logo */}
        <div className="flex items-center gap-2.5">
          <span className="text-2xl">🔱</span>
          <span className="font-extrabold text-lg tracking-tight" style={{ color: "var(--text-primary)" }}>
            Trident
          </span>
          <span
            className="text-xs px-2 py-0.5 rounded-full hidden sm:block"
            style={{
              background: "rgba(0,180,216,0.15)",
              color:      "var(--accent)",
              border:     "1px solid rgba(0,180,216,0.25)",
            }}
          >
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

        {/* Right: faucet + theme + wallet */}
        <div className="flex items-center gap-2">
          {isConnected && <FaucetButton onClick={onFaucet} />}
          <button
            onClick={onToggleTheme}
            aria-label="Toggle theme"
            className="w-9 h-9 rounded-xl flex items-center justify-center transition-all text-base"
            style={{
              background: "rgba(0,180,216,0.10)",
              border:     "1px solid rgba(0,180,216,0.20)",
              color:      "var(--accent)",
            }}
          >
            {dark ? "☀️" : "🌙"}
          </button>
          <ConnectButton chainStatus="icon" showBalance={false} />
        </div>
      </div>
    </nav>
  );
}

export default function App() {
  const [dark, setDark] = useState(() => {
    const stored = localStorage.getItem("trident_theme");
    if (stored) return stored === "dark";
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  });
  const [showFaucet, setShowFaucet] = useState(false);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.body.classList.toggle("dark", dark);
    localStorage.setItem("trident_theme", dark ? "dark" : "light");
  }, [dark]);

  return (
    <BrowserRouter>
      <ToastProvider>
        <div className="min-h-screen">
          <Nav
            dark={dark}
            onToggleTheme={() => setDark(d => !d)}
            onFaucet={() => setShowFaucet(true)}
          />

          {showFaucet && (
            <FaucetModal
              onAccept={() => setShowFaucet(false)}
              onSkip={() => setShowFaucet(false)}
            />
          )}

          <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <Routes>
              <Route path="/"           element={<ErrorBoundary label="Agents"><AgentsPage /></ErrorBoundary>} />
              <Route path="/retrobot"   element={<ErrorBoundary label="Retrobot"><RetrobotPage /></ErrorBoundary>} />
              <Route path="/reputation" element={<ErrorBoundary label="Reputation"><ReputationPage /></ErrorBoundary>} />
              <Route path="/dashboard"  element={<ErrorBoundary label="Dashboard"><DashboardPage /></ErrorBoundary>} />
            </Routes>
          </main>

          <footer
            className="mt-16 py-5 text-center text-xs"
            style={{ borderTop: "1px solid var(--border)", color: "var(--text-muted)" }}
          >
            Trident Agent · Arc Testnet (Chain ID: 5042002) · Powered by Circle Gateway x402
          </footer>
        </div>
      </ToastProvider>
    </BrowserRouter>
  );
}
