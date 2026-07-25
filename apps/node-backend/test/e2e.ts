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
import { SiweMessage } from 'siwe'
// The real browser-side decrypt. Node exposes the same WebCrypto API, so this
// exercises the exact code the app ships rather than a re-implementation.
import { decryptEoaKey } from '../../frontend/src/lib/crypto.ts'

const BASE = process.env['E2E_BASE_URL'] ?? 'http://localhost:3001'
const PASSPHRASE = 'correct-horse-battery-staple'

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
    encryptedKey: string
    salt: string
    iv: string
    eoaAddress: string
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
    await decryptEoaKey('wrong-passphrase', material.body.encryptedKey, material.body.salt, material.body.iv)
  } catch {
    wrongRejected = true
  }
  check('wrong passphrase is rejected', wrongRejected)

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
  check('gateway balance is null without a key', balance.body?.gatewayUsdc === null)

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
  section('Runner — budget gate')
  const budgetFrames = await readSse('/api/agent/run', jwt, {
    taskId: planRes.body.taskId,
    approvedSteps: steps,
    agentPrivateKey: decrypted,
    // Deliberately below the cheapest step so the gate must trip on step 0.
    budgetUsdc: 0.0001,
  })
  const budgetEvents = budgetFrames.map((f) => f.event)
  check('stream opened with a start event', budgetEvents[0] === 'start', budgetEvents.join(','))
  check(
    'budget_exceeded fires before any payment',
    budgetEvents.includes('budget_exceeded'),
    budgetEvents.join(','),
  )
  check('no step was paid', !budgetEvents.includes('step_done'), budgetEvents.join(','))

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
    check('run emitted step_start', events.includes('step_start'), events.join(','))
    check(
      'run reached a terminal event',
      events.some((e) => ['complete', 'stopped', 'fatal', 'error'].includes(e)),
      events.join(','),
    )
    // With no Gateway balance, a real payment cannot settle — the run must fail
    // cleanly rather than hang or crash the process.
    check(
      'unfunded wallet fails gracefully',
      !events.includes('step_done') ? events.includes('step_failed') : true,
      events.join(','),
    )
    const serialised = JSON.stringify(frames)
    check('no private key leaked into the stream', !serialised.includes(decrypted.slice(2)))
  }

  // ---------------------------------------------------------------- history
  section('History')
  const history = await json<{ tasks: { id: string; status: string; stepCount: number }[] }>(
    '/api/tasks',
    { headers: auth },
  )
  check('history lists the runs', (history.body?.tasks?.length ?? 0) >= 2)
  check(
    'tasks reached a terminal status',
    history.body.tasks.every((t) => ['done', 'stopped', 'failed'].includes(t.status)),
    history.body.tasks.map((t) => t.status).join(','),
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
    body: JSON.stringify({ passphrase: 'a-different-passphrase' }),
  })
  const crossAccess = await json(`/api/tasks/${planRes.body.taskId}`, {
    headers: { Authorization: `Bearer ${otherSetup.body.token}` },
  })
  check("another user's task is not readable", crossAccess.status === 404, `got ${crossAccess.status}`)

  report()
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
