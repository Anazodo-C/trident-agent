import { useEffect, useState } from 'react'
import {
  Activity,
  CircleDollarSign,
  Layers,
  Loader2,
  Radio,
  Receipt,
  Users,
  Zap,
} from 'lucide-react'
import { api } from '../../lib/api.ts'
import type { Stats } from '../../lib/types.ts'
import { usdc } from '../../lib/format.ts'

export function DashboardPage() {
  const [scope, setScope] = useState<'me' | 'global'>('global')
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api
      .stats(scope)
      .then((s) => !cancelled && (setStats(s), setError(null)))
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load stats')
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [scope])

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-mono text-lg uppercase tracking-widest text-slate-100">Dashboard</h1>
          <p className="mt-2 text-sm text-slate-400">
            Activity across {scope === 'global' ? 'all agents' : 'your agent'}, from what the runner
            actually executed.
          </p>
        </div>
        <div className="flex gap-2">
          {(['global', 'me'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setScope(s)}
              className={`rounded-lg px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors ${
                scope === s ? 'bg-[#00D4FF]/10 text-[#00D4FF]' : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {s === 'global' ? 'Everyone' : 'Me'}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <div className="mb-5 rounded-xl border border-[#FF4466]/40 bg-[#FF4466]/10 p-4 text-sm text-[#FF4466]">
          {error}
        </div>
      )}

      {loading && !stats ? (
        <div className="flex items-center gap-3 py-12 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin text-[#00D4FF]" />
          Loading statistics
        </div>
      ) : stats ? (
        <div className={loading ? 'opacity-60' : ''}>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            {/* Unique users is a platform figure, showing it under "Me" would
                imply it described this user's activity. Swap it for something
                that actually does. */}
            {scope === 'global' ? (
              <Stat
                Icon={Users}
                label="Unique users"
                value={stats.totals.uniqueUsers.toLocaleString()}
                sub={`${stats.totals.walletsCreated.toLocaleString()} wallets created`}
              />
            ) : (
              <Stat
                Icon={Users}
                label="Active days"
                value={String(stats.daily.length)}
                sub={`last ${stats.daily.length === 1 ? 'day' : 'days'} with a run`}
              />
            )}
            <Stat
              Icon={CircleDollarSign}
              label="Total paid"
              value={`$${usdc(stats.totals.totalSpentUsdc)}`}
              sub={`$${usdc(stats.avgCostPerRun)} per run`}
              accent
            />
            <Stat
              Icon={Receipt}
              label="Transactions"
              value={stats.totals.transactions.toLocaleString()}
              sub={`${stats.totals.stepsExecuted.toLocaleString()} steps executed`}
            />
            <Stat
              Icon={Zap}
              label="Runs"
              value={stats.totals.runs.toLocaleString()}
              sub={`${stats.avgStepsPerRun} steps avg`}
            />
          </div>

          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat
              Icon={Radio}
              label="Endpoints called"
              value={stats.totals.endpointsCalled.toLocaleString()}
            />
            <Stat
              Icon={Layers}
              label="Services used"
              value={stats.totals.servicesUsed.toLocaleString()}
            />
            <Stat
              Icon={Activity}
              label="Step success"
              value={`${(stats.successRate * 100).toFixed(0)}%`}
              sub="of finished steps"
            />
            <Stat
              Icon={Layers}
              label="Free vs paid"
              value={`${stats.totals.freeCalls} / ${stats.totals.paidCalls}`}
              sub="calls"
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Top services">
              <BarList
                rows={stats.topServices.map((r) => ({
                  label: r.label,
                  value: r.count,
                  detail: `$${usdc(r.amountUsdc)}`,
                }))}
                empty="No services called yet."
              />
            </Panel>

            <Panel title="Spend by chain">
              <BarList
                rows={stats.spendByChain.map((r) => ({
                  label: r.label,
                  value: r.count,
                  detail: `$${usdc(r.amountUsdc)}`,
                }))}
                empty="No settled payments yet."
              />
            </Panel>

            <Panel title="Runs by status">
              <BarList
                rows={stats.runsByStatus.map((r) => ({ label: r.label, value: r.count }))}
                empty="No runs yet."
              />
            </Panel>

            {/* The most operationally useful panel: what to stop calling. */}
            <Panel title="Why steps failed">
              <BarList
                rows={stats.failureReasons.map((r) => ({ label: r.label, value: r.count }))}
                empty="No failures recorded."
              />
            </Panel>
          </div>

          <Panel title="Activity" className="mt-4">
            <DailyChart points={stats.daily} />
          </Panel>

          <p className="mt-6 font-mono text-[11px] text-slate-600">
            Registry: {stats.registry.total.toLocaleString()} services ·{' '}
            {stats.registry.free.toLocaleString()} free ·{' '}
            {stats.registry.x402.toLocaleString()} x402 ·{' '}
            {stats.registry.curated.toLocaleString()} curated
          </p>
        </div>
      ) : null}
    </div>
  )
}

function Stat({
  Icon,
  label,
  value,
  sub,
  accent,
}: {
  Icon: typeof Users
  label: string
  value: string
  sub?: string
  accent?: boolean
}) {
  return (
    <div className="panel p-4">
      <div className="mb-2 flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 text-slate-500" />
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
          {label}
        </span>
      </div>
      <div className={`font-mono text-2xl ${accent ? 'text-[#00D4FF]' : 'text-slate-100'}`}>
        {value}
      </div>
      {sub && <div className="mt-1 font-mono text-[10px] text-slate-600">{sub}</div>}
    </div>
  )
}

function Panel({
  title,
  children,
  className = '',
}: {
  title: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={`panel p-5 ${className}`}>
      <h2 className="heading-mono mb-4">{title}</h2>
      {children}
    </section>
  )
}

function BarList({
  rows,
  empty,
}: {
  rows: { label: string; value: number; detail?: string }[]
  empty: string
}) {
  if (rows.length === 0) return <p className="text-sm text-slate-600">{empty}</p>
  const max = Math.max(...rows.map((r) => r.value), 1)

  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map((row) => (
        <li key={row.label}>
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-xs text-slate-300" title={row.label}>
              {row.label}
            </span>
            <span className="shrink-0 font-mono text-[11px] text-slate-500">
              {row.detail ? `${row.detail} · ` : ''}
              {row.value.toLocaleString()}
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-[#111D35]">
            <div
              className="h-full rounded-full bg-[#00D4FF]/70"
              style={{ width: `${(row.value / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

/** Runs per day. Deliberately a plain bar chart, no charting dependency. */
function DailyChart({ points }: { points: { day: string; runs: number; spentUsdc: number }[] }) {
  if (points.length === 0) return <p className="text-sm text-slate-600">No activity in this period.</p>
  const max = Math.max(...points.map((p) => p.runs), 1)

  return (
    <div>
      <div className="flex h-32 items-end gap-1">
        {points.map((p) => (
          <div
            key={p.day}
            className="group relative flex-1 rounded-t bg-[#00D4FF]/25 transition-colors hover:bg-[#00D4FF]/60"
            style={{ height: `${Math.max(4, (p.runs / max) * 100)}%` }}
            title={`${p.day}: ${p.runs} run${p.runs === 1 ? '' : 's'}, $${usdc(p.spentUsdc)}`}
          />
        ))}
      </div>
      <div className="mt-2 flex justify-between font-mono text-[10px] text-slate-600">
        <span>{points[0]?.day}</span>
        <span>{points[points.length - 1]?.day}</span>
      </div>
    </div>
  )
}
