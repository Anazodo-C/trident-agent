import type { Response } from 'express'
import db from '../db.ts'
import type { PlanStep } from '../llm/planner.ts'
import { gatewayClientFor, safeErrorMessage } from '../circle/gatewayService.ts'
import { findServiceByResource } from '../circle/registryService.ts'
import { chooseChain, unpayableReason, type ChainPolicy } from '../circle/chainPolicy.ts'
import { callFreeApi, payVerification } from '../circle/testnetVerification.ts'
import { summariseRun, type StepResult } from '../llm/responder.ts'
import { appendMessage } from './conversation.ts'
import type { GatewayClient } from '@circle-fin/x402-batching/client'
import type { SupportedChainName } from '@circle-fin/x402-batching/client'

export type SseEvent =
  | 'start'
  | 'step_start'
  | 'step_done'
  | 'step_replayed'
  | 'step_failed'
  | 'budget_exceeded'
  | 'cap_exceeded'
  | 'stopped'
  | 'complete'
  | 'summary'
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

// Large enough for the responder to summarise from. 500 chars truncated most
// API payloads mid-object, leaving nothing useful to describe.
function truncate(value: unknown, max = 4000): string {
  try {
    return JSON.stringify(value).slice(0, max)
  } catch {
    return String(value).slice(0, max)
  }
}

/**
 * A step from an earlier attempt that already settled. Replayed from storage on
 * a retry so the user is not charged twice for the same call.
 */
export interface CompletedStep {
  serviceName: string
  cost: number
  txRef: string | null
  verificationTx: string | null
  data: unknown
  source: 'free' | 'x402'
}

export interface RunTaskOptions {
  taskId: string
  userId: string
  steps: PlanStep[]
  /** EOA key — never logged, never persisted, never echoed in an error. */
  agentPrivateKey: string
  /** The user's original request, echoed into the transcript and the summary. */
  goal: string
  /** Steps already paid for on a previous attempt, keyed by step index. */
  completed: Map<number, CompletedStep>
  budgetUsdc: number | null
  spendingCapUsdc: number
  /** Which chains this user may settle on; mainnet only when opted in. */
  policy: ChainPolicy
  res: Response
}

