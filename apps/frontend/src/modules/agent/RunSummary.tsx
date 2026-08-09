import { CheckCircle2, OctagonAlert, RotateCcw } from 'lucide-react'
import type { RunOutcome } from '../../store/taskStore.ts'
import { usdc } from '../../lib/format.ts'

const TONE: Record<RunOutcome['kind'], { border: string; text: string }> = {
  complete: { border: 'border-[#00FF88]/40 bg-[#00FF88]/5', text: 'text-[#00FF88]' },
  stopped: { border: 'border-[#FFA040]/40 bg-[#FFA040]/5', text: 'text-[#FFA040]' },
  budget_exceeded: { border: 'border-[#FFA040]/40 bg-[#FFA040]/5', text: 'text-[#FFA040]' },
  cap_exceeded: { border: 'border-[#FFA040]/40 bg-[#FFA040]/5', text: 'text-[#FFA040]' },
  fatal: { border: 'border-[#FF4466]/40 bg-[#FF4466]/5', text: 'text-[#FF4466]' },
  error: { border: 'border-[#FF4466]/40 bg-[#FF4466]/5', text: 'text-[#FF4466]' },
}

export function RunSummary({
  outcome,
  onReset,
}: {
  outcome: RunOutcome
  onReset: () => void
}) {
  const tone = TONE[outcome.kind]
  const Icon = outcome.kind === 'complete' ? CheckCircle2 : OctagonAlert

  return (
    <div className={`rounded-xl border p-5 ${tone.border}`}>
      <div className={`flex items-center gap-2.5 ${tone.text}`}>
        <Icon className="h-4 w-4 shrink-0" />
        <span className="font-mono text-xs uppercase tracking-widest">
          {outcome.kind === 'complete' ? 'Run complete' : 'Run ended'}
        </span>
      </div>

      <p className="mt-3 text-sm text-slate-300">{outcome.message}</p>

      <div className="mt-4 flex items-baseline gap-2">
        <span className="heading-mono">Total spent</span>
        <span className="price text-lg">${usdc(outcome.totalSpent)}</span>
      </div>

      <button className="btn-ghost mt-5" onClick={onReset}>
        <RotateCcw className="h-4 w-4" />
        New goal
      </button>
    </div>
  )
}
