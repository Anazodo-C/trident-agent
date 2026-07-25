import { Router } from 'express'
import db, { type TaskRow, type TaskStepRow } from '../db.ts'
import { currentUser, requireAuth } from '../auth/jwt.ts'

const router = Router()

function shapeTask(row: TaskRow) {
  return {
    id: row.id,
    goal: row.goal,
    status: row.status,
    totalCostUsdc: row.total_cost_usdc,
    budgetUsdc: row.budget_usdc,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  }
}

function shapeStep(row: TaskStepRow) {
  return {
    id: row.id,
    stepIndex: row.step_index,
    serviceName: row.service_name,
    endpointUrl: row.endpoint_url,
    httpMethod: row.http_method,
    params: row.params ? safeParse(row.params) : {},
    estimatedCostUsdc: row.estimated_cost_usdc,
    actualCostUsdc: row.actual_cost_usdc,
    status: row.status,
    responseSummary: row.response_summary,
    txRef: row.tx_ref,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return {}
  }
}

router.get('/', requireAuth, (req, res) => {
  const user = currentUser(req)
  const limit = Math.min(Number(req.query['limit'] ?? 50) || 50, 200)

  const rows = db
    .prepare('SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(user.id, limit) as TaskRow[]

  const counts = db.prepare(
    `SELECT task_id, COUNT(*) AS total, SUM(status = 'done') AS done
     FROM task_steps WHERE task_id IN (SELECT id FROM tasks WHERE user_id = ?)
     GROUP BY task_id`,
  ).all(user.id) as { task_id: string; total: number; done: number }[]

  const byTask = new Map(counts.map((c) => [c.task_id, c]))

  res.json({
    tasks: rows.map((row) => ({
      ...shapeTask(row),
      stepCount: byTask.get(row.id)?.total ?? 0,
      stepsDone: byTask.get(row.id)?.done ?? 0,
    })),
  })
})

router.get('/:id', requireAuth, (req, res) => {
  const user = currentUser(req)
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) as
    | TaskRow
    | undefined

  if (!row || row.user_id !== user.id) {
    res.status(404).json({ error: 'Task not found' })
    return
  }

  const steps = db
    .prepare('SELECT * FROM task_steps WHERE task_id = ? ORDER BY step_index ASC')
    .all(row.id) as TaskStepRow[]

  res.json({ task: shapeTask(row), steps: steps.map(shapeStep) })
})

export default router
