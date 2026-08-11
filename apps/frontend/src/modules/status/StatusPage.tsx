import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api.ts'
import type { ProbeState, StatusEndpoint, StatusSnapshot } from '../../lib/types.ts'
import { TridentMark } from '../layout/TridentMark.tsx'
import { StatusCard } from './StatusCard.tsx'

/**
 * Public reachability board, served at status.tridentagent.xyz.
 *
 * Read by people deciding whether to trust the catalog, so it is deliberately
 * unauthenticated and deliberately unflattering: an endpoint that is not
 * answering shows as not answering, and the figure the page leads with counts
 * only what was actually verified.
 */

/** How often the page asks. The prober's own slice lands on the same beat. */
const POLL_MS = 5_000

const STATE_LABEL: Record<ProbeState, string> = {
  live: 'live',
  answering: 'answering',
  throttled: 'throttled',
  gone: 'gone',
  erroring: 'erroring',
  down: 'down',
}

type Tab = 'reachable' | 'unreachable'

export function StatusPage() {
  const [snap, setSnap] = useState<StatusSnapshot | null>(null)
  const [failed, setFailed] = useState(false)
  const [tab, setTab] = useState<Tab>('reachable')
  const [provider, setProvider] = useState('')
  const [term, setTerm] = useState('')

  // index.html is titled for the app; on its own subdomain this is the whole
  // site, and a tab reading "Agentic Workspace" would be the wrong label.
  useEffect(() => {
    document.title = 'Trident Status — endpoint reachability'
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = () => {
      api
        .status()
        .then((next) => {
          if (cancelled) return
          setSnap(next)
          setFailed(false)
        })
        // Keep showing the last good snapshot rather than blanking the page: a
        // status board that goes empty when its own backend hiccups is telling
        // the reader something false about 900 other services.
        .catch(() => !cancelled && setFailed(true))
    }
    load()
    const timer = setInterval(load, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const providers = useMemo(() => {
    if (!snap) return []
    const counts = new Map<string, number>()
    for (const e of snap.endpoints) counts.set(e.host, (counts.get(e.host) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [snap])

  const [reachable, unreachable] = useMemo(() => {
    const ok: StatusEndpoint[] = []
    const bad: StatusEndpoint[] = []
    for (const e of snap?.endpoints ?? []) (e.reachable ? ok : bad).push(e)
    return [ok, bad]
  }, [snap])

  const rows = useMemo(() => {
    const source = tab === 'reachable' ? reachable : unreachable
    const needle = term.trim().toLowerCase()
    return source.filter(
      (e) =>
        (!provider || e.host === provider) &&
        (!needle || `${e.path} ${e.host}`.toLowerCase().includes(needle)),
    )
  }, [tab, reachable, unreachable, provider, term])

  if (!snap) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span className="heading-mono">{failed ? 'Status unavailable' : 'Loading status'}</span>
      </div>
    )
  }

  const pct = snap.total > 0 ? ((snap.reachable / snap.total) * 100).toFixed(1) : '0'

  return (
    <div className="min-h-screen">
      <div className="mx-auto w-full max-w-6xl px-5 py-8 sm:px-8 sm:py-10">
        {/* The landing page's header lockup, unchanged. */}
        <div className="flex items-center gap-3">
          <TridentMark className="h-8 w-8" />
          <span className="font-mono text-sm uppercase tracking-[0.3em] text-slate-200">
            Trident
          </span>
        </div>

        <div className="mt-10 flex flex-wrap items-end justify-between gap-6">
          <div>
            <p className="heading-mono">Live endpoint reachability</p>
            <h1 className="mt-5 font-mono text-3xl uppercase leading-[1.15] tracking-[0.08em] text-slate-100 sm:text-4xl sm:leading-[1.12]">
              Every endpoint,
              <br />
              checked continuously.
            </h1>
            <p className="mt-6 max-w-xl text-base leading-relaxed text-slate-400 sm:text-lg">
              A probe is an unpaid request. The{' '}
              <span className="font-mono text-[#00D4FF]">402</span> that comes back carries the
              seller&apos;s live terms, which proves the service is up and still selling — without
              spending anything to find out.
            </p>
          </div>

          <Ticker sweptAt={snap.sweptAt} stale={failed} />
        </div>

        <Summary snap={snap} pct={pct} />
        <HealthBar snap={snap} />

        <div className="mt-6 flex flex-wrap items-center gap-2.5">
          <div className="flex gap-0.5 rounded-xl border border-[#1A7FFF]/20 bg-[#0D1526] p-1">
            <TabButton active={tab === 'reachable'} onClick={() => setTab('reachable')}>
              Reachable <span className="tabular-nums opacity-75">{reachable.length}</span>
            </TabButton>
            <TabButton active={tab === 'unreachable'} onClick={() => setTab('unreachable')}>
              Unreachable <span className="tabular-nums opacity-75">{unreachable.length}</span>
            </TabButton>
          </div>

          <select
            className="field w-auto font-mono text-xs"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            aria-label="Filter by provider"
          >
            <option value="">All providers</option>
            {providers.map(([host, n]) => (
              <option key={host} value={host}>
                {host} ({n})
              </option>
            ))}
          </select>

          <input
            type="search"
            className="field min-w-[180px] flex-1 font-mono text-xs"
            placeholder="Filter by path…"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            aria-label="Filter by path"
          />

          <button
            className="btn-ghost !px-3 !py-2 text-[11px]"
            onClick={() => {
              setProvider('')
              setTerm('')
            }}
          >
            Reset
          </button>
        </div>

        {/*
          minmax(0, 1fr), never a bare 1fr: the automatic minimum of `1fr` is
          the item's min-content, and each card's meta line does not wrap, so a
          bare column sizes itself to the longest host and pushes the page
          sideways on a phone.
        */}
        <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-2.5 md:grid-cols-2 lg:grid-cols-3">
          {rows.map((e) => (
            <StatusCard key={`${e.method} ${e.host}${e.path}`} endpoint={e} label={STATE_LABEL[e.state]} />
          ))}
        </div>

        {rows.length === 0 && (
          <p className="py-12 text-center font-mono text-xs text-slate-500">
            Nothing matches those filters.
          </p>
        )}

        <Footnote snap={snap} />
      </div>
    </div>
  )
}

function TabButton({
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
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 font-mono text-[11px] uppercase tracking-widest transition-colors ${
        active ? 'bg-[#00D4FF]/10 text-[#00D4FF]' : 'text-slate-500 hover:text-slate-300'
      }`}
    >
      {children}
    </button>
  )
}

/** When the page last heard anything. The one thing a status board must not fake. */
function Ticker({ sweptAt, stale }: { sweptAt: number | null; stale: boolean }) {
  const [, force] = useState(0)
  // Re-render on the poll beat so "3s ago" does not sit frozen between fetches.
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), POLL_MS)
    return () => clearInterval(t)
  }, [])

  const ago = sweptAt ? Math.max(0, Math.round((Date.now() - sweptAt) / 1000)) : null
  return (
    <div className="flex items-center gap-2.5 font-mono text-[11px] tracking-wider text-slate-500">
      <span
        className={`h-[7px] w-[7px] rounded-full ${
          stale ? 'bg-[#FFA040]' : 'animate-pulse bg-[#00FF88]'
        }`}
      />
      {stale
        ? 'reconnecting'
        : ago === null
          ? 'first sweep running'
          : `last check ${ago}s ago · full cycle 5 min`}
    </div>
  )
}

function Summary({ snap, pct }: { snap: StatusSnapshot; pct: string }) {
  const stats: [string, string | number, string][] = [
    ['text-[#00FF88]', snap.reachable, `reachable right now · ${pct}%`],
    ['text-[#FF4466]', snap.total - snap.reachable, 'not answering'],
    /*
     * Kept apart from "reachable" on purpose. Only a 402 with parseable terms
     * proves the service still sells; the 4xx bucket is up but unconfirmed, and
     * folding the two together would be the easiest lie this page could tell.
     */
    ['text-slate-100', snap.confirmedSelling, 'confirmed selling'],
    ['text-slate-100', snap.total, 'endpoints tracked'],
    ['text-slate-100', snap.providers, 'providers'],
  ]
  return (
    <div className="mt-8 grid gap-px overflow-hidden rounded-xl border border-[#1A7FFF]/20 bg-[#1A7FFF]/20 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
      {stats.map(([tone, n, k], i) => (
        <div
          key={k}
          className={`bg-[#0D1526] px-4 py-4 ${
            // Five tiles never fill a two- or three-column grid, and because the
            // gaps are the hairline the empty cell reads as a missing tile.
            i === stats.length - 1 ? 'col-span-2 sm:col-span-1' : ''
          }`}
        >
          <div className={`font-mono text-3xl font-bold leading-none tabular-nums ${tone}`}>{n}</div>
          <div className="mt-2 text-xs text-slate-500">{k}</div>
        </div>
      ))}
    </div>
  )
}

/** The shape of the catalog's health, read before any number. */
function HealthBar({ snap }: { snap: StatusSnapshot }) {
  const seg = (state: ProbeState, color: string) => {
    const n = snap.byState[state] ?? 0
    if (!n || snap.total === 0) return null
    return (
      <span
        key={state}
        title={`${n} ${STATE_LABEL[state]}`}
        // A floor of 3px: three dead endpoints out of 936 is 0.3% of the bar,
        // which rounds to nothing. This bar must never hide red.
        style={{ width: `${(n / snap.total) * 100}%`, minWidth: '3px', background: color }}
      />
    )
  }
  return (
    <div className="mt-3.5 flex h-[5px] overflow-hidden rounded-sm bg-[#111D35]">
      {seg('live', '#00FF88')}
      {seg('answering', '#FFA040')}
      {seg('throttled', '#FFA040')}
      {seg('erroring', '#FF4466')}
      {seg('down', '#FF4466')}
      {seg('gone', '#FF4466')}
    </div>
  )
}

function Footnote({ snap }: { snap: StatusSnapshot }) {
  return (
    <footer className="mt-10 max-w-3xl border-t border-[#1A7FFF]/15 pt-5 text-xs leading-relaxed text-slate-500">
      <p>
        <strong className="font-semibold text-slate-400">Three states, two tabs.</strong>{' '}
        <span className="font-mono text-[#00D4FF]">live</span> answered 402 with parseable payment
        terms, or 200 on the free tier.{' '}
        <span className="font-mono text-[#00D4FF]">answering</span> replied with a 4xx — the host is
        up and the path exists, but the terms could not be confirmed.{' '}
        <span className="font-mono text-[#00D4FF]">gone</span> is a 404 on a path with no template
        in it.
      </p>
      <p className="mt-3">
        Each endpoint is re-checked every five minutes, and every provider every thirty seconds. No
        payment header is ever sent, so a probe cannot be charged and cannot trigger paid work.
        {snap.sweptAt && (
          <> Last check {new Date(snap.sweptAt).toLocaleTimeString()}.</>
        )}
      </p>
    </footer>
  )
}
