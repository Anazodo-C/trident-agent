import type { Response } from 'express'
import db from '../db.ts'
import type { PlanStep } from '../llm/planner.ts'
import {
  gatewayClientFor,
  lastErrorBodyFor,
  quoteFromEndpoint,
  safeErrorMessage,
  unifiedGatewayBalance,
} from '../circle/gatewayService.ts'
import { privateKeyToAccount } from 'viem/accounts'
import { bridgeToGatewayBalance } from '../circle/cctpBridge.ts'
import { canBridgeTo } from '../circle/deployments.ts'
import { KEEPER_PRIVATE_KEY } from '../env.ts'
import { findServiceByResource, type Service } from '../circle/registryService.ts'
import { findAlternatives, noteEndpointFailure } from '../circle/candidateService.ts'
import {
  GATEWAY_MAINNET_CHAINS,
  chooseChain,
  unpayableReason,
  type ChainPolicy,
} from '../circle/chainPolicy.ts'
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

/**
 * How many providers a single step may try before giving up. Three is enough
 * to ride out one provider being down without turning a failing goal into a
 * long, expensive search.
 */
const MAX_ENDPOINT_ATTEMPTS = 3

/**
 * A refusal we made, rather than a failure the network handed us. These must
 * keep their own wording: the user needs to know a rule stopped this, not that
 * a provider is having a bad day.
 *
 * Insufficient balance is treated the same way (see the call site): it is
 * something the user can fix by funding the wallet, and telling them a service
 * is down would send them to wait for a provider instead.
 */
function isPolicyRefusal(message: string): boolean {
  return /not in the service registry|batch settlement|settlement network|Enable mainnet/i.test(
    message,
  )
}

function isBalanceError(message: string): boolean {
  return /insufficient|balance|not enough funds/i.test(message)
}

/**
 * One payment attempt, retried once when the facilitator says to.
 *
 * "Payment verification temporarily unavailable, please retry" is an upstream
 * hiccup, not a rejection — the endpoint never served the request, so nothing
 * was bought and a second attempt cannot double-charge.
 */
async function payOnce(
  client: GatewayClient,
  step: PlanStep,
  payOptions: { method: 'POST'; body: Record<string, unknown> } | undefined,
  inQuery: boolean,
): Promise<Awaited<ReturnType<GatewayClient['pay']>>> {
  try {
    return await client.pay(requestUrl(step, inQuery), payOptions)
  } catch (err) {
    if (!/temporarily unavailable|please retry/i.test(safeErrorMessage(err))) throw err
    await new Promise((resolve) => setTimeout(resolve, 1500))
    return await client.pay(requestUrl(step, inQuery), payOptions)
  }
}

/**
 * The required parameters this step has not supplied.
 *
 * Checked against the registry's copy of the service, never the plan's — the
 * plan is model output, and a model that forgot a parameter is equally capable
 * of forgetting it was required.
 *
 * Empty strings count as missing. A blank search term is not a search.
 */
export function missingRequiredParams(
  required: string[],
  params: Record<string, unknown>,
): string[] {
  return required.filter((name) => {
    const value = params[name]
    if (value === undefined || value === null) return true
    if (typeof value === 'string' && value.trim() === '') return true
    if (Array.isArray(value) && value.length === 0) return true
    return false
  })
}

/**
 * Supplied values that the endpoint's published enum does not allow.
 *
 * Presence is not correctness. `model: "openai/gpt-4o-mini"` is a real model,
 * spelled right, on an endpoint that only serves Anthropic — and the reply is
 * a 400 with no indication which field was at fault.
 *
 * Absent parameters are not reported here; that is the required check's job,
 * and an optional parameter left out is fine.
 */
export function invalidEnumParams(
  enums: Record<string, string[]>,
  params: Record<string, unknown>,
): string[] {
  return Object.entries(enums)
    .filter(([name, allowed]) => {
      const value = params[name]
      if (value === undefined || value === null) return false
      return !allowed.includes(String(value))
    })
    .map(([name]) => name)
}

/**
 * Whether a step's parameters can be used against a different service.
 *
 * Failover swaps the endpoint but keeps the parameters, which only holds while
 * the two agree on what those parameters mean. Two endpoints from the same
 * provider, with near-identical names, routinely do not.
 */
