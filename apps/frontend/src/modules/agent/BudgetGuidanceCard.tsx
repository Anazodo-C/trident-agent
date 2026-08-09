import { useState } from 'react'
import { CircleDollarSign, Gauge, Loader2, RotateCcw, ShieldCheck, Wallet } from 'lucide-react'
import type { BudgetGuidance, BudgetOption } from '../../lib/types.ts'
import { usdc } from '../../lib/format.ts'

/**
 * Shown when the goal costs more than the user's limit.
 *
 * The cap is theirs and is never adjusted for them — not by the planner, not by
 * the runner, not by this card. What it does is quote the work: what the
 * cheapest route to the goal actually costs, what a more reliable route costs
 * when one exists, and the smallest cap that would permit each. Raising the cap
 * stays a deliberate act, taken here or in the Wallet tab, and it always leads
 * back through a fresh plan and the normal approval card.
 */
interface Props {
  guidance: BudgetGuidance
  /**
   * Called with the amount the limit must reach. `raiseCap` distinguishes the
   * two blockers: the account cap, which is a lasting change, versus a
   * per-run budget, which only applies to this attempt.
   */
  onProceed: (option: BudgetOption, raiseCap: boolean) => Promise<void>
  onCancel: () => void
}

export function BudgetGuidanceCard({ guidance, onProceed, onCancel }: Props) {
  const [pending, setPending] = useState<string | null>(null)

  const proceed = async (option: BudgetOption): Promise<void> => {
    setPending(option.kind)
    try {
      // Only a route that also exceeds the account cap needs the cap raised.
      // Otherwise the tighter per-run budget is the only thing in the way.
      await onProceed(option, option.minimumCapUsdc > guidance.capUsdc)
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="rounded-xl border border-[#FFA040]/40 bg-[#FFA040]/5 p-5">
      <div className="flex items-center gap-2.5 text-[#FFA040]">
        <CircleDollarSign className="h-4 w-4 shrink-0" />
        <span className="font-mono text-xs uppercase tracking-widest">Over your limit</span>
      </div>

      <p className="mt-3 text-sm leading-relaxed text-slate-300">{guidance.message}</p>

      {guidance.options.length === 0 ? (
        <p className="mt-3 text-sm text-slate-400">
          Nothing in the catalog can be priced for this goal, so there is no amount that would
          make it run.
        </p>
      ) : (
        <>
          <div className="mt-4 flex flex-col gap-2.5">
            {guidance.options.map((option) => (
              <OptionRow
                key={option.kind}
                option={option}
                capUsdc={guidance.capUsdc}
                pending={pending === option.kind}
                disabled={pending !== null}
                onProceed={() => void proceed(option)}
              />
            ))}
          </div>

          <p className="mt-4 flex items-start gap-2 text-[11px] leading-relaxed text-slate-500">
            <Wallet className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              Either way the goal is re-planned and you come back to the usual approval card —
              nothing is spent until you approve it there. You can also change your cap yourself
              in the Wallet tab.
            </span>
          </p>
        </>
      )}

      <button className="btn-ghost mt-5" onClick={onCancel} disabled={pending !== null}>
        <RotateCcw className="h-4 w-4" />
        New goal
      </button>
    </div>
  )
}

function OptionRow({
  option,
  capUsdc,
  pending,
  disabled,
  onProceed,
}: {
  option: BudgetOption
  capUsdc: number
  pending: boolean
  disabled: boolean
  onProceed: () => void
}) {
  const isCheapest = option.kind === 'cheapest'
  // The route may fit the account cap and be blocked only by a tighter per-run
  // budget. Offering to raise the cap there would change the wrong number and
  // still not run the goal.
  const needsCapRaise = option.minimumCapUsdc > capUsdc

  return (
    <div className="rounded-lg border border-[#1A7FFF]/20 bg-[#0A0E1A]/60 p-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-widest text-slate-400">
          {isCheapest ? (
            <CircleDollarSign className="h-3 w-3 text-[#00D4FF]" />
          ) : (
            <ShieldCheck className="h-3 w-3 text-[#00FF88]" />
          )}
          {isCheapest ? 'Cheapest' : 'More reliable'}
        </span>
        <span className="price text-base">${usdc(option.totalUsdc)}</span>
      </div>

      <p className="mt-1.5 font-mono text-sm text-slate-200">{option.services}</p>
      <p className="mt-1 text-sm leading-relaxed text-slate-400">{option.rationale}</p>

      <div className="mt-2.5 flex items-center gap-1.5 text-[11px] text-slate-500">
        <Gauge className="h-3 w-3 shrink-0" />
        {/* From the registry's trust tier and 30-day usage — not the model's opinion. */}
        <span>Reliability {option.quality}/100</span>
      </div>

      <button className="btn-ghost mt-3" onClick={onProceed} disabled={disabled}>
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />}
        {needsCapRaise
          ? `Set my cap to $${usdc(option.minimumCapUsdc)} and re-plan`
          : `Re-plan with a $${usdc(option.minimumCapUsdc)} budget`}
      </button>
      {!needsCapRaise && (
        <p className="mt-1.5 text-[11px] text-slate-600">
          Within your ${usdc(capUsdc)} cap — only this run's budget is in the way.
        </p>
      )}
    </div>
  )
}
