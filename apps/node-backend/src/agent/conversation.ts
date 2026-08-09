import { randomUUID } from 'node:crypto'
import db, { type MessageRow, type TaskRow, type TaskStepRow } from '../db.ts'
import { findServiceByResource } from '../circle/registryService.ts'
import type { RunContext, StepResult, Turn } from '../llm/responder.ts'

export type MessageKind = 'text' | 'summary' | 'plan_offer'

export interface ChatMessage {
  id: string
  taskId: string | null
  role: 'user' | 'agent'
  content: string
  kind: MessageKind
  createdAt: number
}

function shape(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    taskId: row.task_id,
    role: row.role === 'user' ? 'user' : 'agent',
    content: row.content,
    kind: (row.kind as MessageKind) ?? 'text',
    createdAt: row.created_at,
  }
}

export function appendMessage(
  userId: string,
  taskId: string | null,
  role: 'user' | 'agent',
  content: string,
  kind: MessageKind = 'text',
): ChatMessage {
  const id = randomUUID()
  db.prepare(
    'INSERT INTO messages (id, user_id, task_id, role, content, kind) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, userId, taskId, role, content, kind)
  return shape(
    db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow,
  )
}

export function messagesForTask(taskId: string): ChatMessage[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE task_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(taskId) as MessageRow[]
  return rows.map(shape)
}

export function messagesForUser(userId: string, limit: number): ChatMessage[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(userId, limit) as MessageRow[]
  return rows.map(shape).reverse()
}

export function historyForTask(taskId: string): Turn[] {
  return messagesForTask(taskId).map((message) => ({
    role: message.role,
    content: message.content,
  }))
}

function parseSummary(value: string | null): unknown {
  if (value === null) return null
  try {
    return JSON.parse(value)
  } catch {
    // Failed steps store a plain error string, not JSON.
    return value
  }
}

/**
 * Rebuilds the run's results from the database so a follow-up hours later has
 * the same context the summary was written from. `response_summary` holds the
 * step's payload (truncated), which is why the runner's truncation limit is
 * generous rather than log-sized.
 */
export function runContextFor(taskId: string): RunContext | null {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined
  if (!task) return null

  const rows = db
    .prepare('SELECT * FROM task_steps WHERE task_id = ? ORDER BY step_index ASC')
    .all(taskId) as TaskStepRow[]

  const steps: StepResult[] = rows.map((row) => ({
    stepIndex: row.step_index,
    serviceName: row.service_name,
    purpose: safeParams(row.params),
    status: row.status,
    data: parseSummary(row.response_summary),
    costUsdc: row.actual_cost_usdc ?? 0,
    source: findServiceByResource(row.endpoint_url)?.source === 'free' ? 'free' : 'x402',
  }))

  return {
    goal: task.goal,
    steps,
    totalCostUsdc: task.total_cost_usdc,
    status: task.status,
  }
}

/**
 * The step's purpose is not persisted separately, so its parameters stand in —
 * they carry what the call was actually for (the city, the ticker, the pair).
 */
function safeParams(params: string | null): string {
  if (!params) return ''
  try {
    const parsed = JSON.parse(params) as Record<string, unknown>
    const entries = Object.entries(parsed)
    if (entries.length === 0) return ''
    return entries.map(([key, value]) => `${key}=${String(value)}`).join(', ')
  } catch {
    return ''
  }
}
