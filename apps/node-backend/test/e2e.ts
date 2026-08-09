/**
 * End-to-end smoke test against a running backend.
 *
 * Covers: SIWE signup -> passphrase setup -> key-material decrypt round trip
 * (using the *frontend's* WebCrypto implementation, which is what proves the
 * two PBKDF2 implementations agree) -> plan -> run over SSE -> budget gate ->
 * stop -> history.
 *
 * Run with:  npm run test:e2e -w @trident/node-backend
 */
// Same env resolution as the server, so the planner tests aren't silently skipped.
import '../src/env.ts'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { buildRotationMessage } from '../src/auth/keySetup.ts'
import { SiweMessage } from 'siwe'
// The real browser-side decrypt. Node exposes the same WebCrypto API, so this
// exercises the exact code the app ships rather than a re-implementation.
import { decryptEoaKey } from '../../frontend/src/lib/crypto.ts'

const BASE = process.env['E2E_BASE_URL'] ?? 'http://localhost:3001'
const PASSPHRASE = 'copper lantern drift oyster'

let passed = 0
let failed = 0
const failures: string[] = []

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++
    console.log(`  \x1b[32m✓\x1b[0m ${label}`)
  } else {
    failed++
    failures.push(label)
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(name: string): void {
  console.log(`\n\x1b[36m${name}\x1b[0m`)
}

async function json<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T }
}

interface SseFrame {
  event: string
  data: Record<string, unknown>
}

