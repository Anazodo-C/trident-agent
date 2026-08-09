import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Lock,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  TrendingUp,
} from 'lucide-react'
import { api } from '../../lib/api.ts'
import type { RegistrySync, Service, TrustTier } from '../../lib/types.ts'
import { relativeTime, usdc } from '../../lib/format.ts'

const PAGE_SIZE = 24

const TRUST: Record<TrustTier, { label: string; className: string; Icon: typeof ShieldCheck }> = {
  curated: { label: 'curated', className: 'bg-[#00FF88]/10 text-[#00FF88]', Icon: ShieldCheck },
  active: { label: 'in use', className: 'bg-[#1A7FFF]/10 text-[#1A7FFF]', Icon: TrendingUp },
  untested: { label: 'untested', className: 'bg-[#FFA040]/10 text-[#FFA040]', Icon: ShieldAlert },
}

export function EndpointsPage() {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [curatedOnly, setCuratedOnly] = useState(false)
  const [source, setSource] = useState<'free' | 'x402' | null>(null)
  const [offset, setOffset] = useState(0)

  const [services, setServices] = useState<Service[]>([])
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState({ free: 0, x402: 0 })
  const [sync, setSync] = useState<RegistrySync | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    (signal?: { cancelled: boolean }) => {
      setLoading(true)
      api
        .services({ q: query, curated: curatedOnly, ...(source ? { source } : {}), limit: PAGE_SIZE, offset })
        .then((res) => {
          if (signal?.cancelled) return
          setServices(res.services)
          setTotal(res.total)
          setCounts(res.counts)
          setSync(res.sync)
          setError(null)
        })
        .catch((err: unknown) => {
          if (!signal?.cancelled) {
            setError(err instanceof Error ? err.message : 'Could not load services')
          }
        })
        .finally(() => !signal?.cancelled && setLoading(false))
    },
    [query, curatedOnly, source, offset],
  )

  useEffect(() => {
    const signal = { cancelled: false }
    // Debounced so typing doesn't fire a request per keystroke.
    const timer = setTimeout(() => load(signal), 220)
    return () => {
      signal.cancelled = true
      clearTimeout(timer)
    }
  }, [load])

  // Any filter change invalidates the current page.
  useEffect(() => setOffset(0), [query, curatedOnly, source])

  async function refresh() {
    setSyncing(true)
    try {
      setSync(await api.syncRegistry())
      load()
    } catch {
      /* the existing list stays usable */
    } finally {
      setSyncing(false)
    }
  }

  const page = Math.floor(offset / PAGE_SIZE) + 1
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <header className="mb-5">
        <h1 className="font-mono text-lg uppercase tracking-widest text-slate-100">Endpoints</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">
          Free public APIs and x402 paid services your agent can reach. Free calls are
          metered by a small Arc Testnet payment; x402 services settle on mainnet.
          {sync?.serviceCount ? (
            <>
              {' '}
              <span className="font-mono text-slate-300">
                {sync.serviceCount.toLocaleString()}
              </span>{' '}
              services
              {sync.completedAt && <> · updated {relativeTime(sync.completedAt)}</>}
            </>
          ) : null}
        </p>
      </header>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-600" />
          <input
            className="field pl-9"
            placeholder="Search 14,000+ services — try 'domain', 'sentiment', 'price'…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button className="btn-ghost" onClick={refresh} disabled={syncing}>
          <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Syncing' : 'Sync'}
        </button>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Toggle
          active={source === 'free'}
          onClick={() => setSource((v) => (v === 'free' ? null : 'free'))}
        >
          Free (testnet)
          <Count n={counts.free} />
        </Toggle>
        <Toggle
          active={source === 'x402'}
          onClick={() => setSource((v) => (v === 'x402' ? null : 'x402'))}
        >
          x402 (mainnet)
          <Count n={counts.x402} />
        </Toggle>
        <span className="mx-1 h-4 w-px bg-[#1A7FFF]/25" />
        <Toggle active={curatedOnly} onClick={() => setCuratedOnly((v) => !v)}>
          Curated
        </Toggle>
        <span className="ml-auto font-mono text-[11px] text-slate-500">
          {total.toLocaleString()} result{total === 1 ? '' : 's'}
        </span>
      </div>

      {error && (
        <div className="mb-5 rounded-xl border border-[#FF4466]/40 bg-[#FF4466]/10 p-4 text-sm text-[#FF4466]">
          {error}
        </div>
      )}

      {loading && services.length === 0 ? (
        <div className="flex items-center gap-3 py-12 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin text-[#00D4FF]" />
          Loading services
        </div>
      ) : services.length === 0 ? (
        <p className="py-12 text-sm text-slate-500">
          Nothing matched that search.
          {source && ' Try clearing the source filter.'}
        </p>
      ) : (
        <div className={`grid gap-4 sm:grid-cols-2 lg:grid-cols-3 ${loading ? 'opacity-60' : ''}`}>
          {services.map((service) => (
            <ServiceCard
              key={service.id}
              service={service}
              onUse={() =>
                navigate('/app', { state: { prefill: `Use ${service.serviceName} to ` } })
              }
            />
          ))}
        </div>
      )}

      {pages > 1 && (
        <nav className="mt-8 flex items-center justify-center gap-3">
          <button
            className="btn-ghost px-3"
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="font-mono text-xs text-slate-500">
            {page} / {pages.toLocaleString()}
          </span>
          <button
            className="btn-ghost px-3"
            disabled={page >= pages || loading}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </nav>
      )}
    </div>
  )
}

