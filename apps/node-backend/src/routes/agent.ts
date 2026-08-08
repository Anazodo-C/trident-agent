import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import db, { type TaskRow } from '../db.ts'
import { asyncRoute, httpError } from '../http.ts'
import { currentUser, requireAuth } from '../auth/jwt.ts'
import { buildPlan, StepSchema, type PlanStep, type StepAnnotation } from '../llm/planner.ts'
import { findServiceByResource } from '../circle/registryService.ts'
import { selectCandidates } from '../circle/candidateService.ts'
import { chooseChain, policyFor, unpayableReason } from '../circle/chainPolicy.ts'
import { findUpgrades } from '../circle/upgradeService.ts'
import { runTask } from '../agent/runner.ts'
import { findUserById } from '../auth/users.ts'

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
    const plan = await buildPlan(goal, candidates.services, budgetUsdc)

    // Annotate from the registry rather than trusting the model's claims, so
    // the approval card can warn about endpoints with no recorded usage.
    const annotations: Record<number, StepAnnotation> = {}
    for (const step of plan.steps) {
      const service = findServiceByResource(step.endpointUrl)
      if (!service) continue
      const choice = chooseChain(service.networks, policy)
      annotations[step.stepIndex] = {
        trust: service.trust,
        calls30d: service.calls30d,
        host: service.host,
        chain: choice?.chain ?? null,
        isTestnet: choice?.isTestnet ?? false,
        ...(choice ? {} : { blockedReason: unpayableReason(service.networks, policy) ?? undefined }),
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

    db.transaction(() => {
      insertTask.run(taskId, user.id, goal, 'pending', budgetUsdc ?? null)
      for (const step of plan.steps) {
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
    const upgrades = findUpgrades(plan.steps, policy)

    res.json({
      taskId,
      plan,
      annotations,
      upgrades,
      candidatesConsidered: candidates.services.length,
      usedFallback: candidates.fallback,
      mainnetEnabled: policy.mainnetEnabled,
    })
  }),
)

const RunBody = z.object({
  taskId: z.string().uuid(),
  approvedSteps: z.array(StepSchema).min(1, 'At least one step is required'),
  agentPrivateKey: z.string(),
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
    const { taskId, approvedSteps, agentPrivateKey, budgetUsdc } = parsed.data

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

    const fresh = findUserById(user.id)
    if (!fresh?.eoa_address) throw httpError(409, 'No agent wallet has been set up for this account')

    // Reject the whole run if any step needs a chain the user has not enabled,
    // rather than discovering it mid-execution after money has already moved.
    const policy = policyFor(fresh)
    for (const step of approvedSteps) {
      const service = findServiceByResource(step.endpointUrl)!
      if (!chooseChain(service.networks, policy)) {
        throw httpError(
          403,
          `${step.serviceName}: ${unpayableReason(service.networks, policy) ?? 'no permitted settlement network'}`,
        )
      }
    }

    syncApprovedSteps(taskId, approvedSteps)
    // Clear the previous attempt's outcome so the retry starts clean.
    db.prepare(
      `UPDATE tasks SET status = 'pending', completed_at = NULL, total_cost_usdc = 0 WHERE id = ?`,
    ).run(taskId)

    await runTask({
      taskId,
      userId: user.id,
      steps: approvedSteps,
      agentPrivateKey,
      budgetUsdc: budgetUsdc ?? task.budget_usdc ?? null,
      spendingCapUsdc: fresh.spending_cap_usdc,
      policy,
      res,
    })
  }),
)

/**
 * The user may drop steps on the approval card, so the stored plan is replaced
 * with exactly what they approved before anything is charged.
 */
function syncApprovedSteps(taskId: string, steps: PlanStep[]): void {
  const del = db.prepare('DELETE FROM task_steps WHERE task_id = ?')
  const insert = db.prepare(
    `INSERT INTO task_steps
      (id, task_id, step_index, service_name, endpoint_url, http_method, params, estimated_cost_usdc, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
  )
  db.transaction(() => {
    del.run(taskId)
    steps.forEach((step, index) => {
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
}

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