export function paramsFit(
  service: Pick<Service, 'requiredParams' | 'paramEnums' | 'resource'>,
  params: Record<string, unknown>,
): boolean {
  // A template we cannot fill is as unusable as a missing required field, and
  // it is how `/videos/generations/{id}` came to be requested literally.
  const unfillable = pathPlaceholders(service.resource).some(
    (name) => params[name] === undefined || params[name] === null || params[name] === '',
  )
  return (
    !unfillable &&
    missingRequiredParams(service.requiredParams, params).length === 0 &&
    invalidEnumParams(service.paramEnums, params).length === 0
  )
}

/**
 * The URL to actually request.
 *
 * A GET has nowhere to put its parameters except the query string — and
 * nothing was putting them there. Endpoints with required query parameters
 * were called with none, so they answered 400 after the payment had already
 * authorised, surfacing as "Payment failed: Bad Request" and looking like a
 * wallet problem.
 *
 * `inQuery` exists because the verb does not settle the question. A handful of
 * POST services read their arguments from the query string too, so the caller
 * passes what the service's schema actually declared.
 *
 * Array values repeat the key (symbols=ETH&symbols=BTC), which is the form the
 * published schemas ask for.
 */
/** Placeholder segments in a catalogued URL, e.g. `{id}` in `/coins/{id}`. */
const PATH_PLACEHOLDER = /\{([^{}]+)\}/g

/** The placeholder names a URL still expects to have filled. */
export function pathPlaceholders(url: string): string[] {
  return [...url.matchAll(PATH_PLACEHOLDER)].map((m) => m[1] as string)
}

/**
 * Fill `{id}`-style segments from the step's parameters.
 *
 * 117 of the catalog's 955 resources are templates. Sent as published they are
 * requested with the braces still in them — a failover once called
 * `/api/v1/videos/generations/{id}` verbatim and read the 400 as the endpoint
 * being broken.
 *
 * A parameter spent on the path is returned so the caller does not also append
 * it to the query string, where it would be a duplicate the server ignores.
 */
export function applyPathParams(
  url: string,
  params: Record<string, unknown>,
): { url: string; consumed: Set<string> } {
  const consumed = new Set<string>()
  const filled = url.replace(PATH_PLACEHOLDER, (whole, name: string) => {
    const value = params[name]
    if (value === undefined || value === null || value === '') return whole
    consumed.add(name)
    return encodeURIComponent(String(value))
  })
  return { url: filled, consumed }
}

export function requestUrl(
  step: PlanStep,
  inQuery: boolean = step.httpMethod === 'GET',
): string {
  const { url: pathFilled, consumed } = applyPathParams(step.endpointUrl, step.params ?? {})

  // An unfilled placeholder cannot be requested. Better to say so than to ask
  // the server what it thinks of a literal "{id}".
  const unfilled = pathPlaceholders(pathFilled)
  if (unfilled.length > 0) {
    throw new Error(
      `${step.serviceName} needs ${unfilled.join(', ')} in its path, and the request did not ` +
        `supply ${unfilled.length === 1 ? 'it' : 'them'}. Nothing was charged.`,
    )
  }

  if (!inQuery) return pathFilled
  const entries = Object.entries(step.params ?? {}).filter(([key]) => !consumed.has(key))
  if (entries.length === 0) return pathFilled

  const url = new URL(pathFilled)
  for (const [key, value] of entries) {
    /*
     * Replace, never add alongside.
     *
     * Catalogued URLs can carry example values — the free geocoding entry is
     * stored as "?name=lagos" — and appending produced "?name=lagos&name=
     * University of Georgia". The server read the first one, so the user paid
     * for confident results about the wrong place. A supplied parameter must
     * win over a catalogued default.
     */
    url.searchParams.delete(key)

    /*
     * params is arbitrary JSON now, because a POST body can nest. A query
     * string cannot, so flatten here: arrays become repeated keys, objects are
     * serialised, and a comma-joined string is split back into repeated keys
     * for the schemas that ask for that form.
     */
    const parts = Array.isArray(value)
      ? value
      : typeof value === 'object' && value !== null
        ? [JSON.stringify(value)]
        : typeof value === 'string' && value.includes(',')
          ? value.split(',')
          : [value]

    for (const part of parts) {
      if (part === null || part === undefined) continue
      url.searchParams.append(key, String(part).trim())
    }
  }
  return url.toString()
}

/**
 * The endpoint's own last error body, if one was captured.
 *
 * Wrapped because building the URL can now throw — an unfilled path template
 * is refused there — and a diagnostic must never replace the error it was
 * trying to explain.
 */
function safeRecordedBody(step: PlanStep): string | null {
  try {
    return lastErrorBodyFor(requestUrl(step))
  } catch {
    return null
  }
}

