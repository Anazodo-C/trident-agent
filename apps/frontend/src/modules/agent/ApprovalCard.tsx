import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  HelpCircle,
  Play,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from 'lucide-react'
import type { ExecutionPlan, PlanStep, StepAnnotation, StepUpgrade } from '../../lib/types.ts'
import { usdc } from '../../lib/format.ts'

interface Props {
  plan: ExecutionPlan
  annotations: Record<number, StepAnnotation>
  /** Path values the goal never supplied, by original step index. */
  needsInput: Record<number, string[]>
  upgrades: StepUpgrade[]
  onApprove: (steps: PlanStep[], budgetUsdc: number | null) => void
  onCancel: () => void
}

export function ApprovalCard({
  plan,
  annotations,
  needsInput,
  upgrades,
  onApprove,
  onCancel,
}: Props) {
  const [excluded, setExcluded] = useState<Set<number>>(new Set())
  const [budgetInput, setBudgetInput] = useState('')
  /**
   * Values the user types for the {placeholders} the goal did not answer,
   * keyed by original step index then parameter name.
   *
   * The agent used to fail the run at request time, or never offer the endpoint
   * at all. Asking here costs nothing: the user is already reading the plan and
   * its price, and the value is merged into the step before it is approved.
   */
  const [filled, setFilled] = useState<Record<number, Record<string, string>>>({})

  const valueFor = (stepIndex: number, name: string) =>
    (filled[stepIndex]?.[name] ?? '').trim()

  /** Steps still missing a value, among the ones actually being run. */
  const unanswered = plan.steps.filter(
    (s) =>
      !excluded.has(s.stepIndex) &&
      (needsInput[s.stepIndex] ?? []).some((name) => valueFor(s.stepIndex, name) === ''),
  )

  const approvedSteps = useMemo(
    () =>
      plan.steps
        .filter((s) => !excluded.has(s.stepIndex))
        .map((s, i) => ({
          ...s,
          stepIndex: i,
          // Typed values join the params the planner produced. The backend
          // refuses any step that still has an unfilled placeholder, so this is
          // the only way one of these steps can run.
          params: { ...s.params, ...(filled[s.stepIndex] ?? {}) },
        })),
    [plan.steps, excluded, filled],
  )

  const estimatedTotal = approvedSteps.reduce((sum, s) => sum + s.estimatedCostUsdc, 0)

  // Counted over the plan's original indices, since annotations are keyed by them.
  const mainnetSteps = plan.steps.filter(
    (s) => !excluded.has(s.stepIndex) && annotations[s.stepIndex]?.isTestnet === false,
  ).length
  const budget = budgetInput.trim() === '' ? null : Number.parseFloat(budgetInput)
  const budgetInvalid = budget !== null && (!Number.isFinite(budget) || budget <= 0)
  const budgetTooLow = budget !== null && !budgetInvalid && budget < estimatedTotal

  if (plan.steps.length === 0) {
    return (
      <div className="panel p-5">
        <h3 className="heading-mono mb-3">No Viable Plan</h3>
        <p className="text-sm leading-relaxed text-slate-300">{plan.reasoning}</p>
        {plan.minCostUsdc !== undefined && (
          <p className="mt-3 text-sm text-slate-400">
            Minimum workable budget:{' '}
            <span className="price">${usdc(plan.minCostUsdc)}</span>
          </p>
        )}
        <button className="btn-ghost mt-5" onClick={onCancel}>
          Start over
        </button>
      </div>
    )
  }

  return (
    <div className="panel overflow-hidden">
      <div className="border-b border-[#1A7FFF]/20 px-5 py-4">
        <h3 className="heading-mono">Execution Plan</h3>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">{plan.reasoning}</p>
      </div>

      <ol className="divide-y divide-[#1A7FFF]/10">
        {plan.steps.map((step) => {
          const isExcluded = excluded.has(step.stepIndex)
          return (
            <li
              key={step.stepIndex}
              className={`flex gap-3 px-5 py-4 transition-opacity ${isExcluded ? 'opacity-35' : ''}`}
            >
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0 accent-[#00D4FF]"
                checked={!isExcluded}
                aria-label={`Include step ${step.stepIndex + 1}`}
                onChange={(e) => {
                  const next = new Set(excluded)
                  if (e.target.checked) next.delete(step.stepIndex)
                  else next.add(step.stepIndex)
                  setExcluded(next)
                }}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-mono text-sm text-slate-100">{step.serviceName}</span>
                  <span className="price text-sm">~${usdc(step.estimatedCostUsdc)}</span>
                </div>
                <p className="mt-1 text-sm text-slate-400">{step.purpose}</p>
                <p className="mt-1.5 truncate font-mono text-[11px] text-slate-600">
                  {step.httpMethod} {step.endpointUrl}
                </p>
                <MissingValues
                  names={needsInput[step.stepIndex] ?? []}
                  values={filled[step.stepIndex] ?? {}}
                  disabled={isExcluded}
                  onChange={(name, value) =>
                    setFilled((prev) => ({
                      ...prev,
                      [step.stepIndex]: { ...(prev[step.stepIndex] ?? {}), [name]: value },
                    }))
                  }
                />
                <StepProvenance annotation={annotations[step.stepIndex]} />
                <PremiumHint upgrade={upgrades.find((u) => u.stepIndex === step.stepIndex)} />
              </div>
            </li>
          )
        })}
      </ol>

      {mainnetSteps > 0 && (
        <div className="border-t border-[#1A7FFF]/20 bg-[#FFA040]/5 px-5 py-3">
          <p className="flex items-start gap-2 text-[11px] leading-relaxed text-[#FFA040]">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {mainnetSteps} step{mainnetSteps === 1 ? '' : 's'} will settle on mainnet with{' '}
              <strong className="font-semibold">real USDC</strong>. This is not a test transaction.
            </span>
          </p>
        </div>
      )}

      <div className="border-t border-[#1A7FFF]/20 px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="heading-mono">Estimated total</span>
          <span className="price text-lg">${usdc(estimatedTotal)}</span>
        </div>

        <label className="mt-4 flex flex-col gap-1.5">
          <span className="heading-mono">Budget cap (optional)</span>
          <input
            className="field font-mono"
            inputMode="decimal"
            placeholder="No cap for this run"
            value={budgetInput}
            onChange={(e) => setBudgetInput(e.target.value)}
          />
          {budgetInvalid && (
            <span className="text-xs text-[#FF4466]">Enter a positive number.</span>
          )}
          {budgetTooLow && (
            <span className="text-xs text-[#FFA040]">
              Below the estimate — the run will stop partway through.
            </span>
          )}
        </label>

        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <button
            className="btn-primary flex-1"
            disabled={approvedSteps.length === 0 || budgetInvalid || unanswered.length > 0}
            onClick={() => onApprove(approvedSteps, budget)}
          >
            <Play className="h-4 w-4" />
            Approve &amp; run
            <ArrowRight className="h-4 w-4" />
          </button>
          <button className="btn-ghost" onClick={onCancel}>
            <Ban className="h-4 w-4" />
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * The values an endpoint's URL needs that the goal never said.
 *
 * `/usstock/price/{symbol}` cannot be called without a symbol. Asking for it
 * here is the whole fix: previously the planner was never told the value
 * existed, so the call went out with the braces still in it and came back 404 —
 * and the endpoint was then judged broken and withheld from future plans.
 *
 * One input per placeholder, labelled with the name the endpoint uses, so the
 * user can see exactly what is being asked for and why.
 */
function MissingValues({
  names,
  values,
  disabled,
  onChange,
}: {
  names: string[]
  values: Record<string, string>
  disabled: boolean
  onChange: (name: string, value: string) => void
}) {
  if (names.length === 0) return null

  return (
    <div className="mt-2.5 rounded-lg border border-[#00D4FF]/30 bg-[#00D4FF]/5 p-2.5">
      <p className="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-[#00D4FF]">
        <HelpCircle className="h-3 w-3" />
        {names.length === 1 ? 'One detail needed' : `${names.length} details needed`}
      </p>
      <div className="flex flex-col gap-2">
        {names.map((name) => (
          <label key={name} className="flex flex-col gap-1">
            <span className="font-mono text-[10px] text-slate-400">{name}</span>
            <input
              className="field py-1.5 font-mono text-xs"
              value={values[name] ?? ''}
              disabled={disabled}
              placeholder={`Value for ${name}`}
              aria-label={`Value for ${name}`}
              onChange={(e) => onChange(name, e.target.value)}
            />
          </label>
        ))}
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
        This endpoint takes {names.length === 1 ? 'this' : 'these'} in its address, so the request
        cannot be built without {names.length === 1 ? 'it' : 'them'}.
      </p>
    </div>
  )
}

/**
 * Registry-sourced facts about the step, shown beside its cost. The model can
 * assert anything about a service; these come from the sync, so an endpoint
 * with no recorded traffic is visibly flagged before the user approves spending.
 */
function StepProvenance({ annotation }: { annotation: StepAnnotation | undefined }) {
  if (!annotation) return null

  return (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {annotation.trust === 'curated' && (
          <span className="badge gap-1 bg-[#00FF88]/10 text-[#00FF88]">
            <ShieldCheck className="h-3 w-3" />
            curated
          </span>
        )}
        {annotation.trust === 'active' && (
          <span className="badge gap-1 bg-[#1A7FFF]/10 text-[#1A7FFF]">
            <TrendingUp className="h-3 w-3" />
            {annotation.calls30d.toLocaleString()} calls/30d
          </span>
        )}
        {annotation.chain && (
          <span className="badge bg-slate-500/10 text-slate-400">
            {annotation.isTestnet ? 'testnet' : annotation.chain}
          </span>
        )}
      </div>

      {annotation.warning && (
        <p className="mt-2 flex items-start gap-1.5 rounded-lg border border-[#FFA040]/30 bg-[#FFA040]/5 p-2 text-[11px] leading-relaxed text-[#FFA040]">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          {annotation.warning}
        </p>
      )}

      {annotation.blockedReason && (
        <p className="mt-2 rounded-lg border border-[#FF4466]/30 bg-[#FF4466]/5 p-2 text-[11px] leading-relaxed text-[#FF4466]">
          {annotation.blockedReason}
        </p>
      )}
    </>
  )
}

/**
 * What paying would buy for a step currently using a free API.
 *
 * Advisory only — nothing here is selected, and approving the plan runs the
 * free service as planned. It exists so the choice is visible at the moment
 * cost is being considered, rather than discovered later.
 */
function PremiumHint({ upgrade }: { upgrade: StepUpgrade | undefined }) {
  if (!upgrade || upgrade.options.length === 0) return null

  return (
    <div className="mt-2 rounded-lg border border-[#1A7FFF]/25 bg-[#1A7FFF]/5 p-2.5">
      <p className="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-[#1A7FFF]">
        <Sparkles className="h-3 w-3" />
        Premium alternative — {upgrade.category}
      </p>
      <ul className="flex flex-col gap-1.5">
        {upgrade.options.map((option) => (
          <li key={option.resource} className="flex items-baseline justify-between gap-3 text-[11px]">
            <span className="min-w-0 truncate text-slate-300">
              {option.curated && <span className="mr-1 text-[#00FF88]">★</span>}
              {option.serviceName}
              <span className="ml-1.5 text-slate-600">
                {option.calls30d.toLocaleString()} calls/30d
              </span>
            </span>
            <span className="shrink-0 font-mono text-[#00D4FF]">
              ${option.priceUsdc.toFixed(4)}
            </span>
          </li>
        ))}
      </ul>
      {upgrade.options.some((o) => !o.available) && (
        <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
          Requires mainnet spending, which is off for this wallet.
        </p>
      )}
    </div>
  )
}