export async function runTask(options: RunTaskOptions): Promise<void> {
  const {
    taskId,
    userId,
    goal,
    steps,
    completed,
    agentPrivateKey,
    budgetUsdc,
    spendingCapUsdc,
    policy,
    res,
  } = options

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

  // Seeded with what earlier attempts already spent, so the budget and cap are
  // measured against the true cost of the task rather than of this attempt.
  let totalSpent = usdc([...completed.values()].reduce((sum, step) => sum + step.cost, 0))

  // Kept in memory as the run proceeds so the summary is written from the live
  // payloads rather than re-read from the truncated copies in the database.
  const results: StepResult[] = []

  /**
   * Writes the run up as prose and puts it on the stream and in the transcript.
   * Called on every terminal path that produced at least one result — a run
   * stopped by the budget still fetched real data, and the user paid for it.
   *
   * Awaited before the stream closes so the client never has to poll for it,
   * and never allowed to throw: the results are already safe in the database,
   * and a summariser fault must not turn a successful run into a failed one.
   */
  const emitSummary = async (status: string): Promise<void> => {
    if (results.length === 0) return
    try {
      const summary = await summariseRun({ goal, steps: results, totalCostUsdc: totalSpent, status })
      appendMessage(userId, taskId, 'agent', summary, 'summary')
      emit(res, 'summary', { taskId, summary })
    } catch (err) {
      console.error('[trident] summary emit failed:', String(err))
    }
  }

  // One client per chain, built lazily: a plan may span chains, and building a
  // client is cheap but not free.
  const clients = new Map<SupportedChainName, GatewayClient>()
  const clientFor = (chain: SupportedChainName): GatewayClient => {
    let existing = clients.get(chain)
    if (!existing) {
      existing = gatewayClientFor(agentPrivateKey, chain)
      clients.set(chain, existing)
    }
    return existing
  }

  try {
    const client = clientFor(policy.testnet)

    db.prepare(
      `INSERT INTO agent_sessions (user_id, abort_flag, updated_at)
       VALUES (?, 0, strftime('%s','now'))
       ON CONFLICT(user_id) DO UPDATE SET abort_flag = 0, updated_at = strftime('%s','now')`,
    ).run(userId)

    db.prepare(`UPDATE tasks SET status = 'running' WHERE id = ?`).run(taskId)

    emit(res, 'start', {
      taskId,
      totalSteps: steps.length,
      // Non-zero on a retry: these steps are replayed, not re-paid.
      replayedSteps: completed.size,
      alreadySpent: totalSpent,
      budgetUsdc,
      spendingCapUsdc,
      eoaAddress: client.address,
    })

    for (const step of steps) {
      if (clientGone) {
        finish('stopped')
        return
      }

      // Already settled on an earlier attempt. Replayed from storage: no
      // payment, no budget gate — the money moved once and is already counted
      // in totalSpent — and the result still reaches the summary and the UI.
      const done = completed.get(step.stepIndex)
      if (done) {
        results.push({
          stepIndex: step.stepIndex,
          serviceName: done.serviceName,
          purpose: step.purpose,
          status: 'done',
          data: done.data,
          costUsdc: done.cost,
          source: done.source,
        })
        emit(res, 'step_replayed', {
          stepIndex: step.stepIndex,
          serviceName: done.serviceName,
          source: done.source,
          cost: done.cost,
          totalSpent,
          txRef: done.txRef,
          verificationTx: done.verificationTx,
          result: done.data,
        })
        continue
      }

      const session = db
        .prepare('SELECT abort_flag FROM agent_sessions WHERE user_id = ?')
        .get(userId) as { abort_flag: number } | undefined

      if (session?.abort_flag) {
        emit(res, 'stopped', { taskId, totalSpent, stoppedAt: step.stepIndex })
        await emitSummary('stopped')
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
        await emitSummary('stopped')
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
        await emitSummary('stopped')
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

      // Resolved outside the try so the failure path can tell a free-API
      // metering failure apart from an x402 settlement failure.
      const service = findServiceByResource(step.endpointUrl)

      try {
        // Defence in depth: approvedSteps arrive from the client and could be
        // edited, so the endpoint is re-checked against the registry here and
        // matched exactly — never by prefix.
        if (!service) {
          throw new Error(`Endpoint is not in the service registry: ${step.endpointUrl}`)
        }

        // Chain is decided here, not by the client: a tampered request must not
        // be able to move spending onto mainnet when the user has not opted in.
        const choice = chooseChain(service.networks, policy)
        if (!choice) {
          throw new Error(
            unpayableReason(service.networks, policy) ?? 'No permitted settlement network',
          )
        }

        let cost: number
        let txRef: string
        let verificationTx: string | null = null
        let data: unknown

        if (service.source === 'free') {
          // Free APIs do not implement x402 — there is no 402 to answer and
          // nobody to pay. They are metered instead: a real Arc Testnet transfer
          // settles first, so a call still moves value on chain and leaves a
          // receipt, and an unfunded wallet cannot reach them.
          const receipt = await payVerification(agentPrivateKey)
          verificationTx = receipt.txHash
          txRef = receipt.txHash
          cost = receipt.amountUsdc

          const response = await callFreeApi(step.endpointUrl, {
            method: step.httpMethod,
            ...(step.httpMethod === 'POST' ? { body: step.params } : {}),
          })
          data = response.data
        } else {
          const payOptions =
            step.httpMethod === 'POST'
              ? ({ method: 'POST', body: step.params } as const)
              : undefined

          const result = await clientFor(choice.chain).pay(step.endpointUrl, payOptions)
          const parsed = Number.parseFloat(result.formattedAmount)
          cost = Number.isFinite(parsed) ? parsed : 0
          txRef = result.transaction
          data = result.data
        }

        totalSpent = usdc(totalSpent + cost)

        db.prepare(
          `UPDATE task_steps
           SET status = 'done', actual_cost_usdc = ?, tx_ref = ?, verification_tx = ?,
               response_summary = ?, completed_at = strftime('%s','now')
           WHERE task_id = ? AND step_index = ?`,
        ).run(cost, txRef, verificationTx, truncate(data), taskId, step.stepIndex)
        db.prepare('UPDATE tasks SET total_cost_usdc = ? WHERE id = ?').run(totalSpent, taskId)

        results.push({
          stepIndex: step.stepIndex,
          serviceName: step.serviceName,
          purpose: step.purpose,
          status: 'done',
          data,
          costUsdc: cost,
          source: service.source === 'free' ? 'free' : 'x402',
        })

        emit(res, 'step_done', {
          stepIndex: step.stepIndex,
          serviceName: step.serviceName,
          source: service.source,
          cost,
          totalSpent,
          chain: choice.chain,
          isTestnet: choice.isTestnet,
          txRef,
          verificationTx,
          result: data,
        })
      } catch (err) {
        const detail = safeErrorMessage(err)
        db.prepare(
          `UPDATE task_steps
           SET status = 'failed', response_summary = ?, completed_at = strftime('%s','now')
           WHERE task_id = ? AND step_index = ?`,
        ).run(detail.slice(0, 500), taskId, step.stepIndex)

        results.push({
          stepIndex: step.stepIndex,
          serviceName: step.serviceName,
          purpose: step.purpose,
          status: 'failed',
          data: detail,
          costUsdc: 0,
          source: service?.source === 'free' ? 'free' : 'x402',
        })

        emit(res, 'step_failed', { stepIndex: step.stepIndex, error: detail, totalSpent })

        if (isBalanceError(detail)) {
          // A free API fails on the Arc Testnet metering payment, not on
          // Gateway — pointing the user at the Gateway panel would send them
          // to top up a balance that was never involved.
          emit(res, 'fatal', {
            error:
              service?.source === 'free'
                ? 'Not enough testnet USDC to meter this call. Fund your agent wallet on Arc Testnet from the Circle faucet.'
                : 'Insufficient Gateway balance. Top up in the Wallet tab.',
            totalSpent,
          })
          await emitSummary('failed')
          finish('failed')
          return
        }
        // Other failures are non-fatal: continue to the next step.
      }
    }

    emit(res, 'complete', { taskId, totalSpent, stepsCompleted: steps.length })
    await emitSummary('done')
    finish('done')
  } catch (err) {
    // Headers are already sent, so surface the failure on the stream, not as a status code.
    emit(res, 'error', { taskId, error: safeErrorMessage(err), totalSpent })
    finish('failed')
  }
}
