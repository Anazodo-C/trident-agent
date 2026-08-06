/**
 * Deterministic tests for the agent runner.
 *
 * Calls `runTask()` directly with a fake Express response, so the budget gate,
 * spending-cap gate, abort flag, SSE framing, and secret-scrubbing are all
 * verified without an LLM, network payment, or funded wallet.
 *
 * Run with:  npm run test:runner -w @trident/node-backend
 */
import { createHash, randomUUID } from 'node:crypto'
import { generatePrivateKey } from 'viem/accounts'
import type { Response } from 'express'
import db from '../src/db.ts'
import { runTask } from '../src/agent/runner.ts'
import type { PlanStep } from '../src/llm/planner.ts'
import type { ChainPolicy } from '../src/circle/chainPolicy.ts'

// Testnet-only, matching a user who has not opted into mainnet spending.
const TEST_POLICY: ChainPolicy = {
  allowed: ['arcTestnet'],
  testnet: 'arcTestnet',
  mainnet: null,
  mainnetEnabled: false,
}

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

interface FakeRes {
  res: Response
  frames: () => { event: string; data: Record<string, unknown> }[]
  raw: () => string
  ended: () => boolean
}

/** Minimal Express-Response stand-in that records everything written. */
function fakeResponse(): FakeRes {
  let buffer = ''
  let ended = false
  const listeners: Record<string, (() => void)[]> = {}

  const res = {
    writableEnded: false,
    setHeader: () => res,
    flushHeaders: () => undefined,
    write: (chunk: string) => {
      buffer += chunk
      return true
    },
    end: () => {
      ended = true
      ;(res as { writableEnded: boolean }).writableEnded = true
      return res
    },
    on: (event: string, handler: () => void) => {
      ;(listeners[event] ??= []).push(handler)
      return res
    },
  } as unknown as Response

  return {
    res,
    raw: () => buffer,
    ended: () => ended,
    frames: () =>
      buffer
        .split('\n\n')
        .map((chunk) => {
          let event = ''
          const dataLines: string[] = []
          for (const line of chunk.split('\n')) {
            if (line.startsWith(':')) continue
            if (line.startsWith('event:')) event = line.slice(6).trim()
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
          }
          if (!event || dataLines.length === 0) return null
          return { event, data: JSON.parse(dataLines.join('\n')) as Record<string, unknown> }
        })
        .filter((f): f is { event: string; data: Record<string, unknown> } => f !== null),
  }
}

/** The runner resolves endpoints against the registry, so seed the row it needs. */
function seedService(resource: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO services (id, resource, service_name, host, network, chain_key,
       is_testnet, networks_json, price_usdc, http_method, curated, calls_30d, payers_30d, synced_at)
     VALUES (?, ?, 'x402 Reference', 'x402.org', 'eip155:5042002', 'arcTestnet', 1, ?, 0.01, 'GET', 1, 5, 1, 0)`,
  ).run(
    'seed-' + createHash('sha1').update(resource).digest('hex').slice(0, 12),
    resource,
    JSON.stringify([
      { network: 'eip155:5042002', chainKey: 'arcTestnet', isTestnet: true, priceUsdc: 0.01, asset: null, scheme: 'exact' },
    ]),
  )
}
seedService('https://x402.org/protected')

/** A free public API, metered by an Arc Testnet verification payment. */
const FREE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd'
db.prepare(
  `INSERT OR REPLACE INTO services (id, resource, source, service_name, host, network, chain_key,
     is_testnet, networks_json, price_usdc, http_method, curated, calls_30d, payers_30d, synced_at)
   VALUES ('free-test', ?, 'free', 'CoinGecko', 'api.coingecko.com', 'eip155:5042002', 'arcTestnet',
           1, ?, 0.000001, 'GET', 1, 1000, 0, 0)`,
).run(
  FREE_URL,
  JSON.stringify([
    { network: 'eip155:5042002', chainKey: 'arcTestnet', isTestnet: true, priceUsdc: 0.000001, asset: null, scheme: 'verification' },
  ]),
)

function seedUser(): string {
  const userId = randomUUID()
  db.prepare('INSERT INTO users (id, email, eoa_address) VALUES (?, ?, ?)').run(
    userId,
    `runner-${userId}@example.test`,
    '0x0000000000000000000000000000000000000001',
  )
  return userId
}

function seedTask(userId: string, steps: PlanStep[]): string {
  const taskId = randomUUID()
  db.prepare('INSERT INTO tasks (id, user_id, goal, status) VALUES (?, ?, ?, ?)').run(
    taskId,
    userId,
    'runner test goal',
    'pending',
  )
  const insert = db.prepare(
    `INSERT INTO task_steps
       (id, task_id, step_index, service_name, endpoint_url, http_method, params, estimated_cost_usdc, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
  )
  for (const s of steps) {
    insert.run(
      randomUUID(),
      taskId,
      s.stepIndex,
      s.serviceName,
      s.endpointUrl,
      s.httpMethod,
      JSON.stringify(s.params),
      s.estimatedCostUsdc,
    )
  }
  return taskId
}