/** Pull an HTTP status out of an SDK error string, for the failure log. */
function httpStatusOf(message: string): number | null {
  // Anchored to how a status is actually written, not any three digits in the
  // prose — "Resource does not require payment (not 402)" was being logged
  // with status 402, which is the opposite of what happened.
  const match = message.match(/\b(?:status|code|HTTP)\D{0,3}(\d{3})\b/i)
  return match ? Number(match[1]) : null
}

/**
 * Whether a failure is the endpoint rejecting the HTTP verb.
 *
 * Matches the phrase as well as the number: SDK errors are not consistent
 * about carrying a status, and one observed failure read "Payment failed: Bad
 * Request" with no digits in it at all.
 */
function isMethodNotAllowed(message: string): boolean {
  return httpStatusOf(message) === 405 || /method not allowed/i.test(message)
}

/**
 * Pay for a step, recovering from a wrong HTTP verb.
 *
 * The catalog's recorded method is sometimes wrong — the Bazaar lists at least
 * one endpoint as GET that answers only POST — and the wrong verb comes back
 * as 405 with nothing bought.
 *
 * Recovery is safe because of what 405 means here. x402 requires an unpaid
 * request first, which the server answers with 402 and payment requirements;
 * only then does the client pay. A 405 is that first request being refused, so
 * no money has moved. Before retrying we prove it: an unpaid probe with the
 * other verb must answer 402 — still demanding payment, therefore none was
 * taken. Anything else and we surface the original error rather than risk
 * paying twice.
 */
async function payWithMethodRecovery(
  client: GatewayClient,
  step: PlanStep,
  payOptions: { method: 'POST'; body: Record<string, unknown> } | undefined,
  inQuery: boolean,
): Promise<Awaited<ReturnType<GatewayClient['pay']>>> {
  /**
   * Ask the endpoint, not the catalog, before spending.
   *
   * The registry's scheme list is a snapshot from the last Bazaar sync and can
   * disagree with what the endpoint advertises right now — the block-height
   * endpoint is recorded as offering batch settlement and did not, which is
   * how a run got as far as the payment before failing. supports() is the
   * unpaid 402 probe, so this costs a round trip and no money.
   */
  /*
   * Only trust a "no" that is actually about Gateway.
   *
   * supports() probes without a request body, so a POST endpoint that needs
   * one answers something other than 402 and the check reports "Resource does
   * not require payment". That says nothing about whether Gateway can settle
   * it — and blocking on it turned a working endpoint into a failed run. Treat
   * that reason as inconclusive and let pay() decide; block only when the SDK
   * names the batching option as the problem.
   */
  const support = await client.supports(requestUrl(step, inQuery)).catch(() => null)
  if (support?.supported === false && /gateway|batching/i.test(support.error ?? '')) {
    throw new Error(support.error ?? 'This endpoint cannot be paid through Gateway.')
  }

  try {
    return await payOnce(client, step, payOptions, inQuery)
  } catch (err) {
    const detail = safeErrorMessage(err)
    if (!isMethodNotAllowed(detail)) throw err

    const flipped = step.httpMethod === 'POST' ? 'GET' : 'POST'
    const probe = await fetch(step.endpointUrl, { method: flipped }).catch(() => null)
    if (probe?.status !== 402) throw err

    console.warn(
      '[trident] catalog method wrong, retrying:',
      JSON.stringify({ url: step.endpointUrl, was: step.httpMethod, now: flipped }),
    )

    // The published location no longer applies once the verb has changed under
    // us, so fall back to the convention for the new one.
    step.httpMethod = flipped
    return await client.pay(
      requestUrl(step, flipped === 'GET'),
      flipped === 'POST' ? ({ method: 'POST', body: step.params } as const) : undefined,
    )
  }
}

