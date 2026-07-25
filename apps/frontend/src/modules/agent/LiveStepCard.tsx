import { useState } from 'react'
import { AlertCircle, Check, ChevronDown, Circle, Loader2 } from 'lucide-react'
import type { LiveStep } from '../../lib/types.ts'
import { usdc } from '../../lib/format.ts'

const BORDER: Record<LiveStep['status'], string> = {
  pending: 'border-l-slate-700',
  running: 'border-l-[#00D4FF] animate-pulse',
  done: 'border-l-[#00FF88]',
  failed: 'border-l-[#FF4466]',
}

export function LiveStepCard({ step }: { step: LiveStep }) {
  const [expanded, setExpanded] = useState(false)
  const hasDetail = step.result !== undefined || Boolean(step.error)

  return (
    <div className={`panel border-l-2 ${BORDER[step.status]}`}>
      <button
        className="flex w-full items-start gap-3 px-4 py-3.5 text-left"
        onClick={() => hasDetail && setExpanded((v) => !v)}
        aria-expanded={hasDetail ? expanded : undefined}
      >
        <StatusIcon status={step.status} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-mono text-sm text-slate-100">{step.serviceName}</span>
            <CostLabel step={step} />
          </div>
          <p className="mt-0.5 text-sm text-slate-400">{step.purpose}</p>

          {step.error && (
            <p className="mt-2 break-words font-mono text-[11px] text-[#FF4466]">{step.error}</p>
          )}
          {step.txRef && (
            <p className="mt-1.5 truncate font-mono text-[11px] text-slate-600">
              tx {step.txRef}
            </p>
          )}
        </div>

        {hasDetail && (
          <ChevronDown
            className={`mt-0.5 h-4 w-4 shrink-0 text-slate-600 transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
        )}
      </button>

      {expanded && step.result !== undefined && (
        <pre className="mx-4 mb-4 max-h-64 overflow-auto rounded-lg border border-[#1A7FFF]/20 bg-[#0A0E1A] p-3 font-mono text-[11px] leading-relaxed text-slate-400">
          {safeStringify(step.result)}
        </pre>
      )}
    </div>
  )
}

function StatusIcon({ status }: { status: LiveStep['status'] }) {
  if (status === 'running') {
    return <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-[#00D4FF]" />
  }
  if (status === 'done') return <Check className="mt-0.5 h-4 w-4 shrink-0 text-[#00FF88]" />
  if (status === 'failed') {
    return <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#FF4466]" />
  }
  return <Circle className="mt-0.5 h-4 w-4 shrink-0 text-slate-700" />
}

function CostLabel({ step }: { step: LiveStep }) {
  if (step.status === 'done') {
    return (
      <span className="font-mono text-sm text-[#00FF88]">${usdc(step.cost ?? 0, 3)}</span>
    )
  }
  if (step.status === 'failed') return <span className="font-mono text-sm text-slate-600">—</span>
  return (
    <span className="font-mono text-sm text-slate-500">~${usdc(step.estimatedCostUsdc, 3)}</span>
  )
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}