function makeSteps(count: number, cost: number): PlanStep[] {
  return Array.from({ length: count }, (_, i) => ({
    stepIndex: i,
    serviceName: 'x402 Reference Endpoint',
    endpointUrl: 'https://x402.org/protected',
    httpMethod: 'GET' as const,
    params: {},
    purpose: `test step ${i}`,
    estimatedCostUsdc: cost,
  }))
}

function taskStatus(taskId: string): string {
  return (db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string })
    .status
}

async function main(): Promise<void> {
  console.log('\x1b[1mTrident runner tests\x1b[0m\n')
  const key = generatePrivateKey()

  // ------------------------------------------------------------ budget gate
  section('Budget gate')
  {
    const userId = seedUser()
    const steps = makeSteps(2, 0.05)
    const taskId = seedTask(userId, steps)
    const fake = fakeResponse()

    await runTask({
      taskId,
      userId,
      steps,
      agentPrivateKey: key,
      budgetUsdc: 0.001,
      spendingCapUsdc: 100,
      policy: TEST_POLICY,
      res: fake.res,
    })

    const events = fake.frames().map((f) => f.event)
    check('emits start first', events[0] === 'start', events.join(','))
    check('trips budget_exceeded', events.includes('budget_exceeded'), events.join(','))
    check('never attempts a payment', !events.includes('step_start'), events.join(','))
    check('closes the stream', fake.ended())
    check('task recorded as stopped', taskStatus(taskId) === 'stopped', taskStatus(taskId))
  }

  // ------------------------------------------------------- spending cap gate
  section('Spending cap gate')
  {
    const userId = seedUser()
    const steps = makeSteps(2, 0.05)
    const taskId = seedTask(userId, steps)
    const fake = fakeResponse()

    await runTask({
      taskId,
      userId,
      steps,
      agentPrivateKey: key,
      // No per-run budget: the account-level cap must still stop it.
      budgetUsdc: null,
      spendingCapUsdc: 0.001,
      policy: TEST_POLICY,
      res: fake.res,
    })

    const events = fake.frames().map((f) => f.event)
    check('trips cap_exceeded', events.includes('cap_exceeded'), events.join(','))
    check('cap applies without a run budget', !events.includes('step_start'), events.join(','))
    const capFrame = fake.frames().find((f) => f.event === 'cap_exceeded')
    check('cap event reports the cap', capFrame?.data['spendingCapUsdc'] === 0.001)
  }

  // --------------------------------------------------------------- abort flag
  section('Abort flag')
  {
    const userId = seedUser()
    const steps = makeSteps(2, 0.01)
    const taskId = seedTask(userId, steps)
    const fake = fakeResponse()

    // runTask clears the flag on entry, so simulate a stop arriving mid-run by
    // setting it once the first step_start has been written.
    const original = fake.res.write.bind(fake.res)
    ;(fake.res as { write: (c: string) => boolean }).write = (chunk: string) => {
      const result = original(chunk)
      if (chunk.includes('event: step_start')) {
        db.prepare('UPDATE agent_sessions SET abort_flag = 1 WHERE user_id = ?').run(userId)
      }
      return result
    }

    await runTask({
      taskId,
      userId,
      steps,
      agentPrivateKey: key,
      budgetUsdc: null,
      spendingCapUsdc: 100,
      policy: TEST_POLICY,
      res: fake.res,
    })

    const events = fake.frames().map((f) => f.event)
    check('first step was attempted', events.includes('step_start'), events.join(','))
    check('stops before the second step', events.includes('stopped'), events.join(','))
    check('task recorded as stopped', taskStatus(taskId) === 'stopped', taskStatus(taskId))
  }

  // ------------------------------------------------- endpoint allowlist guard
  section('Endpoint allowlist')
  {
    const userId = seedUser()
    const steps: PlanStep[] = [
      {
        stepIndex: 0,
        serviceName: 'Evil Service',
        endpointUrl: 'https://attacker.example.com/drain',
        httpMethod: 'GET',
        params: {},
        purpose: 'should never be called',
        estimatedCostUsdc: 0.01,
      },
    ]
    const taskId = seedTask(userId, steps)
    const fake = fakeResponse()

    await runTask({
      taskId,
      userId,
      steps,
      agentPrivateKey: key,
      budgetUsdc: null,
      spendingCapUsdc: 100,
      policy: TEST_POLICY,
      res: fake.res,
    })

    const frames = fake.frames()
    const failure = frames.find((f) => f.event === 'step_failed')
    check('uncatalogued endpoint is refused', failure !== undefined)
    check(
      'refusal names the registry rule',
      String(failure?.data['error'] ?? '').includes('not in the service registry'),
      String(failure?.data['error']),
    )
  }

  // ----------------------------------------------------- unfunded real payment
  section('Unfunded payment against a live x402 endpoint')
  {
    const userId = seedUser()
    const steps = makeSteps(1, 0.01)
    const taskId = seedTask(userId, steps)
    const fake = fakeResponse()

    await runTask({
      taskId,
      userId,
      steps,
      agentPrivateKey: key,
      budgetUsdc: null,
      spendingCapUsdc: 100,
      policy: TEST_POLICY,
      res: fake.res,
    })

    const events = fake.frames().map((f) => f.event)
    check('attempts the payment', events.includes('step_start'), events.join(','))
    check(
      'reaches a terminal event without hanging',
      events.some((e) => ['complete', 'fatal', 'stopped'].includes(e)),
      events.join(','),
    )
    check('stream is closed', fake.ended())

    // The single most important property: the key must never reach the wire.
    const raw = fake.raw()
    check('private key never appears in the stream', !raw.includes(key.slice(2)))

    const persisted = db
      .prepare('SELECT response_summary FROM task_steps WHERE task_id = ?')
      .all(taskId) as { response_summary: string | null }[]
    check(
      'private key never persisted to the database',
      persisted.every((r) => !(r.response_summary ?? '').includes(key.slice(2))),
    )
  }

  // ------------------------------------------- free APIs are metered, not free
  section('Free API metering (Arc Testnet verification)')
  {
    const userId = seedUser()
    const steps: PlanStep[] = [
      {
        stepIndex: 0,
        serviceName: 'CoinGecko',
        endpointUrl: FREE_URL,
        httpMethod: 'GET',
        params: {},
        purpose: 'fetch a price',
        estimatedCostUsdc: 0.000001,
      },
    ]
    const taskId = seedTask(userId, steps)
    const fake = fakeResponse()

    await runTask({
      taskId,
      userId,
      steps,
      agentPrivateKey: key,
      budgetUsdc: null,
      spendingCapUsdc: 100,
      policy: TEST_POLICY,
      res: fake.res,
    })

    const frames = fake.frames()
    const events = frames.map((f) => f.event)
    check('free step is attempted', events.includes('step_start'), events.join(','))

    // The wallet is unfunded, so the verification transfer must refuse it —
    // that refusal IS the gate, and it must happen before the API is called.
    const failed = frames.find((f) => f.event === 'step_failed')
    check('unfunded wallet cannot call a free API', failed !== undefined, events.join(','))
    check(
      'refusal names the verification payment',
      String(failed?.data['error'] ?? '').includes('verification'),
      String(failed?.data['error']).slice(0, 90),
    )
    check('run still reaches a terminal event', events.includes('complete') || events.includes('fatal'))
    check('no spend recorded for a refused call', fake.raw().includes('"totalSpent":0'))
  }

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
  console.error('\n\x1b[31mRunner harness crashed:\x1b[0m', err)
  process.exit(1)
})