function Toggle({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors ${
        active
          ? 'border-[#00D4FF]/60 bg-[#00D4FF]/10 text-[#00D4FF]'
          : 'border-[#1A7FFF]/25 text-slate-400 hover:border-[#00D4FF]/40 hover:text-slate-200'
      }`}
    >
      {children}
    </button>
  )
}

function ServiceCard({ service, onUse }: { service: Service; onUse: () => void }) {
  const trust = TRUST[service.trust]
  return (
    <article className={`panel-interactive flex flex-col p-5 ${service.payable ? '' : 'opacity-70'}`}>
      <div className="mb-2 flex items-start justify-between gap-3">
        <h2 className="min-w-0 truncate font-mono text-sm text-slate-100" title={service.serviceName}>
          {service.serviceName}
        </h2>
        <span className={`badge shrink-0 gap-1 ${trust.className}`}>
          <trust.Icon className="h-3 w-3" />
          {trust.label}
        </span>
      </div>

      <p className="mb-3 truncate font-mono text-[11px] text-slate-600" title={service.resource}>
        {service.host}
      </p>

      <p className="mb-4 line-clamp-3 flex-1 text-sm leading-relaxed text-slate-400">
        {service.description || 'No description provided.'}
      </p>

      {service.trust === 'untested' && (
        <p className="mb-3 rounded-lg border border-[#FFA040]/30 bg-[#FFA040]/5 p-2.5 text-[11px] leading-relaxed text-[#FFA040]">
          No recorded usage in the last 30 days — may not respond.
        </p>
      )}

      {!service.payable && service.blockedReason && (
        <p className="mb-3 flex items-start gap-1.5 rounded-lg border border-[#1A7FFF]/25 bg-[#1A7FFF]/5 p-2.5 text-[11px] leading-relaxed text-slate-400">
          <Lock className="mt-0.5 h-3 w-3 shrink-0" />
          {service.blockedReason}
        </p>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {service.source === 'free' ? (
          <span className="badge bg-[#00FF88]/10 text-[#00FF88]">free · testnet metered</span>
        ) : (
          <span className="price text-xs">${usdc(service.payPriceUsdc)}</span>
        )}
        {service.payChain && (
          <span className="badge bg-slate-500/10 text-slate-400">
            {service.payIsTestnet ? 'testnet' : service.payChain}
          </span>
        )}
        {service.calls30d > 0 && (
          <span className="font-mono text-[10px] text-slate-600">
            {service.calls30d.toLocaleString()} calls/30d
          </span>
        )}
      </div>

      <button className="btn-ghost w-full" onClick={onUse} disabled={!service.payable}>
        Use
        <ArrowRight className="h-4 w-4" />
      </button>
    </article>
  )
}

/** Count badge inside a filter chip. */
function Count({ n }: { n: number }) {
  if (!n) return null
  return <span className="ml-1.5 opacity-60">{n.toLocaleString()}</span>
}
