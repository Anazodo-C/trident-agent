import { Square } from 'lucide-react'
import type { LiveStep } from '../../lib/types.ts'
import { usdc } from '../../lib/format.ts'

interface Props {
  budgetUsdc: number | null
  totalSpent: number
  steps: LiveStep[]
  running: boolean
  stopping: boolean
  onStop: () => void
  /**
   * `panel` is the desktop right-hand column; `strip` is the compact bar that
   * sits above the chat input below the lg breakpoint.
   */
  variant: 'panel' | 'strip'
}

const DOT: Record<LiveStep['status'], string> = {
  pending: 'text-slate-700',
  running: 'text-[#00D4FF] animate-pulse',
  done: 'text-[#00FF88]',
  failed: 'text-[#FF4466]',
}

const GLYPH: Record<LiveStep['status'], string> = {
  pending: '…',
  running: '◌',
  done: '✓',
  failed: '×',
}

export function ExpenseTracker(props: Props) {
  return props.variant === 'strip' ? <Strip {...props} /> : <Panel {...props} />
}

function ProgressBar({ totalSpent, budgetUsdc }: { totalSpent: number; budgetUsdc: number | null }) {
  if (!budgetUsdc || budgetUsdc <= 0) return null
  const pct = Math.min(100, (totalSpent / budgetUsdc) * 100)
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-[#111D35]">
      <div
        className="h-full rounded-full bg-[#00D4FF] transition-all duration-500"
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

function Strip({ budgetUsdc, totalSpent, running, stopping, onStop }: Props) {
  return (
    <div className="shrink-0 border-t border-[#1A7FFF]/20 bg-[#0A0E1A]/95 px-4 py-2.5 backdrop-blur-md lg:hidden">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="font-mono text-lg text-[#00D4FF]">${usdc(totalSpent, 3)}</span>
          <span className="truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
            spent{budgetUsdc !== null ? ` / $${usdc(budgetUsdc, 2)}` : ''}
          </span>
        </div>

        {running && (
          <button
            className="btn-danger shrink-0 px-3 py-1.5 text-xs"
            onClick={onStop}
            disabled={stopping}
          >
            <Square className="h-3 w-3" />
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        )}
      </div>

      {budgetUsdc !== null && (
        <div className="mt-2">
          <ProgressBar totalSpent={totalSpent} budgetUsdc={budgetUsdc} />
        </div>
      )}
    </div>
  )
}

function Panel({ budgetUsdc, totalSpent, steps, running, stopping, onStop }: Props) {
  return (
    <aside className="hidden w-72 shrink-0 flex-col gap-6 border-l border-[#1A7FFF]/20 p-5 lg:flex">
      <div>
        <span className="heading-mono">Expense Tracker</span>
        <div className="mt-4 font-mono text-3xl text-[#00D4FF]">${usdc(totalSpent, 3)}</div>
        <div className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
          spent{budgetUsdc !== null ? ` of $${usdc(budgetUsdc, 2)}` : ''}
        </div>
        {budgetUsdc !== null && (
          <div className="mt-4">
            <ProgressBar totalSpent={totalSpent} budgetUsdc={budgetUsdc} />
          </div>
        )}
      </div>

      {steps.length > 0 && (
        <ul className="flex flex-col gap-2 border-t border-[#1A7FFF]/20 pt-4">
          {steps.map((step) => (
            <li key={step.stepIndex} className="flex items-center justify-between gap-2 text-xs">
              <span className="flex min-w-0 items-center gap-2">
                <span className={`font-mono ${DOT[step.status]}`}>{GLYPH[step.status]}</span>
                <span className="truncate text-slate-400">{step.serviceName}</span>
              </span>
              <span
                className={`shrink-0 font-mono ${step.status === 'done' ? 'text-[#00FF88]' : 'text-slate-600'}`}
              >
                {step.status === 'done' ? `$${usdc(step.cost ?? 0, 3)}` : '—'}
              </span>
            </li>
          ))}
        </ul>
      )}

      {running && (
        <button className="btn-danger w-full" onClick={onStop} disabled={stopping}>
          <Square className="h-3.5 w-3.5" />
          {stopping ? 'Stopping…' : 'Stop agent'}
        </button>
      )}

      {stopping && (
        <p className="text-[11px] text-[#FFA040]">
          Stopping after the current step completes.
        </p>
      )}
    </aside>
  )
}
