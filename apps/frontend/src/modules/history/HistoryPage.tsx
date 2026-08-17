import { useEffect, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { api } from '../../lib/api.ts'
import { useTaskStore } from '../../store/taskStore.ts'
import { relativeTime, usdc } from '../../lib/format.ts'
import type { TaskStepDetail, TaskSummary } from '../../lib/types.ts'

const STATUS_CLASS: Record<string, string> = {
  done: 'bg-[#00FF88]/10 text-[#00FF88]',
  running: 'bg-[#00D4FF]/10 text-[#00D4FF] animate-pulse',
  // A run that lost steps. Without its own entry it fell through to the grey
  // "pending" style, which reads as a run that never started.
  partial: 'bg-[#FFA040]/10 text-[#FFA040]',
  stopped: 'bg-[#FFA040]/10 text-[#FFA040]',
  failed: 'bg-[#FF4466]/10 text-[#FF4466]',
  pending: 'bg-slate-500/10 text-slate-400',
}

export function HistoryPage() {
  const history = useTaskStore((s) => s.history)
  const loading = useTaskStore((s) => s.historyLoading)
  const loadHistory = useTaskStore((s) => s.loadHistory)
  const [selected, setSelected] = useState<TaskSummary | null>(null)

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <header className="mb-6">
        <h1 className="font-mono text-lg uppercase tracking-widest text-slate-100">History</h1>
        <p className="mt-2 text-sm text-slate-400">Every run your agent has executed.</p>
      </header>

      {loading && history.length === 0 ? (
        <div className="flex items-center gap-3 py-12 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin text-[#00D4FF]" />
          Loading history
        </div>
      ) : history.length === 0 ? (
        <p className="py-12 text-sm text-slate-500">
          No runs yet. Give your agent a goal on the Agent tab.
        </p>
      ) : (
        <>
          {/* Table on desktop */}
          <div className="panel hidden overflow-hidden md:block">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-[#1A7FFF]/20">
                  {['Goal', 'Status', 'Steps', 'Cost', 'When'].map((h) => (
                    <th key={h} className="heading-mono px-4 py-3 font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1A7FFF]/10">
                {history.map((task) => (
                  <tr
                    key={task.id}
                    onClick={() => setSelected(task)}
                    className="cursor-pointer transition-colors hover:bg-[#111D35]/60"
                  >
                    <td className="max-w-md truncate px-4 py-3 text-slate-200">{task.goal}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={task.status} />
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-400">
                      {task.stepsDone}/{task.stepCount}
                    </td>
                    <td className="price px-4 py-3">${usdc(task.totalCostUsdc)}</td>
                    <td className="px-4 py-3 text-slate-500">{relativeTime(task.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Cards on mobile */}
          <div className="flex flex-col gap-3 md:hidden">
            {history.map((task) => (
              <button
                key={task.id}
                onClick={() => setSelected(task)}
                className="panel-interactive p-4 text-left"
              >
                <div className="mb-2 flex items-start justify-between gap-3">
                  <span className="line-clamp-2 text-sm text-slate-200">{task.goal}</span>
                  <StatusBadge status={task.status} />
                </div>
                <div className="flex items-center gap-4 font-mono text-[11px] text-slate-500">
                  <span>
                    {task.stepsDone}/{task.stepCount} steps
                  </span>
                  <span className="text-[#00D4FF]">${usdc(task.totalCostUsdc)}</span>
                  <span>{relativeTime(task.createdAt)}</span>
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      {selected && <TaskDrawer task={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge ${STATUS_CLASS[status] ?? STATUS_CLASS['pending']}`}>{status}</span>
  )
}

function TaskDrawer({ task, onClose }: { task: TaskSummary; onClose: () => void }) {
  const [steps, setSteps] = useState<TaskStepDetail[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .task(task.id)
      .then((res) => !cancelled && setSteps(res.steps))
      .catch((err: unknown) =>
        !cancelled && setError(err instanceof Error ? err.message : 'Failed to load steps'),
      )
    return () => {
      cancelled = true
    }
  }, [task.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-[#0A0E1A]/80 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex h-full w-full max-w-lg flex-col border-l border-[#1A7FFF]/25 bg-[#0D1526]">
        <div className="flex items-start justify-between gap-4 border-b border-[#1A7FFF]/20 p-5">
          <div className="min-w-0">
            <span className="heading-mono">Run detail</span>
            <p className="mt-2 text-sm text-slate-200">{task.goal}</p>
            <div className="mt-3 flex flex-wrap items-center gap-3 font-mono text-[11px] text-slate-500">
              <StatusBadge status={task.status} />
              <span className="text-[#00D4FF]">${usdc(task.totalCostUsdc)} spent</span>
              {task.budgetUsdc !== null && <span>cap ${usdc(task.budgetUsdc)}</span>}
              <span>{relativeTime(task.createdAt)}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 text-slate-500 transition-colors hover:text-slate-200"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {error && <p className="text-sm text-[#FF4466]">{error}</p>}
          {!steps && !error && (
            <div className="flex items-center gap-3 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin text-[#00D4FF]" />
              Loading steps
            </div>
          )}
          {steps?.length === 0 && <p className="text-sm text-slate-500">No steps recorded.</p>}

          <ol className="flex flex-col gap-3">
            {steps?.map((step) => (
              <li key={step.id} className="panel p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-mono text-sm text-slate-100">{step.serviceName}</span>
                  <StatusBadge status={step.status} />
                </div>
                <p className="mt-1.5 break-all font-mono text-[11px] text-slate-600">
                  {step.httpMethod} {step.endpointUrl}
                </p>
                <div className="mt-3 flex flex-wrap gap-4 font-mono text-[11px]">
                  <span className="text-slate-500">
                    est ${usdc(step.estimatedCostUsdc)}
                  </span>
                  <span className={step.actualCostUsdc !== null ? 'text-[#00FF88]' : 'text-slate-600'}>
                    actual{' '}
                    {step.actualCostUsdc !== null ? `$${usdc(step.actualCostUsdc)}` : '—'}
                  </span>
                </div>
                {step.txRef && (
                  <p className="mt-2 break-all font-mono text-[11px] text-slate-600">
                    tx {step.txRef}
                  </p>
                )}
                {step.responseSummary && (
                  <pre className="mt-3 max-h-40 overflow-auto rounded-lg border border-[#1A7FFF]/20 bg-[#0A0E1A] p-2.5 font-mono text-[11px] text-slate-400">
                    {step.responseSummary}
                  </pre>
                )}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  )
}
