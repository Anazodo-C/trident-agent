import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { BarChart3, Check, Clipboard, Clock, Grid3x3, LogOut, Radar, Wallet } from 'lucide-react'
import { useAuthStore } from '../../store/authStore.ts'
import { useAgentStore } from '../../store/agentStore.ts'
import { copyToClipboard, shortAddress } from '../../lib/format.ts'
import { TridentMark } from './TridentMark.tsx'
import { UnlockModal } from '../auth/UnlockModal.tsx'

const NAV = [
  { to: '/app', label: 'Agent', Icon: Radar, end: true },
  { to: '/app/endpoints', label: 'Endpoints', Icon: Grid3x3, end: false },
  { to: '/app/history', label: 'History', Icon: Clock, end: false },
  { to: '/app/wallet', label: 'Wallet', Icon: Wallet, end: false },
  { to: '/app/dashboard', label: 'Stats', Icon: BarChart3, end: false },
]

export function AppShell() {
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const lock = useAgentStore((s) => s.lock)
  const unlocked = useAgentStore((s) => s.unlockedKey !== null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(t)
  }, [copied])

  function signOut() {
    lock()
    logout()
    navigate('/')
  }

  // Exactly one viewport tall, with the header, nav rails and page area as flex
  // children. The mobile tab bar is a flow child rather than `fixed`, so it can
  // never overlap the agent tab's chat input or expense strip.
  return (
    <div className="flex h-dvh flex-col">
      <header className="z-30 flex shrink-0 items-center justify-between gap-4 border-b border-[#1A7FFF]/20 bg-[#0A0E1A]/85 px-4 py-3 backdrop-blur-md sm:px-6">
        {/* Signed in, so home is the agent. Same affordance as the landing
            header, the wordmark is always the way back. */}
        <Link
          to="/app"
          className="flex items-center gap-2.5 transition-opacity hover:opacity-80"
          aria-label="Trident home"
        >
          <TridentMark className="h-7 w-7" />
          <span className="font-mono text-sm uppercase tracking-[0.3em] text-slate-100">
            Trident
          </span>
        </Link>

        <div className="flex items-center gap-2">
          <span
            className={`badge hidden sm:inline-flex ${
              unlocked
                ? 'bg-[#00FF88]/10 text-[#00FF88]'
                : 'bg-slate-500/10 text-slate-500'
            }`}
            title={unlocked ? 'Agent wallet unlocked for this session' : 'Agent wallet locked'}
          >
            {unlocked ? 'Unlocked' : 'Locked'}
          </span>

          <button
            onClick={async () => setCopied(await copyToClipboard(user?.eoaAddress ?? ''))}
            disabled={!user?.eoaAddress}
            className="flex items-center gap-2 rounded-lg border border-[#1A7FFF]/25 px-2.5 py-1.5 font-mono text-xs text-slate-300 transition-colors hover:border-[#00D4FF]/60 hover:text-[#00D4FF] disabled:opacity-40"
            title="Copy agent wallet address"
          >
            {shortAddress(user?.eoaAddress)}
            {copied ? (
              <Check className="h-3.5 w-3.5 text-[#00FF88]" />
            ) : (
              <Clipboard className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-row">
        {/* Desktop rail */}
        <nav className="hidden w-52 shrink-0 flex-col justify-between border-r border-[#1A7FFF]/20 p-3 md:flex">
          <div className="flex flex-col gap-1">
            {NAV.map(({ to, label, Icon, end }) => (
              <NavLink key={to} to={to} end={end} className={navClass}>
                <Icon className="h-4 w-4" />
                {label}
              </NavLink>
            ))}
          </div>

          <div className="flex flex-col gap-2 border-t border-[#1A7FFF]/20 pt-3">
            <div className="truncate px-3 font-mono text-[11px] text-slate-500">
              {user?.email ?? shortAddress(user?.walletAddress)}
            </div>
            <button
              onClick={signOut}
              className="flex items-center gap-2.5 rounded-lg px-3 py-2 font-mono text-xs uppercase tracking-widest text-slate-500 transition-colors hover:bg-[#FF4466]/10 hover:text-[#FF4466]"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </nav>

        {/* Pages that need internal scrolling (the agent tab) set h-full and
            manage their own overflow; simple pages just scroll this container. */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          <Outlet />
        </main>
      </div>

      {/* Mobile tab bar, in normal flow so it reserves its own space */}
      <nav className="z-30 flex shrink-0 border-t border-[#1A7FFF]/20 bg-[#0A0E1A]/95 backdrop-blur-md md:hidden">
        {NAV.map(({ to, label, Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={mobileNavClass}>
            <Icon className="h-4 w-4" />
            <span className="text-[10px] uppercase tracking-wider">{label}</span>
          </NavLink>
        ))}
      </nav>

      <UnlockModal />
    </div>
  )
}

function navClass({ isActive }: { isActive: boolean }): string {
  return [
    'flex items-center gap-2.5 rounded-lg px-3 py-2.5 font-mono text-xs uppercase tracking-widest transition-colors',
    isActive
      ? 'bg-[#00D4FF]/10 text-[#00D4FF]'
      : 'text-slate-400 hover:bg-[#111D35] hover:text-slate-200',
  ].join(' ')
}

function mobileNavClass({ isActive }: { isActive: boolean }): string {
  return [
    'flex flex-1 flex-col items-center gap-1 py-2.5 font-mono transition-colors',
    isActive ? 'text-[#00D4FF]' : 'text-slate-500',
  ].join(' ')
}
