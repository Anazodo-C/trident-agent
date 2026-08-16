import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import db, { type TaskRow, type TaskStepRow } from '../db.ts'
import { asyncRoute, httpError } from '../http.ts'
import { currentUser, requireAuth } from '../auth/jwt.ts'
import { buildPlan, StepSchema, type PlanStep, type StepAnnotation } from '../llm/planner.ts'
import { missingPathParams } from '../circle/pathParams.ts'
import { findServiceByResource } from '../circle/registryService.ts'
import { selectCandidates } from '../circle/candidateService.ts'
import { chooseChain, policyFor, unpayableReason } from '../circle/chainPolicy.ts'
import { formatUsdc } from '../money.ts'
import {
  describeRoute,
  effectiveCeiling,
  priceRoute,
  type RouteCost,
} from '../circle/routeCosting.ts'
import { findUpgrades } from '../circle/upgradeService.ts'
import { runTask, type CompletedStep } from '../agent/runner.ts'
import { findUserById } from '../auth/users.ts'
import { walletForChain } from '../circle/circleWallets.ts'
import { answerFollowUp } from '../llm/responder.ts'
import {
  appendMessage,
  historyForTask,
  messagesForTask,
  runContextFor,
} from '../agent/conversation.ts'

const router = Router()

const PLAN_WINDOW_SECONDS = 3600
const PLAN_MAX_PER_WINDOW = 20

function assertPlanRateLimit(userId: string): void {
  const now = Math.floor(Date.now() / 1000)
  const row = db
    .prepare('SELECT plan_count, window_start FROM rate_limits WHERE user_id = ?')
    .get(userId) as { plan_count: number; window_start: number } | undefined

  if (!row) {
    db.prepare('INSERT INTO rate_limits (user_id, plan_count, window_start) VALUES (?, 1, ?)').run(
      userId,
      now,
    )
    return
  }
  if (now - row.window_start > PLAN_WINDOW_SECONDS) {
    db.prepare('UPDATE rate_limits SET plan_count = 1, window_start = ? WHERE user_id = ?').run(
      now,
      userId,
    )
    return
  }
  if (row.plan_count >= PLAN_MAX_PER_WINDOW) {
    throw httpError(429, `Rate limit: ${PLAN_MAX_PER_WINDOW} plans per hour`)
  }
  db.prepare('UPDATE rate_limits SET plan_count = plan_count + 1 WHERE user_id = ?').run(userId)
}

const PlanBody = z.object({
  goal: z.string().min(3, 'Goal must be at least 3 characters').max(2000),
  budgetUsdc: z.number().positive().optional(),
})

