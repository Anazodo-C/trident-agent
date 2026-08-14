import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Loader2, RotateCcw, Send, Sparkles } from 'lucide-react'
import { api } from '../../lib/api.ts'
import { streamAgentRun, type AgentEventName } from '../../lib/sseClient.ts'
import { useAgentStore } from '../../store/agentStore.ts'
import { useAuthStore } from '../../store/authStore.ts'
import { useTaskStore } from '../../store/taskStore.ts'
import type { LiveStep, PlanStep } from '../../lib/types.ts'
import { ApprovalCard } from './ApprovalCard.tsx'
import { BudgetGuidanceCard } from './BudgetGuidanceCard.tsx'
import { ExpenseTracker } from './ExpenseTracker.tsx'
import { ChatBubble, ChatThinking, PlanOffer } from './ChatBubble.tsx'
import { StepTrace } from './StepTrace.tsx'
import { RunSummary } from './RunSummary.tsx'

const EXAMPLE_PROMPTS = [
  'Verify my agent wallet can pay an x402 endpoint',
  'Research the top 3 competitors to Stripe and summarise their funding',
  'Analyse social sentiment around the Arc mainnet launch',
  'Find recent onchain activity for the USDC contract on Base',
]

export function AgentTab() {
  const location = useLocation()
  const token = useAuthStore((s) => s.token)
  const unlockedKey = useAgentStore((s) => s.unlockedKey)
  const requestUnlock = useAgentStore((s) => s.requestUnlock)

  const store = useTaskStore()
  const {
    phase,
    plan,
    taskId,
    liveSteps,
    totalSpent,
    outcome,
    error,
    budgetUsdc,
    budgetGuidance,
    stopping,
    messages,
    chatPending,
    suggestedGoal,
  } = store

  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  // "Use →" on the Endpoints page routes here with a prefilled goal.
  useEffect(() => {
    const prefill = (location.state as { prefill?: string } | null)?.prefill
    if (prefill) setInput(prefill)
  }, [location.state])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [liveSteps, phase, messages, chatPending])

  // Abort any in-flight stream if the user navigates away mid-run.
  useEffect(() => {
    return () => {
      useTaskStore.getState().abortController?.abort()
    }
  }, [])

  const submitGoal = useCallback(
    async (goal: string) => {
      const trimmed = goal.trim()
      if (!trimmed) return
      setInput('')
      useTaskStore.getState().startPlanning(trimmed)
      try {
        const res = await api.plan(trimmed, useTaskStore.getState().budgetUsdc ?? undefined)
        useTaskStore
          .getState()
          .planReady(
            res.taskId,
            res.plan,
            res.annotations,
            res.needsInput ?? {},
            res.upgrades,
            res.budgetGuidance,
          )
      } catch (err) {
        useTaskStore
          .getState()
          .planFailed(err instanceof Error ? err.message : 'Planning failed')
      }
    },
    [],
  )

  /**
   * A follow-up about the run that just finished. This never spends anything:
   * the backend answers from the data already fetched, or hands back a goal to
   * plan, which still goes through the approval card like any other run.
   */
  const submitFollowUp = useCallback(async (message: string) => {
    const trimmed = message.trim()
    const currentTaskId = useTaskStore.getState().taskId
    if (!trimmed || !currentTaskId) return
    setInput('')

    const s = useTaskStore.getState()
    s.setSuggestedGoal(null)
    s.addMessage({
      id: `local-${Date.now()}`,
      taskId: currentTaskId,
      role: 'user',
      content: trimmed,
      kind: 'text',
      createdAt: Math.floor(Date.now() / 1000),
    })
    s.setChatPending(true)

    try {
      const res = await api.chat(currentTaskId, trimmed)
      useTaskStore.getState().addMessage(res.agentMessage)
      if (res.needsRun && res.suggestedGoal) {
        useTaskStore.getState().setSuggestedGoal(res.suggestedGoal)
      }
    } catch (err) {
      useTaskStore.getState().addMessage({
        id: `local-err-${Date.now()}`,
        taskId: currentTaskId,
        role: 'agent',
        content: err instanceof Error ? err.message : 'That follow-up failed.',
        kind: 'text',
        createdAt: Math.floor(Date.now() / 1000),
      })
    } finally {
      useTaskStore.getState().setChatPending(false)
    }
  }, [])

  // One input serves both: a new goal starts a run, anything typed after a run
  // finishes is a follow-up about it.
  const canFollowUp = phase === 'finished' && Boolean(taskId)
  const handleSubmit = useCallback(
    (text: string) => {
      if (canFollowUp) void submitFollowUp(text)
      else void submitGoal(text)
    },
    [canFollowUp, submitFollowUp, submitGoal],
  )

  /**
   * Lift whichever limit is actually blocking a quoted route, then re-plan.
   *
   * Only ever reached by the user clicking the amount on the guidance card, so no
   * code path adjusts a limit on its own. Raising the account cap is a lasting
   * change and is only done when the cap is the blocker; a tighter per-run
   * budget is loosened for this attempt alone. Either way the re-plan lands on
   * the normal approval card, so nothing is spent by doing this.
   */
  const proceedPastLimit = useCallback(
    async (option: { minimumCapUsdc: number }, raiseCap: boolean) => {
      const goal = useTaskStore.getState().goal
      if (raiseCap) {
        await api.setSpendingCap(option.minimumCapUsdc)
        await useAuthStore.getState().refreshUser()
      }
      useTaskStore.getState().setBudget(option.minimumCapUsdc)
      await submitGoal(goal)
    },
    [],
  )

  const runApproved = useCallback(
    async (approvedSteps: PlanStep[], budget: number | null) => {
      const currentTaskId = useTaskStore.getState().taskId
      if (!currentTaskId || !token) return

      const key = useAgentStore.getState().unlockedKey
      if (!key) {
        requestUnlock(() => void runApproved(approvedSteps, budget))
        return
      }

      const initialSteps: LiveStep[] = approvedSteps.map((s) => ({
        stepIndex: s.stepIndex,
        serviceName: s.serviceName,
        endpointUrl: s.endpointUrl,
        purpose: s.purpose,
        estimatedCostUsdc: s.estimatedCostUsdc,
        status: 'pending',
      }))

      const controller = new AbortController()
      useTaskStore.getState().beginRun(initialSteps, controller)

      try {
        await streamAgentRun(
          { taskId: currentTaskId, approvedSteps, agentPrivateKey: key, budgetUsdc: budget },
          token,
          handleEvent,
          controller.signal,
        )
        // A stream that ends without a terminal event still needs to settle the UI.
        if (useTaskStore.getState().phase === 'running') {
          useTaskStore.getState().finishRun({
            kind: 'complete',
            message: 'Run finished.',
            totalSpent: useTaskStore.getState().totalSpent,
          })
        }
      } catch (err) {
        if (controller.signal.aborted) return
        const guidance = (err as { budgetGuidance?: unknown })?.budgetGuidance
        if (guidance) {
          // The cap refused this plan before anything ran, so there is no run
          // to report on, so go back to the quote.
          useTaskStore.getState().setBudgetGuidance(guidance as never)
          useTaskStore.setState({ phase: 'awaiting-approval' })
          return
        }
        useTaskStore.getState().finishRun({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Run failed',
          totalSpent: useTaskStore.getState().totalSpent,
        })
      } finally {
        void useTaskStore.getState().loadHistory()
      }
    },
    [token, requestUnlock],
  )

  function handleEvent(event: AgentEventName, data: Record<string, unknown>) {
    const s = useTaskStore.getState()
    const spent = typeof data['totalSpent'] === 'number' ? data['totalSpent'] : s.totalSpent
    const index = typeof data['stepIndex'] === 'number' ? data['stepIndex'] : -1

    switch (event) {
      case 'start':
        break
      case 'step_start':
        s.patchStep(index, { status: 'running' })
        break
      case 'step_done':
        s.patchStep(index, {
          status: 'done',
          cost: typeof data['cost'] === 'number' ? data['cost'] : 0,
          txRef: typeof data['txRef'] === 'string' ? data['txRef'] : undefined,
          result: data['result'],
        })
        s.setTotalSpent(spent)
        break
      case 'step_replayed':
        // Same visual state as a completed step, flagged so the cost is shown
        // as carried over rather than charged again on this attempt.
        s.patchStep(index, {
          status: 'done',
          replayed: true,
          cost: typeof data['cost'] === 'number' ? data['cost'] : 0,
          txRef: typeof data['txRef'] === 'string' ? data['txRef'] : undefined,
          result: data['result'],
        })
        s.setTotalSpent(spent)
        break
      case 'step_failed':
        s.patchStep(index, {
          status: 'failed',
          error: typeof data['error'] === 'string' ? data['error'] : 'Step failed',
        })
        s.setTotalSpent(spent)
        break
      case 'summary': {
        // From the store, not the closure: runApproved is memoised on [token,
        // requestUnlock], so the handleEvent it captured can hold a taskId from
        // before the plan existed, and the summary would be dropped.
        const id = s.taskId
        if (typeof data['summary'] === 'string' && id) s.addSummary(id, data['summary'])
        break
      }
      case 'complete':
        s.finishRun({ kind: 'complete', message: 'All steps completed.', totalSpent: spent })
        break
      case 'stopped':
        s.finishRun({ kind: 'stopped', message: 'Agent stopped by you.', totalSpent: spent })
        break
      case 'budget_exceeded':
        s.finishRun({
          kind: 'budget_exceeded',
          message: `Stopped: the next step would exceed your $${fmt(data['budgetUsdc'])} budget.`,
          totalSpent: spent,
        })
        break
      case 'cap_exceeded':
        s.finishRun({
          kind: 'cap_exceeded',
          message: `Stopped: the next step would exceed your $${fmt(data['spendingCapUsdc'])} account spending cap.`,
          totalSpent: spent,
        })
        break
      case 'fatal':
      case 'error':
        s.finishRun({
          kind: event,
          message: typeof data['error'] === 'string' ? data['error'] : 'Run failed',
          totalSpent: spent,
        })
        break
    }
  }

  async function stopAgent() {
    if (!taskId) return
    useTaskStore.getState().setStopping(true)
    try {
      await api.stop(taskId)
    } catch {
      useTaskStore.getState().setStopping(false)
    }
  }

  const showEmptyState = phase === 'idle' && !error

  const trackerProps = {
    budgetUsdc,
    totalSpent,
    steps: liveSteps,
    running: phase === 'running',
    stopping,
    onStop: stopAgent,
  }

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
          <div className="mx-auto w-full max-w-3xl">
            {showEmptyState && (
              <EmptyState onPick={(p) => setInput(p)} onSubmit={submitGoal} />
            )}

            {/* The goal opens the transcript; everything the agent says comes
                after the plan and the run, further down. */}
            {messages[0] && (
              <div className="mb-6">
                <ChatBubble message={messages[0]} />
              </div>
            )}

            {error && (
              <div className="mb-6 rounded-xl border border-[#FF4466]/40 bg-[#FF4466]/10 p-4 text-sm text-[#FF4466]">
                {error}
              </div>
            )}

            {phase === 'planning' && (
              <div className="flex items-center gap-3 text-sm text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin text-[#00D4FF]" />
                <span className="font-mono text-xs uppercase tracking-widest">
                  Scouting the marketplace
                </span>
              </div>
            )}

            {/* Over the cap: quote the work, never approve it. The cap holds. */}
            {phase === 'awaiting-approval' && budgetGuidance && (
              <BudgetGuidanceCard
                guidance={budgetGuidance}
                onProceed={proceedPastLimit}
                onCancel={store.reset}
              />
            )}

            {phase === 'awaiting-approval' && plan && !budgetGuidance && (
              <ApprovalCard
                plan={plan}
                annotations={store.annotations}
                needsInput={store.needsInput}
                upgrades={store.upgrades}
                onApprove={runApproved}
                onCancel={store.reset}
              />
            )}

            {(phase === 'running' || phase === 'finished') && (
              <div className="flex flex-col gap-5">
                <StepTrace steps={liveSteps} running={phase === 'running'} />

                {/* The write-up and every follow-up since. */}
                {messages.slice(1).map((message) => (
                  <ChatBubble key={message.id} message={message} />
                ))}

                {chatPending && <ChatThinking />}

                {suggestedGoal && !chatPending && (
                  <PlanOffer goal={suggestedGoal} onPlan={submitGoal} />
                )}

                {/* A clean finish needs no banner, the write-up is the result,
                    and the cost sits in the trace header. Anything else did not
                    go to plan and has to be stated outright. */}
                {outcome && outcome.kind !== 'complete' && (
                  <RunSummary outcome={outcome} onReset={store.reset} />
                )}

                {phase === 'finished' && outcome?.kind === 'complete' && (
                  <button className="btn-ghost self-start" onClick={store.reset}>
                    <RotateCcw className="h-4 w-4" />
                    New goal
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Below lg the tracker is a strip between the transcript and the input. */}
        <ExpenseTracker {...trackerProps} variant="strip" />

        <ChatInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          disabled={phase === 'planning' || phase === 'running' || chatPending}
          locked={!unlockedKey && !canFollowUp}
          followUp={canFollowUp}
        />
      </section>

      <ExpenseTracker {...trackerProps} variant="panel" />
    </div>
  )
}

function fmt(value: unknown): string {
  return typeof value === 'number' ? value.toFixed(2) : '—'
}

function EmptyState({
  onPick,
  onSubmit,
}: {
  onPick: (prompt: string) => void
  onSubmit: (goal: string) => void
}) {
  return (
    <div className="flex flex-col items-center pt-8 text-center sm:pt-16">
      <Sparkles className="mb-5 h-8 w-8 text-[#00D4FF]" />
      <h1 className="font-mono text-xl uppercase tracking-widest text-slate-100 sm:text-2xl">
        What can I do for you today?
      </h1>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-slate-400">
        Describe a goal. Trident scouts x402 services, shows you a costed plan, and
        executes it from your agent wallet once you approve.
      </p>

      <div className="mt-8 grid w-full max-w-2xl gap-2 sm:grid-cols-2">
        {EXAMPLE_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            onClick={() => {
              onPick(prompt)
              onSubmit(prompt)
            }}
            className="panel-interactive px-4 py-3 text-left text-sm text-slate-300"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  )
}

function ChatInput({
  value,
  onChange,
  onSubmit,
  disabled,
  locked,
  followUp,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: (goal: string) => void
  disabled: boolean
  locked: boolean
  /** After a run, the same box asks about the results instead of starting one. */
  followUp: boolean
}) {
  return (
    <div className="shrink-0 border-t border-[#1A7FFF]/20 bg-[#0A0E1A]/90 px-4 py-4 backdrop-blur-md sm:px-6">
      <form
        className="mx-auto flex w-full max-w-3xl items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit(value)
        }}
      >
        <textarea
          className="field max-h-40 min-h-[46px] resize-none"
          rows={1}
          // A long placeholder wraps and gets clipped at one row on narrow
          // screens, so the hint about unlocking lives above the input instead.
          placeholder={followUp ? 'Ask about this, or start a new goal…' : 'Describe a goal…'}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              onSubmit(value)
            }
          }}
        />
        <button type="submit" className="btn-primary h-[46px] px-4" disabled={disabled || !value.trim()}>
          {disabled ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </button>
      </form>

      {locked && (
        <p className="mx-auto mt-2 w-full max-w-3xl text-[11px] text-slate-600">
          You will be asked to unlock your agent wallet before anything is spent.
        </p>
      )}
    </div>
  )
}
