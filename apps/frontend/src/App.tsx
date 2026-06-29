import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import MarketplacePage from "./modules/marketplace/MarketplacePage";
import RetrobotPage from "./modules/retrobot/RetrobotPage";
import ReputationPage from "./modules/reputation/ReputationPage";
import DashboardPage from "./modules/dashboard/DashboardPage";

function Nav() {
  const linkCls = ({ isActive }: { isActive: boolean }) =>
    `px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
      isActive
        ? "bg-violet-600 text-white"
        : "text-gray-400 hover:text-gray-100 hover:bg-gray-800"
    }`;

  return (
    <nav className="border-b border-gray-800 bg-gray-950/80 backdrop-blur-sm sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between h-16">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🔱</span>
          <span className="font-bold text-white text-lg tracking-tight">Trident</span>
          <span className="text-gray-500 text-xs ml-1 hidden sm:block">Arc Testnet</span>
        </div>
        <div className="flex items-center gap-1">
          <NavLink to="/" end className={linkCls}>Marketplace</NavLink>
          <NavLink to="/retrobot" className={linkCls}>
            <span className="flex items-center gap-1">
              Retrobot
              <span className="bg-emerald-500 w-1.5 h-1.5 rounded-full animate-pulse" />
            </span>
          </NavLink>
          <NavLink to="/reputation" className={linkCls}>Reputation</NavLink>
          <NavLink to="/dashboard" className={linkCls}>Dashboard</NavLink>
        </div>
        <ConnectButton chainStatus="icon" showBalance={false} />
      </div>
    </nav>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen">
        <Nav />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <Routes>
            <Route path="/" element={<MarketplacePage />} />
            <Route path="/retrobot" element={<RetrobotPage />} />
            <Route path="/reputation" element={<ReputationPage />} />
            <Route path="/dashboard" element={<DashboardPage />} />
          </Routes>
        </main>
        <footer className="border-t border-gray-800 mt-16 py-6 text-center text-gray-600 text-xs">
          Trident Agent • Arc Testnet (Chain ID: 5042002) • Powered by Circle Gateway x402
        </footer>
      </div>
    </BrowserRouter>
  );
}