router.post(
  '/plan',
  requireAuth,
  asyncRoute(async (req, res) => {
    const user = currentUser(req)
    const parsed = PlanBody.safeParse(req.body)
    if (!parsed.success) {
      throw httpError(400, parsed.error.issues[0]?.message ?? 'Invalid request body')
    }

    assertPlanRateLimit(user.id)

    const { goal, budgetUsdc } = parsed.data

    const fresh = findUserById(user.id)
    if (!fresh) throw httpError(401, 'User no longer exists')
    const policy = policyFor(fresh)

    // The registry holds ~14k services, far past what fits in a prompt, so a
    // shortlist is retrieved for this goal and only that reaches the model.
    const candidates = selectCandidates(goal, { chains: policy.allowed })
    const ceilingUsdc = effectiveCeiling(fresh.spending_cap_usdc, budgetUsdc)
    const plan = await buildPlan(goal, candidates.services, {
      capUsdc: fresh.spending_cap_usdc,
      budgetUsdc,
    })

    // Priced from the registry rather than from the plan's own estimates: the
    // cap is absolute, so what it is measured against must be what the runner
    // will actually be charged.
    const primaryCost = priceRoute(plan.steps)
    const alternativeCost = plan.alternativeRoute
      ? priceRoute(plan.alternativeRoute.steps)
      : null

    // Three distinct outcomes, and they must not be conflated. No steps at all
    // means nothing in the catalog can do this — a capability problem, which
    // the plan's own reasoning already explains, and quoting a budget for it
    // would tell the user to raise a limit that was never the obstacle.
    const planned = plan.steps.length > 0
    const affordable = planned && primaryCost.totalUsdc <= ceilingUsdc
    const guidance = !planned || affordable
      ? null
      : buildBudgetGuidance({
          ceilingUsdc,
          capUsdc: fresh.spending_cap_usdc,
          budgetUsdc: budgetUsdc ?? null,
          cheapest:
            plan.steps.length > 0
              ? { steps: plan.steps, cost: primaryCost, rationale: plan.reasoning }
              : null,
          reliable:
            plan.alternativeRoute && alternativeCost
              ? {
                  steps: plan.alternativeRoute.steps,
                  cost: alternativeCost,
                  rationale: plan.alternativeRoute.rationale,
                }
              : null,
        })

    // Annotate from the registry rather than trusting the model's claims, so
    // the approval card can warn about endpoints with no recorded usage.
    const annotations: Record<number, StepAnnotation> = {}
    /**
     * Path values the goal never supplied, per step.
     *
     * A `{symbol}` the user did not state is not a reason to drop the endpoint
     * or to guess — it is a question, and the approval card is where it gets
     * asked. The user is already there reading the price, and answering costs
     * nothing extra; previously the run simply failed at request time, or the
     * endpoint was quietly judged unfillable and never offered.
     */
    const needsInput: Record<number, string[]> = {}
    for (const step of plan.steps) {
      const service = findServiceByResource(step.endpointUrl)
      if (!service) continue

      const missing = missingPathParams(step.endpointUrl, step.params ?? {})
      if (missing.length > 0) needsInput[step.stepIndex] = missing

      // The catalog knows the verb; the model was guessing. A mismatch here
      // reaches the endpoint as a 405 and burns the run, so the registry wins.
      if (step.httpMethod !== service.httpMethod) {
        step.httpMethod = service.httpMethod
      }
      const choice = chooseChain(service.networks, policy, {
        gatewayOnly: service.source === 'x402',
      })
      annotations[step.stepIndex] = {
        trust: service.trust,
        calls30d: service.calls30d,
        host: service.host,
        chain: choice?.chain ?? null,
        isTestnet: choice?.isTestnet ?? false,
        ...(choice ? {} : { blockedReason: unpayableReason(service.networks, policy, { gatewayOnly: service.source === 'x402' }) ?? undefined }),
        ...(service.trust === 'untested'
          ? { warning: 'No recorded usage in the last 30 days — this endpoint may not respond.' }
          : {}),
      }
    }

    const taskId = randomUUID()
    const insertTask = db.prepare(
      'INSERT INTO tasks (id, user_id, goal, status, budget_usdc) VALUES (?, ?, ?, ?, ?)',
    )
    const insertStep = db.prepare(
      `INSERT INTO task_steps
        (id, task_id, step_index, service_name, endpoint_url, http_method, params, estimated_cost_usdc, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    )

    // An unaffordable plan is a quote, not something to approve — the steps are
    // not persisted, so there is nothing the user could accidentally run.
    const approvableSteps = affordable ? plan.steps : []

    db.transaction(() => {
      insertTask.run(taskId, user.id, goal, 'pending', budgetUsdc ?? null)
      for (const step of approvableSteps) {
        insertStep.run(
          randomUUID(),
          taskId,
          step.stepIndex,
          step.serviceName,
          step.endpointUrl,
          step.httpMethod,
          JSON.stringify(step.params),
          step.estimatedCostUsdc,
        )
      }
    })()

    // Advisory only: what paying would buy, for the free steps in this plan.
    // Nothing is substituted and nothing is pre-selected.
    const upgrades = findUpgrades(approvableSteps, policy)

    res.json({
      taskId,
      plan: { ...plan, steps: approvableSteps },
      annotations,
      needsInput,
      upgrades,
      // Registry-priced totals, so the card never quotes the model's estimate.
      costing: {
        ceilingUsdc,
        capUsdc: fresh.spending_cap_usdc,
        primaryUsdc: primaryCost.totalUsdc,
        alternativeUsdc: alternativeCost?.totalUsdc ?? null,
      },
      affordable,
      budgetGuidance: guidance,
      candidatesConsidered: candidates.services.length,
      usedFallback: candidates.fallback,
      mainnetEnabled: policy.mainnetEnabled,
    })
  }),
)

/**
 * What the user needs in order to do this, when their limit will not cover it.
 *
 * The cap is never adjusted and never negotiated — this quotes what each route
 * would cost and the smallest cap that would permit it, and leaves the decision
 * with the user. Two options at most: the cheapest way to accomplish the goal,
 * and a more reliable way when one genuinely exists and costs more.
 */
export interface BudgetOption {
  kind: 'cheapest' | 'reliable'
  totalUsdc: number
  /** The cap the user would have to set for this route to run. */
  minimumCapUsdc: number
  /** 0–100, from the registry's trust tier and recorded usage. */
  quality: number
  services: string
  rationale: string
  steps: PlanStep[]
}

export interface BudgetGuidance {
  capUsdc: number
  budgetUsdc: number | null
  ceilingUsdc: number
  /** Low and high ends of what this goal costs, across the offered options. */
  rangeUsdc: { min: number; max: number } | null
  options: BudgetOption[]
  message: string
}

function buildBudgetGuidance(input: {
  ceilingUsdc: number
  capUsdc: number
  budgetUsdc: number | null
  cheapest: { steps: PlanStep[]; cost: RouteCost; rationale: string } | null
  reliable: { steps: PlanStep[]; cost: RouteCost; rationale: string } | null
}): BudgetGuidance {
  const { ceilingUsdc, capUsdc, budgetUsdc } = input
  const options: BudgetOption[] = []

  const push = (
    kind: BudgetOption['kind'],
    route: { steps: PlanStep[]; cost: RouteCost; rationale: string } | null,
  ): void => {
    if (!route || route.steps.length === 0) return
    // A route referencing something the registry does not know cannot be
    // priced honestly, so it is not quoted at all.
    if (route.cost.uncatalogued.length > 0) return
    options.push({
      kind,
      totalUsdc: route.cost.totalUsdc,
      minimumCapUsdc: route.cost.minimumCapUsdc,
      quality: route.cost.quality,
      services: describeRoute(route.steps),
      rationale: route.rationale,
      steps: route.steps,
    })
  }

  push('cheapest', input.cheapest)
  // Only worth showing if it is actually better; a pricier route that is no
  // more reliable is not an option, it is a worse deal.
  if (
    input.reliable &&
    (!input.cheapest || input.reliable.cost.quality > input.cheapest.cost.quality)
  ) {
    push('reliable', input.reliable)
  }

  const totals = options.map((o) => o.totalUsdc)
  const rangeUsdc =
    totals.length > 0 ? { min: Math.min(...totals), max: Math.max(...totals) } : null

  const limitLabel =
    budgetUsdc !== null && budgetUsdc < capUsdc
      ? `Your budget for this run is $${formatUsdc(ceilingUsdc)}`
      : `Your spending cap is $${formatUsdc(ceilingUsdc)}`

  let message: string
  if (options.length === 0) {
    message = `${limitLabel}, and no route to this goal could be priced against the catalog.`
  } else if (options.length === 1) {
    message = `${limitLabel}. The cheapest route that does this costs $${formatUsdc(options[0]!.totalUsdc)}.`
  } else {
    message =
      `${limitLabel}. The cheapest route costs $${formatUsdc(rangeUsdc!.min)}; ` +
      `a more reliable one costs $${formatUsdc(rangeUsdc!.max)}.`
  }

  return { capUsdc, budgetUsdc, ceilingUsdc, rangeUsdc, options, message }
}

const RunBody = z.object({
  taskId: z.string().uuid(),
  approvedSteps: z.array(StepSchema).min(1, 'At least one step is required'),
  budgetUsdc: z.number().positive().nullable().optional(),
})

router.post(
  '/run',
  requireAuth,
  asyncRoute(async (req, res) => {
    const user = currentUser(req)
    const parsed = RunBody.safeParse(req.body)
    if (!parsed.success) {
      throw httpError(400, parsed.error.issues[0]?.message ?? 'Invalid request body')
    }
    // Destructured but never logged and never written to the DB.
    const { taskId, approvedSteps, budgetUsdc } = parsed.data

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined
    if (!task || task.user_id !== user.id) throw httpError(404, 'Task not found')
    if (task.status === 'running') throw httpError(409, 'This task is already running')
    // A completed run is final — re-running would charge twice for work already
    // delivered. A failed or stopped one is retryable: the usual cause is an
    // unfunded wallet or a flaky endpoint, and forcing a re-plan there would
    // charge another LLM call to reproduce a plan the user already approved.
    if (task.status === 'done') throw httpError(409, 'This task has already completed')

    const rogue = approvedSteps.find((s) => findServiceByResource(s.endpointUrl) === null)
    if (rogue) throw httpError(400, `Endpoint is not in the service catalog: ${rogue.endpointUrl}`)

    /*
     * A path value the approval card asked for and did not get.
     *
     * The card blocks on this, so reaching here means the request did not come
     * from it. Refused before any payment rather than at request time, which is
     * after the money has authorised — the same reason the chain check below
     * runs here instead of inside the runner.
     */
    for (const step of approvedSteps) {
      const missing = missingPathParams(step.endpointUrl, step.params ?? {})
      if (missing.length > 0) {
        throw httpError(
          400,
          `${step.serviceName} needs ${missing.join(', ')} to build its request. ` +
            'Nothing was charged.',
        )
      }
    }

    const fresh = findUserById(user.id)
    /*
     * A wallet for the chain the free tier meters on. Gated here rather than
     * per step so a run refuses before it starts, and keyed on the Circle
     * wallet: this tested `eoa_address` until signup stopped writing one, which
     * refused every new account's very first run.
     */
    if (!fresh?.circle_wallet_id_testnet && !fresh?.circle_wallet_id) {
      throw httpError(409, 'No agent wallet has been set up for this account')
    }

    // Reject the whole run if any step needs a chain the user has not enabled,
    // rather than discovering it mid-execution after money has already moved.
    const policy = policyFor(fresh)
    for (const step of approvedSteps) {
      const service = findServiceByResource(step.endpointUrl)!
      if (!chooseChain(service.networks, policy, { gatewayOnly: service.source === 'x402' })) {
        throw httpError(
          403,
          `${step.serviceName}: ${unpayableReason(service.networks, policy, { gatewayOnly: service.source === 'x402' }) ?? 'no permitted settlement network'}`,
        )
      }
    }

    /**
     * The cap is absolute, so it is enforced before anything runs.
     *
     * The runner also checks it before every step, which is what stops a run
     * that drifts over mid-flight. But that gate fires after earlier steps have
     * already been paid for. Approved steps arrive from the client and can be
     * edited, so the total is re-priced here from the registry and refused
     * outright — the cap is never raised to fit the plan, the plan is refused
     * for not fitting the cap.
     */
    const ceilingUsdc = effectiveCeiling(fresh.spending_cap_usdc, budgetUsdc ?? task.budget_usdc)
    const cost = priceRoute(approvedSteps)
    if (cost.totalUsdc > ceilingUsdc) {
      const guidance = buildBudgetGuidance({
        ceilingUsdc,
        capUsdc: fresh.spending_cap_usdc,
        budgetUsdc: budgetUsdc ?? task.budget_usdc ?? null,
        cheapest: { steps: approvedSteps, cost, rationale: 'The plan as approved.' },
        reliable: null,
      })
      // Answered directly rather than thrown: the guidance is the useful part
      // of this response, and the shared error handler only forwards a message.
      res.status(403).json({
        error:
          `This plan costs $${formatUsdc(cost.totalUsdc)}, over your ` +
          `$${formatUsdc(ceilingUsdc)} limit. Raise the limit to at least ` +
          `$${formatUsdc(cost.minimumCapUsdc)} to run it.`,
        budgetGuidance: guidance,
      })
      return
    }

    // The goal opens the transcript. Written at run time rather than at plan
    // time so an abandoned plan leaves no orphan message in the chat.
    if (messagesForTask(taskId).length === 0) {
      appendMessage(user.id, taskId, 'user', task.goal)
    }

    // Work already paid for is kept, so a retry resumes rather than restarts.
    const completed = syncApprovedSteps(taskId, approvedSteps)
    const priorSpend = [...completed.values()].reduce((sum, step) => sum + step.cost, 0)

    db.prepare(
      `UPDATE tasks SET status = 'pending', completed_at = NULL, total_cost_usdc = ? WHERE id = ?`,
    ).run(Number(priorSpend.toFixed(6)), taskId)

    await runTask({
      taskId,
      userId: user.id,
      goal: task.goal,
      steps: approvedSteps,
      completed,
      walletFor: (chain) => walletForChain(fresh, chain),
      budgetUsdc: budgetUsdc ?? task.budget_usdc ?? null,
      spendingCapUsdc: fresh.spending_cap_usdc,
      policy,
      res,
    })
  }),
)

/**
 * Reconciles the stored plan with exactly what the user approved, and reports
 * which steps are already paid for.
 *
 * A retry used to delete every step and zero the cost, so a three-step run that
 * died on step 2 re-ran and re-paid for steps 0 and 1 — and the record of that
 * earlier spend went with it. Steps that already succeeded are now left in
 * place and handed to the runner to replay from storage.
 *
 * Reuse is only safe when the approved step is the same work: same endpoint,
 * method and parameters, at the same position. The user can edit the plan
 * between attempts, and an index alone does not mean the same call — a step
 * that differs in any of those is discarded and paid for afresh.
 */
function syncApprovedSteps(taskId: string, steps: PlanStep[]): Map<number, CompletedStep> {
  const existing = db
    .prepare('SELECT * FROM task_steps WHERE task_id = ?')
    .all(taskId) as TaskStepRow[]
  const byIndex = new Map(existing.map((row) => [row.step_index, row]))

  const reusable = new Map<number, CompletedStep>()
  steps.forEach((step, index) => {
    const row = byIndex.get(index)
    if (!row || row.status !== 'done') return
    if (
      row.endpoint_url !== step.endpointUrl ||
      row.http_method !== step.httpMethod ||
      (row.params ?? '{}') !== JSON.stringify(step.params)
    ) {
      return
    }
    reusable.set(index, {
      serviceName: row.service_name,
      cost: row.actual_cost_usdc ?? 0,
      txRef: row.tx_ref,
      verificationTx: (row as TaskStepRow & { verification_tx?: string | null }).verification_tx
        ?? null,
      data: parseStoredResponse(row.response_summary),
      source: findServiceByResource(row.endpoint_url)?.source === 'free' ? 'free' : 'x402',
    })
  })

  const insert = db.prepare(
    `INSERT INTO task_steps
      (id, task_id, step_index, service_name, endpoint_url, http_method, params, estimated_cost_usdc, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
  )
  const delOne = db.prepare('DELETE FROM task_steps WHERE task_id = ? AND step_index = ?')
  const delBeyond = db.prepare('DELETE FROM task_steps WHERE task_id = ? AND step_index >= ?')

  db.transaction(() => {
    // Steps the user dropped from the plan.
    delBeyond.run(taskId, steps.length)
    steps.forEach((step, index) => {
      if (reusable.has(index)) return
      delOne.run(taskId, index)
      insert.run(
        randomUUID(),
        taskId,
        index,
        step.serviceName,
        step.endpointUrl,
        step.httpMethod,
        JSON.stringify(step.params),
        step.estimatedCostUsdc,
      )
    })
  })()

  // Keep in-memory indices aligned with what was just persisted.
  steps.forEach((step, index) => {
    step.stepIndex = index
  })
  return reusable
}

function parseStoredResponse(value: string | null): unknown {
  if (value === null) return null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

const ChatBody = z.object({
  taskId: z.string().uuid(),
  message: z.string().min(1).max(2000),
})

/**
 * Follow-up chat about a finished run.
 *
 * This route never spends the user's money. It either answers from data the
 * run already fetched, or reports that a new run is needed and hands back a
 * goal to plan — which the user then approves on the normal approval card.
 * Keeping the spend decision on that card is what preserves their autonomy:
 * a conversational reply can suggest, but it cannot charge.
 */
router.post(
  '/chat',
  requireAuth,
  asyncRoute(async (req, res) => {
    const user = currentUser(req)
    const parsed = ChatBody.safeParse(req.body)
    if (!parsed.success) {
      throw httpError(400, parsed.error.issues[0]?.message ?? 'Invalid request body')
    }
    const { taskId, message } = parsed.data

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined
    if (!task || task.user_id !== user.id) throw httpError(404, 'Task not found')

    const context = runContextFor(taskId)
    if (!context) throw httpError(404, 'Task not found')

    // History is read before the new question is stored, so the question is
    // not duplicated as both history and prompt.
    const history = historyForTask(taskId)
    const userMessage = appendMessage(user.id, taskId, 'user', message)

    const result = await answerFollowUp(message, context, history)
    const agentMessage = appendMessage(
      user.id,
      taskId,
      'agent',
      result.content,
      result.kind === 'needs_run' ? 'plan_offer' : 'text',
    )

    res.json({
      userMessage,
      agentMessage,
      needsRun: result.kind === 'needs_run',
      ...(result.suggestedGoal ? { suggestedGoal: result.suggestedGoal } : {}),
    })
  }),
)

router.get('/chat/:taskId', requireAuth, (req, res) => {
  const user = currentUser(req)
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.taskId) as
    | TaskRow
    | undefined
  if (!task || task.user_id !== user.id) {
    res.status(404).json({ error: 'Task not found' })
    return
  }
  res.json({ messages: messagesForTask(task.id) })
})

const StopBody = z.object({ taskId: z.string().uuid() })

router.post('/stop', requireAuth, (req, res) => {
  const user = currentUser(req)
  const parsed = StopBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'taskId is required' })
    return
  }
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(parsed.data.taskId) as
    | TaskRow
    | undefined
  if (!task || task.user_id !== user.id) {
    res.status(404).json({ error: 'Task not found' })
    return
  }

  db.prepare(
    `INSERT INTO agent_sessions (user_id, abort_flag, updated_at)
     VALUES (?, 1, strftime('%s','now'))
     ON CONFLICT(user_id) DO UPDATE SET abort_flag = 1, updated_at = strftime('%s','now')`,
  ).run(user.id)

  res.json({ ok: true, note: 'Stopping after the current in-flight step completes.' })
})

export default router

/** Test-only handle on the retry reconciliation; not reachable over HTTP. */
export const __testSyncApprovedSteps = syncApprovedSteps

/** Test-only handle on the budget guidance builder; not reachable over HTTP. */
export const __testBuildBudgetGuidance = buildBudgetGuidance