/** The public address for a signing key, for balance lookups. */
function addressOf(privateKey: string): string {
  return privateKeyToAccount(privateKey as `0x${string}`).address
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

  /**
   * Move funds to a chain this service can be paid on, when they are elsewhere.
   *
   * Returns null when bridging cannot help — no deployment on either side, no
   * chain with enough to send, or the keeper is not configured. The caller then
   * reports the ordinary "wrong chain" refusal, which names what to deposit.
   *
   * A failure here is surfaced rather than swallowed: it means the user's money
   * moved, or tried to, and telling them the service was simply unavailable
   * would be a lie about their balance.
   */
  const bridgeForStep = async (
    step: PlanStep,
    service: Service,
    policy: ChainPolicy,
    balances: Map<SupportedChainName, number>,
  ): Promise<{ chain: SupportedChainName; creditedUsdc: number } | null> => {
    // Where the seller will take payment, preferring somewhere we can deliver.
    const target = service.networks.find(
      (option) =>
        !option.isTestnet &&
        option.gatewayBatchable === true &&
        policy.allowed.includes(option.chainKey) &&
        canBridgeTo(option.chainKey),
    )
    if (!target || !KEEPER_PRIVATE_KEY) return null

    // The cheapest source that can cover it outright. Splitting across chains
    // would mean several burns and several fees for one small invoice.
    const needed = target.priceUsdc
    const source = [...balances.entries()]
      .filter(([chain, held]) => chain !== target.chainKey && held >= needed && canBridgeTo(chain))
      .sort((a, b) => a[1] - b[1])[0]
    if (!source) return null

    /*
     * Send more than this one call needs.
     *
     * Each bridge costs a CCTP fee and minutes of waiting, so moving exactly
     * one invoice's worth would repeat that on the next call to the same
     * seller. Ten times the price, capped by what is actually held, amortises
     * it without stranding a meaningful balance on a chain the user may never
     * use again.
     */
    const amount = Math.min(source[1], Math.max(needed * 10, needed))
    const atomic = BigInt(Math.floor(amount * 1_000_000))

    emit(res, 'step_start', {
      stepIndex: step.stepIndex,
      serviceName: step.serviceName,
      endpointUrl: step.endpointUrl,
      purpose: `Moving ${amount} USDC from ${source[0]} to ${target.chainKey} to pay this`,
    })

    const result = await bridgeToGatewayBalance(
      agentPrivateKey,
      source[0],
      target.chainKey,
      atomic,
      (progress) => {
        console.warn(
          '[trident] bridging:',
          JSON.stringify({
            taskId,
            from: source[0],
            to: target.chainKey,
            stage: progress.stage,
            detail: progress.detail,
          }),
        )
      },
    )

    const creditedUsdc = Number(result.creditedAtomic) / 1_000_000
    balances.set(source[0], source[1] - amount)
    console.warn(
      '[trident] bridged:',
      JSON.stringify({
        taskId,
        to: target.chainKey,
        creditedUsdc,
        burnTx: result.burnTxHash,
        sweepTx: result.sweepTxHash,
      }),
    )
    return { chain: target.chainKey, creditedUsdc }
  }

  /*
   * Where this wallet's Gateway money actually is, read once for the run.
   *
   * Settlement can only draw from the chain the invoice names, so this decides
   * which of a service's networks are usable. One request covering every
   * mainnet domain; undefined if it fails, which disables the check rather
   * than blocking a run on a balance lookup.
   */
  const gatewayBalances = policy.mainnetEnabled
    ? await unifiedGatewayBalance(addressOf(agentPrivateKey), GATEWAY_MAINNET_CHAINS)
        .then((unified) => {
          const byChain = new Map<SupportedChainName, number>()
          for (const entry of unified.byChain) byChain.set(entry.chain, Number(entry.usdc))
          return byChain
        })
        .catch(() => undefined)
    : undefined

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
      let service = findServiceByResource(step.endpointUrl)

      /**
       * Providers this step has already tried, so a substitute is never one we
       * just watched fail.
       */
      const attempted = new Set<string>([step.endpointUrl])
      /** The service the user approved, for the message if everything is down. */
      const approvedService = service
      let attemptsLeft = MAX_ENDPOINT_ATTEMPTS

      // Re-entered when an endpoint fails and a substitute is available. The
      // user asked for an answer, not for a particular provider.
      // eslint-disable-next-line no-constant-condition
      for (;;) {
      try {
        // Defence in depth: approvedSteps arrive from the client and could be
        // edited, so the endpoint is re-checked against the registry here and
        // matched exactly — never by prefix.
        if (!service) {
          throw new Error(`Endpoint is not in the service registry: ${step.endpointUrl}`)
        }

        // Chain is decided here, not by the client: a tampered request must not
        // be able to move spending onto mainnet when the user has not opted in.
        const chainOpts = {
          gatewayOnly: service.source === 'x402',
          ...(gatewayBalances ? { balances: gatewayBalances } : {}),
        }
        let choice = chooseChain(service.networks, policy, chainOpts)

        /*
         * Nothing settleable where the money is — so move the money.
         *
         * Only reached when the wallet holds enough overall but on the wrong
         * chain, which is the common case for a seller who prices on a single
         * network. The funds are bridged into the user's Gateway balance on the
         * chain the invoice names, and the choice is remade against real
         * balances rather than assumed to have worked.
         *
         * Deliberately after the plan is approved and the price is known: this
         * costs a CCTP fee and minutes of waiting, and doing it speculatively
         * for a call that might not happen would spend the user's money on a
         * transfer they never asked for.
         */
        if (!choice && gatewayBalances && service.source === 'x402') {
          const bridged = await bridgeForStep(step, service, policy, gatewayBalances)
          if (bridged) {
            gatewayBalances.set(
              bridged.chain,
              (gatewayBalances.get(bridged.chain) ?? 0) + bridged.creditedUsdc,
            )
            choice = chooseChain(service.networks, policy, {
              ...chainOpts,
              balances: gatewayBalances,
            })
          }
        }

        if (!choice) {
          throw new Error(
            unpayableReason(service.networks, policy, chainOpts) ??
              'No permitted settlement network',
          )
        }

        /*
         * Refuse to spend on a call that cannot answer the question.
         *
         * Everything below this line moves money — the x402 payment, and on the
         * free path the Arc Testnet verification transfer. A call missing a
         * required parameter has two ways to end and both are bad: the endpoint
         * rejects it and the user has paid for an error, or it accepts it and
         * answers about something else. A request for the University of Ibadan
         * that reached the geocoder without a `name` was answered with Lagos,
         * at 200, and billed.
         *
         * The registry's list is the authority here, not the plan's — see
         * missingRequiredParams.
         */
        const missing = missingRequiredParams(service.requiredParams, step.params)
        if (missing.length > 0) {
          throw new Error(
            `${service.serviceName} needs ${missing.join(', ')} to answer this, and the request ` +
              `did not include ${missing.length === 1 ? 'it' : 'them'}. Nothing was charged.`,
          )
        }

        // Present but not permitted — see invalidEnumParams.
        const invalid = invalidEnumParams(service.paramEnums, step.params)
        if (invalid.length > 0) {
          throw new Error(
            `${service.serviceName} does not accept the requested ${invalid.join(', ')} ` +
              `(${invalid.map((name) => String(step.params[name])).join(', ')}). Nothing was charged.`,
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

          const response = await callFreeApi(requestUrl(step), {
            method: step.httpMethod,
            ...(step.httpMethod === 'POST' ? { body: step.params } : {}),
          })
          data = response.data
        } else {
          /*
           * A POST does not imply a body. Eight of the catalog's POST services
           * declare `queryParams` instead, and sending them a body left the
           * query string empty — AIsa's scholar search answered "Field
           * required" for a field that had been supplied, to the wrong place.
           * Where no schema was published at all, a body is the safer guess.
           */
          const inQuery = step.httpMethod === 'GET' || service.paramLocation === 'query'
          const payOptions =
            step.httpMethod === 'POST' && !inQuery
              ? ({ method: 'POST', body: step.params } as const)
              : undefined

          /*
           * Price the call at the endpoint, not from the catalog, and hold the
           * cap against that.
           *
           * Some sellers price per request: BlockRun lists 0.003 and quoted
           * 0.027982 for one model. The cap was being tested against the
           * catalogued figure and the wallet charged the live one, so an
           * "absolute" cap could be exceeded nearly tenfold without anything
           * noticing. The quote is exact and is never rounded — it is the
           * number that will be paid.
           */
          const quote = await quoteFromEndpoint(requestUrl(step, inQuery), choice.chain, {
            method: step.httpMethod,
            ...(payOptions ? { body: step.params } : {}),
          })

          if (quote && totalSpent + Number(quote.amountUsdc) > spendingCapUsdc) {
            emit(res, 'cap_exceeded', {
              taskId,
              totalSpent,
              spendingCapUsdc,
              nextStepCost: Number(quote.amountUsdc),
              quotedUsdc: quote.amountUsdc,
              catalogUsdc: step.estimatedCostUsdc,
            })
            await emitSummary('stopped')
            finish('stopped')
            return
          }

          const result = await payWithMethodRecovery(
            clientFor(choice.chain),
            step,
            payOptions,
            inQuery,
          )
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
        let detail = safeErrorMessage(err)

        /*
         * An endpoint being down is our problem, not the user's. Remember it so
         * the planner stops offering it, then try something equivalent that
         * costs no more than what was approved. Only when nothing works does
         * this become something to report.
         */
        noteEndpointFailure(step.endpointUrl)
        attemptsLeft -= 1

        if (service && attemptsLeft > 0) {
          /*
           * Only stand in for an endpoint if the parameters we already have
           * mean the same thing there.
           *
           * Substitution reuses step.params wholesale, which is safe only while
           * the two services agree on them. BlockRun's /chat/completions and
           * /api/v1/messages differ by one required field and an entirely
           * different model list, so the failover produced a request that could
           * not succeed — and reported it as the substitute being broken.
           */
          const substitute = findAlternatives(
            service,
            step.purpose,
            step.estimatedCostUsdc,
            policy.allowed,
            attempted,
          ).find((candidate) => paramsFit(candidate, step.params))

          if (substitute) {
            console.warn(
              '[trident] endpoint failed, substituting:',
              // The reason belongs here. Without it the log records only that
              // something was swapped, which is the one thing already obvious.
              JSON.stringify({
                from: step.endpointUrl,
                to: substitute.resource,
                reason: detail.slice(0, 200),
              }),
            )
            attempted.add(substitute.resource)
            step.endpointUrl = substitute.resource
            step.serviceName = substitute.serviceName
            step.httpMethod = substitute.httpMethod
            service = substitute
            db.prepare(
              `UPDATE task_steps SET service_name = ?, endpoint_url = ?, http_method = ?
               WHERE task_id = ? AND step_index = ?`,
            ).run(substitute.serviceName, substitute.resource, substitute.httpMethod, taskId, step.stepIndex)
            continue
          }
        }

        /*
         * Recover what the endpoint actually said.
         *
         * Two ways the SDK loses it. It stringifies a structured error into
         * "[object Object]", and it reports only the `error` field of the
         * response body — so "Payment failed: Payment settlement failed"
         * arrives with whatever detail sat alongside it discarded. Settlement
         * is the step that costs money and the hardest to reason about after
         * the fact; the body is the only account of it we get.
         */
        {
          const body = safeRecordedBody(step)
          if (detail.includes('[object Object]') && body) {
            detail = `${detail.replace('[object Object]', '').trim()} ${body}`
          } else if (body && !detail.includes(body.slice(0, 40))) {
            detail = `${detail} — endpoint said: ${body}`
          }
        }

        /**
         * The only place a failed endpoint is recorded where an operator can
         * find it. Everything else about a failure lives in the task row, which
         * needs the owner's session to read — so a support question about "it
         * did not work" was previously unanswerable from the server side.
         *
         * Deliberately one line, structured, and free of anything sensitive:
         * no key, no parameters, no response body.
         */
        console.error(
          '[trident] step failed:',
          JSON.stringify({
            taskId,
            step: step.stepIndex,
            service: step.serviceName,
            url: step.endpointUrl,
            method: step.httpMethod,
            source: service?.source ?? 'unknown',
            chain: service
              ? (chooseChain(service.networks, policy, {
                  gatewayOnly: service.source === 'x402',
                })?.chain ?? null)
              : null,
            status: httpStatusOf(detail),
            error: detail.slice(0, 300),
          }),
        )

        /*
         * Everything that could serve this step has now been tried. Say which
         * provider, and that it may work later — the raw SDK text describes a
         * protocol failure the user cannot act on.
         */
        /*
         * Only reachability gets the reassuring wording. A refusal on policy —
         * an endpoint outside the registry, a chain the user has not enabled,
         * a service Gateway cannot settle — is a decision, not an outage, and
         * calling it "not reachable right now" both misleads the user and
         * hides a security refusal behind an apology.
         */
        const reported = isPolicyRefusal(detail) || isBalanceError(detail)
          ? detail
          : `${approvedService?.serviceName ?? step.serviceName} is not reachable right now. ` +
            `Nothing else in the catalog could do this step, so it is worth trying again later.`

        db.prepare(
          `UPDATE task_steps
           SET status = 'failed', response_summary = ?, completed_at = strftime('%s','now')
           WHERE task_id = ? AND step_index = ?`,
        ).run(detail.slice(0, 500), taskId, step.stepIndex)

        results.push({
          stepIndex: step.stepIndex,
          serviceName: approvedService?.serviceName ?? step.serviceName,
          purpose: step.purpose,
          status: 'failed',
          data: reported,
          costUsdc: 0,
          source: service?.source === 'free' ? 'free' : 'x402',
        })

        emit(res, 'step_failed', { stepIndex: step.stepIndex, error: reported, totalSpent })

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
        // Nothing left to try for this step; move on to the next one.
        break
      }
      break
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
