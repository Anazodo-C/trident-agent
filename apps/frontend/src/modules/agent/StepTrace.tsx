import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Terminal } from 'lucide-react'
import type { LiveStep } from '../../lib/types.ts'
import { usdc } from '../../lib/format.ts'
import { LiveStepCard } from './LiveStepCard.tsx'

/**
 * The step-by-step execution detail.
 *
 * Open while the run is in progress — watching the agent work is the point,
 * and a collapsed spinner would hide it. Collapsed once it finishes, because
 * from then on the answer is the summary above and this is the receipt: what
 * was called, what it cost, and the raw payload if anyone wants to check.
 */
export function StepTrace({ steps, running }: { steps: LiveStep[]; running: boolean }) {
  const [open, setOpen] = useState(running)
  const wasRunning = useRef(running)

  // Fold the trace away the moment the run ends, so the summary below it is
  // what the user is left looking at. Only on that transition — reopening it
  // by hand has to stick.
  useEffect(() => {
    if (wasRunning.current && !running) setOpen(false)
    wasRunning.current = running
  }, [running])

  const expanded = running || open

  if (steps.length === 0) return null

  const done = steps.filter((s) => s.status === 'done').length
  const failed = steps.filter((s) => s.status === 'failed').length
  const spent = steps.reduce((sum, s) => sum + (s.cost ?? 0), 0)

  return (
    <div className="flex flex-col gap-2">
      <button
        className="flex w-full items-center gap-2.5 py-1 text-left disabled:cursor-default"
        onClick={() => setOpen((v) => !v)}
        disabled={running}
        aria-expanded={expanded}
      >
        <Terminal className="h-3.5 w-3.5 shrink-0 text-slate-600" />
        <span className="heading-mono">
          {running
            ? `Running ${steps.length} ${steps.length === 1 ? 'call' : 'calls'}`
            : `${done} of ${steps.length} ${steps.length === 1 ? 'call' : 'calls'} · $${usdc(spent)}`}
          {!running && failed > 0 && <span className="text-[#FF4466]"> · {failed} failed</span>}
        </span>
        {!running && (
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-slate-600 transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
        )}
      </button>

      {expanded && (
        <div className="flex flex-col gap-2">
          {steps.map((step) => (
            <LiveStepCard key={step.stepIndex} step={step} />
          ))}
        </div>
      )}
    </div>
  )
}
