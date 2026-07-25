import type { Response } from 'express'
import db from '../db.ts'
import type { PlanStep } from '../llm/planner.ts'
import { gatewayClientFor, safeErrorMessage, resolveChain } from '../circle/gatewayService.ts'
import { isCataloguedEndpoint } from '../circle/marketplaceService.ts'

export type SseEvent =
  | 'start'
  | 'step_start'
  | 'step_done'
  | 'step_failed'
  | 'budget_exceeded'
  | 'cap_exceeded'
  | 'stopped'
  | 'complete'
  | 'fatal'
  | 'error'

function emit(res: Response, event: SseEvent, data: object): void {
  if (res.writableEnded) return
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function isBalanceError(message: string): boolean {
  return /insufficient|balance|not enough funds/i.test(message)
}

/** Round to USDC's 6 decimals so repeated addition doesn't drift. */
function usdc(n: number): number {
  return Number(n.toFixed(6))
}

function truncate(value: unknown, max = 500): string {
  try {
    return JSON.stringify(value).slice(0, max)
  } catch {
    return String(value).slice(0, max)
  }
}

export interface RunTaskOptions {
  taskId: string
  userId: string
  steps: PlanStep[]
  /** EOA key — never logged, never persisted, never echoed in an error. */
  agentPrivateKey: string
  budgetUsdc: number | null
  spendingCapUsdc: number
  chainLabel: string | null
  res: Response
}

export async function runTask(options: RunTaskOptions): Promise<void> {
  const { taskId, userId, steps, agentPrivateKey, budgetUsdc, spendingCapUsdc, chainLabel, res } =
    options

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  // Keeps proxies from closing an idle stream during a slow upstream call.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n')
  }, 15_000)

  let clientGone = false
  res.on('close', () => {
    clientGone = true
  })

  const finish = (status: string): void => {
    clearInterval(heartbeat)
    db.prepare(`UPDATE tasks SET status = ?, completed_at = strftime('%s','now') WHERE id = ?`).run(
      status,
      taskId,
    )
    if (!res.writableEnded) res.end()
  }

  let totalSpent = 0

  try {
    const client = gatewayClientFor(agentPrivateKey, resolveChain(chainLabel))

    db.prepare(
      `INSERT INTO agent_sessions (user_id, abort_flag, updated_at)
       VALUES (?, 0, strftime('%s','now'))
       ON CONFLICT(user_id) DO UPDATE SET abort_flag = 0, updated_at = strftime('%s','now')`,
    ).run(userId)

    db.prepare(`UPDATE tasks SET status = 'running' WHERE id = ?`).run(taskId)

    emit(res, 'start', {
      taskId,
      totalSteps: steps.length,
      budgetUsdc,
      spendingCapUsdc,
      eoaAddress: client.address,
    })

    for (const step of steps) {
      if (clientGone) {
        finish('stopped')
        return
      }

      const session = db
        .prepare('SELECT abort_flag FROM agent_sessions WHERE user_id = ?')
        .get(userId) as { abort_flag: number } | undefined

      if (session?.abort_flag) {
        emit(res, 'stopped', { taskId, totalSpent, stoppedAt: step.stepIndex })
        finish('stopped')
        return
      }

      // Per-run budget the user set on the approval card.
      if (budgetUsdc !== null && totalSpent + step.estimatedCostUsdc > budgetUsdc) {
        emit(res, 'budget_exceeded', {
          taskId,
          totalSpent,
          budgetUsdc,
          nextStepCost: step.estimatedCostUsdc,
        })
        finish('stopped')
        return
      }

      // Account-level cap from users.spending_cap_usdc — checked before every step.
      if (totalSpent + step.estimatedCostUsdc > spendingCapUsdc) {
        emit(res, 'cap_exceeded', {
          taskId,
          totalSpent,
          spendingCapUsdc,
          nextStepCost: step.estimatedCostUsdc,
        })
        finish('stopped')
        return
      }

      emit(res, 'step_start', {
        stepIndex: step.stepIndex,
        serviceName: step.serviceName,
        endpointUrl: step.endpointUrl,
        purpose: step.purpose,
      })
      db.prepare(
        `UPDATE task_steps SET status = 'running', started_at = strftime('%s','now')
         WHERE task_id = ? AND step_index = ?`,
      ).run(taskId, step.stepIndex)

      try {
        // Defence in depth: approvedSteps arrive from the client and could be edited.
        if (!isCataloguedEndpoint(step.endpointUrl)) {
          throw new Error(`Endpoint is not in the service catalog: ${step.endpointUrl}`)
        }

        const payOptions =
          step.httpMethod === 'POST'
            ? ({ method: 'POST', body: step.params } as const)
            : undefined

        const result = await client.pay(step.endpointUrl, payOptions)

        const cost = Number.parseFloat(result.formattedAmount)
        totalSpent = usdc(totalSpent + (Number.isFinite(cost) ? cost : 0))

        db.prepare(
          `UPDATE task_steps
           SET status = 'done', actual_cost_usdc = ?, tx_ref = ?, response_summary = ?,
               completed_at = strftime('%s','now')
           WHERE task_id = ? AND step_index = ?`,
        ).run(cost, result.transaction, truncate(result.data), taskId, step.stepIndex)
        db.prepare('UPDATE tasks SET total_cost_usdc = ? WHERE id = ?').run(totalSpent, taskId)

        emit(res, 'step_done', {
          stepIndex: step.stepIndex,
          serviceName: step.serviceName,
          cost,
          totalSpent,
          txRef: result.transaction,
          result: result.data,
        })
      } catch (err) {
        const detail = safeErrorMessage(err)
        db.prepare(
          `UPDATE task_steps
           SET status = 'failed', response_summary = ?, completed_at = strftime('%s','now')
           WHERE task_id = ? AND step_index = ?`,
        ).run(detail.slice(0, 500), taskId, step.stepIndex)

        emit(res, 'step_failed', { stepIndex: step.stepIndex, error: detail, totalSpent })

        if (isBalanceError(detail)) {
          emit(res, 'fatal', {
            error: 'Insufficient Gateway balance. Top up in the Wallet tab.',
            totalSpent,
          })
          finish('failed')
          return
        }
        // Other failures are non-fatal: continue to the next step.
      }
    }

    emit(res, 'complete', { taskId, totalSpent, stepsCompleted: steps.length })
    finish('done')
  } catch (err) {
    // Headers are already sent, so surface the failure on the stream, not as a status code.
    emit(res, 'error', { taskId, error: safeErrorMessage(err), totalSpent })
    finish('failed')
  }
}