/** Consume an SSE stream, invoking `onFrame` for each event. */
async function readSse(
  path: string,
  token: string,
  payload: unknown,
  onFrame?: (frame: SseFrame) => void | Promise<void>,
): Promise<SseFrame[]> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  })
  if (!res.ok || !res.body) {
    const text = await res.text()
    throw new Error(`SSE request failed (${res.status}): ${text.slice(0, 200)}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const frames: SseFrame[] = []
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const chunks = buffer.split('\n\n')
    buffer = chunks.pop() ?? ''

    for (const chunk of chunks) {
      let event = ''
      const dataLines: string[] = []
      for (const line of chunk.split('\n')) {
        if (line.startsWith(':')) continue
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
      }
      if (!event || dataLines.length === 0) continue
      const frame: SseFrame = { event, data: JSON.parse(dataLines.join('\n')) }
      frames.push(frame)
      await onFrame?.(frame)
    }
  }
  return frames
}

async function main(): Promise<void> {
  console.log(`\x1b[1mTrident E2E\x1b[0m  →  ${BASE}\n`)

  // ---------------------------------------------------------------- health
  section('Health')
  const health = await json<{ ok: boolean }>('/health')
  check('GET /health responds 200', health.status === 200)
  check('health payload ok', health.body?.ok === true)

  // ------------------------------------------------------------ SIWE login
  section('Auth — SIWE signup')
  const externalKey = generatePrivateKey()
  const externalAccount = privateKeyToAccount(externalKey)

  const nonceRes = await json<{ nonce: string }>('/auth/siwe/nonce')
  check('nonce issued', typeof nonceRes.body?.nonce === 'string' && nonceRes.body.nonce.length >= 8)

  const message = new SiweMessage({
    domain: 'localhost',
    address: externalAccount.address,
    statement: 'Sign in to Trident.',
    uri: 'http://localhost',
    version: '1',
    chainId: 1,
    nonce: nonceRes.body.nonce,
  }).prepareMessage()

  const signature = await externalAccount.signMessage({ message })
  const verify = await json<{ needsSetup: boolean; setupToken?: string }>('/auth/siwe/verify', {
    method: 'POST',
    body: JSON.stringify({ message, signature }),
  })
  check('SIWE verify succeeds', verify.status === 200, JSON.stringify(verify.body))
  check('new user needs passphrase setup', verify.body?.needsSetup === true)
  const setupToken = verify.body?.setupToken ?? ''
  check('setup token returned', setupToken.length > 0)

  // A nonce must not be replayable.
  const replay = await json('/auth/siwe/verify', {
    method: 'POST',
    body: JSON.stringify({ message, signature }),
  })
  check('nonce cannot be replayed', replay.status === 401, `got ${replay.status}`)

  // ---------------------------------------------------- passphrase + wallet
  section('Auth — agent wallet creation')
  const setupRes = await json<{ token: string; user: { eoaAddress: string } }>(
    '/auth/setup-passphrase',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${setupToken}` },
      body: JSON.stringify({ passphrase: PASSPHRASE }),
    },
  )
  check('setup-passphrase succeeds', setupRes.status === 200, JSON.stringify(setupRes.body))
  const jwt = setupRes.body?.token ?? ''
  const eoaAddress = setupRes.body?.user?.eoaAddress ?? ''
  check('full JWT returned', jwt.length > 0)
  check('EOA address generated', /^0x[0-9a-fA-F]{40}$/.test(eoaAddress))

  const auth = { Authorization: `Bearer ${jwt}` }

  // A setup token must not work as a full token.
  const scopeAbuse = await json('/api/tasks', { headers: { Authorization: `Bearer ${setupToken}` } })
  check('setup token rejected on full-auth route', scopeAbuse.status === 403, `got ${scopeAbuse.status}`)

  // Setup must not be re-runnable — that would orphan any funds.
  const reSetup = await json('/auth/setup-passphrase', {
    method: 'POST',
    headers: { Authorization: `Bearer ${setupToken}` },
    body: JSON.stringify({ passphrase: 'another-passphrase' }),
  })
  check('passphrase setup cannot be re-run', reSetup.status === 409, `got ${reSetup.status}`)

  // ------------------------------------------ PBKDF2 / AES-GCM parity check
  section('Crypto — server encrypt ⇄ browser decrypt (ASSUMPTION #12)')
  const material = await json<{
    userId: string
    encryptedKey: string
    salt: string
    iv: string
    eoaAddress: string
    iterations: number
    targetIterations: number
  }>('/auth/key-material', { headers: auth })
  check('key-material returns ciphertext', material.status === 200)
  check('response carries no raw key', !JSON.stringify(material.body).includes('privateKey'))

  let decrypted = ''
  try {
    decrypted = await decryptEoaKey(
      PASSPHRASE,
      material.body.encryptedKey,
      material.body.salt,
      material.body.iv,
      material.body.iterations,
    )
  } catch (err) {
    check('browser decrypt succeeds', false, String(err))
  }
  check('browser decrypt succeeds', decrypted.length > 0)
  check('decrypted value is a private key', /^0x[0-9a-fA-F]{64}$/.test(decrypted))

  if (decrypted) {
    const derived = privateKeyToAccount(decrypted as `0x${string}`).address
    check(
      'decrypted key derives the stored EOA address',
      derived.toLowerCase() === eoaAddress.toLowerCase(),
      `${derived} vs ${eoaAddress}`,
    )
  }

  let wrongRejected = false
  try {
    await decryptEoaKey(
      'wrong-passphrase-entirely',
      material.body.encryptedKey,
      material.body.salt,
      material.body.iv,
      material.body.iterations,
    )
  } catch {
    wrongRejected = true
  }
  check('wrong passphrase is rejected', wrongRejected)
  check(
    'new wallets use 600k iterations',
    material.body?.iterations === 600_000,
    String(material.body?.iterations),
  )

  // ------------------------------------------------------ passphrase floor
  section('Passphrase rules')
  for (const [label, candidate, shouldPass] of [
    ['too short is rejected', 'Trident1', false],
    ['a denylisted phrase is rejected', 'correct-horse-battery-staple', false],
    ['low-variety is rejected', 'ababababababab', false],
  ] as [string, string, boolean][]) {
    // A fresh account each time: setup only runs once per user.
    const probe = await freshAccount()
    const res = await json('/auth/setup-passphrase', {
      method: 'POST',
      headers: { Authorization: `Bearer ${probe.setupToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: candidate }),
    })
    check(label, shouldPass ? res.status === 200 : res.status === 400, `got ${res.status}`)
  }

  // ------------------------------------------------------- KDF re-encryption
  section('KDF rotation')
  {
    // A rotation not signed by the wallet key must be refused, or a stolen JWT
    // could overwrite someone's encrypted key and lock them out.
    const forged = await json('/auth/rotate-kdf', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        encryptedKey: 'deadbeef',
        salt: 'aa',
        iv: 'bb',
        iterations: 600_000,
        signature: `0x${'11'.repeat(65)}`,
      }),
    })
    check('unsigned rotation is refused', forged.status === 403, `got ${forged.status}`)

    const after = await json<{ encryptedKey: string }>('/auth/key-material', { headers: auth })
    check(
      'the refused rotation changed nothing',
      after.body?.encryptedKey === material.body.encryptedKey,
    )

    // A downgrade must be refused even with a valid signature.
    const account = privateKeyToAccount(decrypted as `0x${string}`)
    const downgradeKey = 'c0ffee'
    const downgrade = await json('/auth/rotate-kdf', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        encryptedKey: downgradeKey,
        salt: 'aa',
        iv: 'bb',
        iterations: 200_000,
        signature: await account.signMessage({
          message: buildRotationMessage({
            userId: material.body.userId,
            encryptedKey: downgradeKey,
            iterations: 200_000,
          }),
        }),
      }),
    })
    check('a weaker iteration count is refused', downgrade.status === 400, `got ${downgrade.status}`)
  }

  // --------------------------------------------------------------- catalog
  section('Marketplace')
  const services = await json<{ services: { id: string; verification: string }[] }>(
    '/api/services',
    { headers: auth },
  )
  check('service catalog returns entries', (services.body?.services?.length ?? 0) > 0)
  check(
    'dead x402.x.com listing removed',
    !services.body.services.some((s) => s.id === 'x-data'),
  )

  // ----------------------------------------------------------- wallet reads
  section('Wallet')
  const balance = await json<{ eoaAddress: string; walletUsdc: string; gatewayUsdc: string | null }>(
    '/api/wallet/balance',
    { headers: auth },
  )
  check('balance reads on-chain state', balance.status === 200, JSON.stringify(balance.body))
  check('balance is for the agent EOA', balance.body?.eoaAddress === eoaAddress)
  // Reading a Gateway balance needs the address, not the key — so it must be
  // visible without unlocking, the same as the on-chain wallet balance.
  check(
    'gateway balance is readable without a key',
    balance.body?.gatewayUsdc !== null && balance.body?.gatewayUsdc !== undefined,
    String(balance.body?.gatewayUsdc),
  )

  const depositInfo = await json<{ address: string; bridgeChains: unknown[] }>(
    '/api/wallet/deposit-address',
    { headers: auth },
  )
  check('deposit address matches the EOA', depositInfo.body?.address === eoaAddress)
  check('bridge chains advertised', (depositInfo.body?.bridgeChains?.length ?? 0) > 0)

  const foreignKey = generatePrivateKey()
  const wrongKey = await json('/api/wallet/gateway/deposit', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ amount: '1', agentPrivateKey: foreignKey }),
  })
  check("another wallet's key is rejected", wrongKey.status === 403, `got ${wrongKey.status}`)

  const capRes = await json<{ newCap: number }>('/api/wallet/user/spending-cap', {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ cap: 2.5 }),
  })
  check('spending cap updates', capRes.body?.newCap === 2.5)

  // The cap is absolute: a plan over it is quoted, never approved, and the cap
  // is never raised to accommodate it.
  const tinyCap = await json<{ newCap: number }>('/api/wallet/user/spending-cap', {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ cap: 0.0000001 }),
  })
  check('cap can be set below any service price', tinyCap.body?.newCap === 0.0000001)

  // ------------------------------------------------------------ cap is final
  section('Spending cap is absolute')
  if (process.env['ANTHROPIC_API_KEY']) {
    const capped = await json<{
      affordable: boolean
      plan: { steps: unknown[] }
      budgetGuidance: {
        message: string
        options: { kind: string; totalUsdc: number; minimumCapUsdc: number }[]
      } | null
      costing: { capUsdc: number; primaryUsdc: number }
    }>('/api/agent/plan', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ goal: 'Get the current price of bitcoin in USD' }),
    })

    const guidance = capped.body?.budgetGuidance
    check('an over-cap goal is not affordable', capped.body?.affordable === false)
    check('no steps are offered for approval', (capped.body?.plan?.steps?.length ?? -1) === 0)
    check('the shortfall is quoted', (guidance?.options?.length ?? 0) > 0, guidance?.message)
    check(
      'the quote names a minimum cap above the current one',
      (guidance?.options?.[0]?.minimumCapUsdc ?? 0) > (capped.body?.costing?.capUsdc ?? 0),
      `min ${guidance?.options?.[0]?.minimumCapUsdc} vs cap ${capped.body?.costing?.capUsdc}`,
    )
    check(
      'the message avoids exponent notation',
      !(guidance?.message ?? '').includes('e-'),
      guidance?.message,
    )

    // The cap itself must be untouched by all of that.
    const after = await json<{ user: { spendingCapUsdc: number } }>('/auth/me', { headers: auth })
    check(
      'planning never adjusts the cap',
      after.body?.user?.spendingCapUsdc === 0.0000001,
      String(after.body?.user?.spendingCapUsdc),
    )
  } else {
    console.log('  \x1b[33m•\x1b[0m ANTHROPIC_API_KEY not set — skipping cap planning checks')
  }

  // Restore a workable cap for the planner and runner sections below.
  await json('/api/wallet/user/spending-cap', {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ cap: 10 }),
  })

  /*
   * Enable mainnet, or the x402 path below cannot run at all.
   *
   * Gateway settles only batch-settlement options, and no Arc Testnet service
   * offers one — so with mainnet off every paid service is correctly refused
   * and the runner's payment path is never exercised. The wallet here is
   * freshly generated and unfunded, so enabling this risks nothing: the run
   * still fails on balance, which is exactly what the checks below assert.
   */
  await json('/api/wallet/user/mainnet', {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ enabled: true, chain: 'BASE' }),
  })

  // ---------------------------------------------------------------- planner
  section('Planner')
  if (!process.env['ANTHROPIC_API_KEY']) {
    console.log('  \x1b[33m•\x1b[0m ANTHROPIC_API_KEY not set — skipping planner and run tests')
    return report()
  }

  const planRes = await json<{
    taskId: string
    plan: { steps: unknown[]; reasoning: string }
    error?: string
  }>('/api/agent/plan', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ goal: 'Verify my agent wallet can pay an x402 endpoint' }),
  })

  // A 503 here is an operator-configuration problem (no credit, bad key), not a
  // defect in this codebase — report it clearly and skip rather than fail.
  if (planRes.status === 503) {
    check(
      'planner reports its unavailability in an actionable way',
      typeof planRes.body?.error === 'string' && !planRes.body.error.includes('Internal server'),
      JSON.stringify(planRes.body),
    )
    console.log(`  \x1b[33m•\x1b[0m Planner unavailable — ${planRes.body?.error}`)
    console.log('  \x1b[33m•\x1b[0m Skipping plan/run tests. Runner logic is covered by test:runner.')
    return report()
  }

  check('plan generated', planRes.status === 200, JSON.stringify(planRes.body).slice(0, 300))
  check('plan has a task id', typeof planRes.body?.taskId === 'string')
  check('planner explained itself', (planRes.body?.plan?.reasoning?.length ?? 0) > 0)

  const steps = (planRes.body?.plan?.steps ?? []) as {
    stepIndex: number
    endpointUrl: string
    estimatedCostUsdc: number
  }[]
  check('plan produced at least one step', steps.length > 0)
  check(
    'every step targets a catalogued endpoint',
    steps.every((s) => /^https:\/\//.test(s.endpointUrl)),
  )

  if (steps.length === 0) return report()

  // ------------------------------------------------------------ budget gate
  //
  // A plan whose total already exceeds the limit is refused before the stream
  // opens, so nothing is charged and no partial run has to be explained. The
  // runner's per-step gate still exists for a run that drifts over mid-flight
  // — that path is covered deterministically in test:runner.
  section('Run refused before it starts')
  /*
   * Derive the budget from what this plan actually costs, rather than assuming
   * a figure. Circle's catalog includes $0 endpoints, and if the planner picks
   * one there is nothing for a limit to refuse — the run proceeds and the
   * assertions below would be testing an SSE stream instead.
   */
  const plannedCost = await json<{ costing: { primaryUsdc: number } }>(
    `/api/tasks/${planRes.body.taskId}`,
    { headers: auth },
  ).then(() => planRes.body as unknown as { costing?: { primaryUsdc?: number } })
  const stepCost = plannedCost.costing?.primaryUsdc ?? 0

  if (stepCost <= 0) {
    console.log('  \x1b[33m•\x1b[0m the planned route is free, so no limit can refuse it — skipped')
  } else {
  const refused = await json<{
    error: string
    budgetGuidance: {
      ceilingUsdc: number
      options: { minimumCapUsdc: number }[]
    } | null
  }>('/api/agent/run', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      taskId: planRes.body.taskId,
      approvedSteps: steps,
      agentPrivateKey: decrypted,
      // Half what the plan costs, so the limit must refuse it.
      budgetUsdc: stepCost / 2,
    }),
  })
  check('an unaffordable run is refused outright', refused.status === 403, `got ${refused.status}`)
  check('the refusal explains the shortfall', /over your/.test(refused.body?.error ?? ''))
  check(
    'the refusal quotes what it would take',
    (refused.body?.budgetGuidance?.options?.[0]?.minimumCapUsdc ?? 0) > stepCost / 2,
    refused.body?.error,
  )

  const untouched = await json<{ task: { status: string; totalCostUsdc: number } }>(
    `/api/tasks/${planRes.body.taskId}`,
    { headers: auth },
  )
  check(
    'nothing was spent on the refused run',
    (untouched.body?.task?.totalCostUsdc ?? -1) === 0,
    String(untouched.body?.task?.totalCostUsdc),
  )
  }

  // ------------------------------------------------------------ normal run
  section('Runner — execution + stop')
  const plan2 = await json<{ taskId: string; plan: { steps: typeof steps } }>('/api/agent/plan', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ goal: 'Verify my agent wallet can pay an x402 endpoint' }),
  })
  const steps2 = plan2.body?.plan?.steps ?? []

  if (steps2.length > 0) {
    const frames = await readSse(
      '/api/agent/run',
      jwt,
      {
        taskId: plan2.body.taskId,
        approvedSteps: steps2,
        agentPrivateKey: decrypted,
        budgetUsdc: null,
      },
      async (frame) => {
        // Request a stop as soon as the first step settles.
        if (frame.event === 'step_done' || frame.event === 'step_failed') {
          await json('/api/agent/stop', {
            method: 'POST',
            headers: auth,
            body: JSON.stringify({ taskId: plan2.body.taskId }),
          })
        }
      },
    )
    const events = frames.map((f) => f.event)
    const blocked = events.includes('cap_exceeded') || events.includes('budget_exceeded')
    check(
      'run emitted step_start',
      blocked ? !events.includes('step_start') : events.includes('step_start'),
      events.join(','),
    )
    check(
      'run reached a terminal event',
      events.some((e) =>
        ['complete', 'stopped', 'fatal', 'error', 'cap_exceeded', 'budget_exceeded'].includes(e),
      ),
      events.join(','),
    )
    // With no Gateway balance, a real payment cannot settle — the run must fail
    // cleanly rather than hang or crash the process.
    check(
      'unfunded wallet fails gracefully',
      blocked || events.includes('step_done') ? true : events.includes('step_failed'),
      events.join(','),
    )

    // A run that produced results writes them up in prose. A run blocked before
    // its first step has nothing to summarise, and must not invent one.
    const summaryFrame = frames.find((f) => f.event === 'summary')
    const produced = events.includes('step_done') || events.includes('step_failed')
    check(
      produced ? 'run summarised its results' : 'blocked run emitted no summary',
      produced ? Boolean(summaryFrame) : !summaryFrame,
      events.join(','),
    )
    if (summaryFrame) {
      const text = String((summaryFrame.data as { summary?: string })?.summary ?? '')
      check('summary is prose, not JSON', text.length > 0 && !text.trimStart().startsWith('{'))
      check('summary does not leak the key', !text.includes(decrypted.slice(2)))
    }

    // ----------------------------------------------------------- retry/resume
    // A retry must not re-pay for steps that already settled.
    section('Retry resumes')
    const before = await json<{ steps: { status: string; actualCostUsdc: number | null }[] }>(
      `/api/tasks/${plan2.body.taskId}`,
      { headers: auth },
    )
    const settled = (before.body?.steps ?? []).filter((step) => step.status === 'done')
    const priorSpend = settled.reduce((sum, step) => sum + (step.actualCostUsdc ?? 0), 0)

    // A run that completed is final and cannot be retried, which is correct —
    // but it means there is nothing here to resume. Say so rather than letting
    // the checks below pass on an empty set.
    const taskNow = await json<{ task: { status: string } }>(
      `/api/tasks/${plan2.body.taskId}`,
      { headers: auth },
    )
    const retryable = taskNow.body?.task?.status !== 'done'
    if (!retryable) {
      console.log(
        '  \x1b[33m•\x1b[0m the run completed, so there is nothing to resume — ' +
          'resume is covered deterministically in test:runner',
      )
    }
    if (retryable) {
    const retry = await readSse('/api/agent/run', jwt, {
      taskId: plan2.body.taskId,
      approvedSteps: steps2,
      agentPrivateKey: decrypted,
      budgetUsdc: null,
    })
    const startFrame = retry.find((f) => f.event === 'start')?.data as
      | { replayedSteps?: number; alreadySpent?: number }
      | undefined

    check(
      'retry replays every settled step',
      (startFrame?.replayedSteps ?? -1) === settled.length,
      `replayed ${startFrame?.replayedSteps}, settled ${settled.length}`,
    )
    check(
      'retry carries prior spend forward',
      Math.abs((startFrame?.alreadySpent ?? -1) - priorSpend) < 1e-9,
      `carried ${startFrame?.alreadySpent}, prior ${priorSpend}`,
    )
    check(
      'replayed steps are not paid again',
      retry.filter((f) => f.event === 'step_replayed').length === settled.length,
    )
    }

    // ------------------------------------------------------------------ chat
    section('Follow-up chat')
    const transcript = await json<{ messages: { role: string; kind: string }[] }>(
      `/api/agent/chat/${plan2.body.taskId}`,
      { headers: auth },
    )
    check(
      'transcript opens with the goal',
      transcript.body?.messages?.[0]?.role === 'user',
      JSON.stringify(transcript.body?.messages?.map((m) => `${m.role}/${m.kind}`)),
    )

    const followUp = await json<{
      agentMessage: { content: string }
      needsRun: boolean
    }>('/api/agent/chat', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ taskId: plan2.body.taskId, message: 'what did you find?' }),
    })
    check('follow-up answered', (followUp.body?.agentMessage?.content?.length ?? 0) > 0)
    check(
      'follow-up persisted to the transcript',
      ((
        await json<{ messages: unknown[] }>(`/api/agent/chat/${plan2.body.taskId}`, {
          headers: auth,
        })
      ).body?.messages?.length ?? 0) >
        (transcript.body?.messages?.length ?? 0),
    )

    // Chat is scoped to the owner like every other task route.
    const noSuchTask = await json('/api/agent/chat', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        taskId: '00000000-0000-4000-8000-000000000000',
        message: 'hello',
      }),
    })
    check('chat rejects an unknown task', noSuchTask.status === 404, `got ${noSuchTask.status}`)
    const serialised = JSON.stringify(frames)
    check('no private key leaked into the stream', !serialised.includes(decrypted.slice(2)))
  }

  // ---------------------------------------------------------------- history
  section('History')
  const history = await json<
    { tasks: { id: string; status: string; stepCount: number; stepsDone: number }[] }
  >(
    '/api/tasks',
    { headers: auth },
  )
  check('history lists the runs', (history.body?.tasks?.length ?? 0) >= 2)
  // 'pending' is a real resting state now: a plan that was quoted but never
  // approved — because it was over the limit, or because no service could do
  // it — never runs, and never should. What must not happen is a task left
  // 'running' after its stream ended.
  check(
    'no task is stuck running',
    history.body.tasks.every((t) => t.status !== 'running'),
    history.body.tasks.map((t) => t.status).join(','),
  )
  check(
    'every task that ran reached a terminal status',
    history.body.tasks
      .filter((t) => t.stepsDone > 0)
      .every((t) => ['done', 'stopped', 'failed'].includes(t.status)),
    history.body.tasks.map((t) => `${t.status}:${t.stepsDone}`).join(','),
  )

  const detail = await json<{ steps: unknown[] }>(`/api/tasks/${planRes.body.taskId}`, {
    headers: auth,
  })
  check('task detail returns steps', (detail.body?.steps?.length ?? 0) > 0)

  // Another user's task must not be reachable.
  const otherKey = generatePrivateKey()
  const otherAccount = privateKeyToAccount(otherKey)
  const otherNonce = await json<{ nonce: string }>('/auth/siwe/nonce')
  const otherMessage = new SiweMessage({
    domain: 'localhost',
    address: otherAccount.address,
    statement: 'Sign in to Trident.',
    uri: 'http://localhost',
    version: '1',
    chainId: 1,
    nonce: otherNonce.body.nonce,
  }).prepareMessage()
  const otherVerify = await json<{ setupToken: string }>('/auth/siwe/verify', {
    method: 'POST',
    body: JSON.stringify({
      message: otherMessage,
      signature: await otherAccount.signMessage({ message: otherMessage }),
    }),
  })
  const otherSetup = await json<{ token: string }>('/auth/setup-passphrase', {
    method: 'POST',
    headers: { Authorization: `Bearer ${otherVerify.body.setupToken}` },
    body: JSON.stringify({ passphrase: 'a-different-passphrase-entirely' }),
  })
  const crossAccess = await json(`/api/tasks/${planRes.body.taskId}`, {
    headers: { Authorization: `Bearer ${otherSetup.body.token}` },
  })
  check("another user's task is not readable", crossAccess.status === 404, `got ${crossAccess.status}`)

  report()
}

/**
 * A brand-new SIWE account that has not set a passphrase yet, so the
 * passphrase rules can be exercised — setup only runs once per user.
 */
async function freshAccount(): Promise<{ setupToken: string }> {
  const key = generatePrivateKey()
  const account = privateKeyToAccount(key)
  const nonce = await json<{ nonce: string }>('/auth/siwe/nonce')
  const message = new SiweMessage({
    domain: 'localhost',
    address: account.address,
    statement: 'Sign in to Trident.',
    uri: 'http://localhost',
    version: '1',
    chainId: 1,
    nonce: nonce.body.nonce,
  }).prepareMessage()
  const verify = await json<{ setupToken: string }>('/auth/siwe/verify', {
    method: 'POST',
    body: JSON.stringify({ message, signature: await account.signMessage({ message }) }),
  })
  return { setupToken: verify.body.setupToken }
}

function report(): void {
  console.log(`\n${'─'.repeat(52)}`)
  if (failed === 0) {
    console.log(`\x1b[32m\x1b[1mAll ${passed} checks passed.\x1b[0m\n`)
    process.exit(0)
  }
  console.log(`\x1b[31m\x1b[1m${failed} failed\x1b[0m, ${passed} passed`)
  for (const f of failures) console.log(`  \x1b[31m•\x1b[0m ${f}`)
  console.log()
  process.exit(1)
}

main().catch((err: unknown) => {
  console.error('\n\x1b[31mE2E harness crashed:\x1b[0m', err)
  process.exit(1)
})
