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
import {
  invalidEnumParams,
  missingRequiredParams,
  paramsFit,
  requestUrl,
  runTask,
  undeclaredParamsFrom,
} from '../src/agent/runner.ts'
import { __testAnswersTheSameQuestion } from '../src/circle/candidateService.ts'
import {
  CATALOG_SOURCE,
  CATALOG_VERSION,
  __testFreeApiRows,
  bodyShapeOf,
  catalogNeedsRebuild,
  needsRebuild,
  catalogSourceChanged,
  paramEnumsOf,
  paramLocationOf,
  requiredParamsOf,
} from '../src/circle/registryService.ts'
import { FREE_API_CATALOG } from '../src/circle/freeApiCatalog.ts'
import { fromAtomicUsdc, toAtomicUsdc } from '../src/circle/gatewayService.ts'
import { __testSyncApprovedSteps } from '../src/routes/agent.ts'
import type { PlanStep } from '../src/llm/planner.ts'
import type { ChainPolicy } from '../src/circle/chainPolicy.ts'

// Testnet-only, matching a user who has not opted into mainnet spending.
const TEST_POLICY: ChainPolicy = {
  allowed: ['arcTestnet'],
  testnet: 'arcTestnet',
  fundingChain: null,
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

/** A PlanStep carrying only what the URL builder reads. */
function urlStep(url: string, method: 'GET' | 'POST', params: Record<string, unknown>): PlanStep {
  return {
    stepIndex: 0,
    serviceName: 'Demo',
    endpointUrl: url,
    httpMethod: method,
    params,
    purpose: '',
    estimatedCostUsdc: 0,
  }
}

/*
 * A wallet reference, not a wallet.
 *
 * These tests never sign anything: every path they exercise stops short of a
 * Circle call, which is the point of them running without credentials. The id
 * is deliberately obvious so a test that unexpectedly reaches the network fails
 * loudly rather than against something that looks real.
 */
const TEST_WALLET = {
  walletId: 'test-wallet-never-signs',
  address: '0x0000000000000000000000000000000000000001' as `0x${string}`,
  env: 'testnet' as const,
}

async function main(): Promise<void> {
  console.log('\x1b[1mTrident runner tests\x1b[0m\n')
  const key = generatePrivateKey()

  /*
   * These were verified by hand when they were written and had no tests, which
   * is how a request for the University of Ibadan came back as Lagos twice
   * across two separate fixes. They are pure functions; there is no excuse.
   */
  // ------------------------------------------------- request construction
  section('Request construction')
  {
    const geo = 'https://geocoding-api.open-meteo.com/v1/search?name=lagos&count=3'

    const overridden = new URL(requestUrl(urlStep(geo, 'GET', { name: 'Ibadan' })))
    check(
      'a supplied parameter replaces the catalogued example, not appends to it',
      overridden.searchParams.getAll('name').join('|') === 'Ibadan',
      overridden.search,
    )
    check(
      'fixed parts of a catalogued URL survive',
      overridden.searchParams.get('count') === '3',
    )

    const arr = new URL(requestUrl(urlStep('https://x.dev/p', 'GET', { s: ['BTC', 'ETH'] })))
    check('an array becomes repeated keys', arr.searchParams.getAll('s').join(',') === 'BTC,ETH')

    const csv = new URL(requestUrl(urlStep('https://x.dev/p', 'GET', { s: 'BTC,ETH' })))
    check('a comma string becomes repeated keys', csv.searchParams.getAll('s').join(',') === 'BTC,ETH')

    const obj = new URL(requestUrl(urlStep('https://x.dev/p', 'GET', { f: { a: 1 } })))
    check('a nested object is serialised', obj.searchParams.get('f') === '{"a":1}')

    const path = requestUrl(
      urlStep('https://api.aisa.one/apis/v2/coingecko/coins/{id}', 'GET', { id: 'bitcoin' }),
    )
    check(
      'a path placeholder is filled from the parameters',
      path === 'https://api.aisa.one/apis/v2/coingecko/coins/bitcoin',
      path,
    )
    check(
      'and is not also appended to the query string',
      !path.includes('?'),
      path,
    )
    const mixed = new URL(
      requestUrl(
        urlStep('https://api.dev/coins/{id}/chart', 'GET', { id: 'btc', days: 7 }),
      ),
    )
    check(
      'other parameters still reach the query',
      mixed.pathname === '/coins/btc/chart' && mixed.searchParams.get('days') === '7',
      mixed.toString(),
    )
    let refused = false
    try {
      requestUrl(urlStep('https://api.dev/videos/{id}', 'GET', {}))
    } catch {
      refused = true
    }
    check('an unfilled placeholder is refused, not requested literally', refused)

    // A POST defaults to carrying nothing in the query...
    const postDefault = requestUrl(urlStep('https://x.dev/p', 'POST', { query: 'ml' }))
    check('a POST leaves the URL alone by default', postDefault === 'https://x.dev/p')

    // ...unless the service declared queryParams, as AIsa's scholar search does.
    const postQuery = new URL(requestUrl(urlStep('https://x.dev/p', 'POST', { query: 'ml' }), true))
    check(
      'a POST that declares queryParams gets a query string',
      postQuery.searchParams.get('query') === 'ml',
      postQuery.search,
    )
  }

  // -------------------------------------------------- required parameters
  section('Required parameters')
  {
    check(
      'an absent parameter is missing',
      missingRequiredParams(['name'], {}).join() === 'name',
    )
    check(
      'a blank string is missing — an empty search is not a search',
      missingRequiredParams(['q'], { q: '   ' }).join() === 'q',
    )
    check('an empty array is missing', missingRequiredParams(['ids'], { ids: [] }).join() === 'ids')
    check('a supplied value passes', missingRequiredParams(['name'], { name: 'Ibadan' }).length === 0)
    check(
      'zero and false are values, not omissions',
      missingRequiredParams(['a', 'b'], { a: 0, b: false }).length === 0,
    )
    check('every missing name is reported', missingRequiredParams(['a', 'b'], {}).join() === 'a,b')
  }

  // -------------------------------------------------- failover compatibility
  section('Failover compatibility')
  {
    // The real pair. /chat/completions serves 40 models; /api/v1/messages
    // serves 9, all Anthropic, and additionally requires max_tokens.
    const completions = {
      resource: 'https://nano.blockrun.ai/api/v1/chat/completions',
      requiredParams: ['model', 'messages'],
      paramEnums: { model: ['openai/gpt-4o-mini', 'anthropic/claude-haiku-4.5'] },
    }
    const messages = {
      resource: 'https://nano.blockrun.ai/api/v1/messages',
      requiredParams: ['model', 'messages', 'max_tokens'],
      paramEnums: { model: ['anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-5'] },
    }
    const openaiCall = { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }

    check('the original call is valid where it was planned', paramsFit(completions, openaiCall))
    check(
      'and is refused as a substitute that cannot serve it',
      !paramsFit(messages, openaiCall),
      'this is the 400 the user saw',
    )
    check(
      'the enum violation names the offending field',
      invalidEnumParams(messages.paramEnums, openaiCall).join() === 'model',
    )
    check(
      'a missing required field is caught on the substitute too',
      missingRequiredParams(messages.requiredParams, {
        model: 'anthropic/claude-haiku-4.5',
        messages: [],
      }).includes('max_tokens'),
    )
    check(
      'a genuinely compatible substitute is still allowed',
      paramsFit(messages, {
        model: 'anthropic/claude-haiku-4.5',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 16,
      }),
    )
    check(
      'a parameter with no published enum is never blocked',
      invalidEnumParams({}, { anything: 'goes' }).length === 0,
    )

    /*
     * 117 of the catalog's 955 resources are path templates. Failover picked
     * `/api/v1/videos/generations/{id}` — wrong shape and wrong purpose — and
     * requested it with the braces intact.
     */
    const templated = {
      resource: 'https://nano.blockrun.ai/api/v1/videos/generations/{id}',
      requiredParams: [],
      paramEnums: {},
    }
    check(
      'a template with no value for its placeholder is not a substitute',
      !paramsFit(templated, { model: 'x', messages: [] }),
    )
    check('the same template fits once the value exists', paramsFit(templated, { id: 'vid_1' }))
    check(
      'an absent optional value is not an enum violation',
      invalidEnumParams({ model: ['a'] }, {}).length === 0,
    )
  }

  // ------------------------------------------------------- schema reading
  section('Published schema')
  {
    const query = JSON.stringify({ queryParams: { required: ['query'], properties: {} } })
    const body = JSON.stringify({ body: { required: ['method'], properties: { method: { type: 'string' } } } })

    check('a queryParams schema routes to the query string', paramLocationOf(query) === 'query')
    check('a body schema routes to the body', paramLocationOf(body) === 'body')
    check('no published schema is null, not a guess', paramLocationOf(null) === null)
    check('required names are read from either location', requiredParamsOf(query).join() === 'query')
    check('a body shape is sketched for the planner', bodyShapeOf(body) === '{ method: string }')

    /*
     * The shape that cost two failed runs. "array" alone is not something a
     * caller can act on, and the planner sent a list of strings where the
     * endpoint wanted {role, content}.
     */
    const chatBody = JSON.stringify({
      body: {
        required: ['model', 'messages'],
        properties: {
          model: { enum: ['openai/gpt-4o-mini'] },
          messages: {
            type: 'array',
            items: {
              type: 'object',
              required: ['role', 'content'],
              properties: { role: { enum: ['user', 'assistant'] }, content: { type: 'string' } },
            },
          },
          max_tokens: { type: 'integer' },
        },
      },
    })
    const sketch = bodyShapeOf(chatBody) ?? ''
    check(
      'an array carries its item shape, not just the word "array"',
      sketch.includes('messages: [{ role: "user"|"assistant", content: string }]'),
      sketch,
    )
    check('a closed value set is shown, not just its type', sketch.includes('model: "openai/gpt-4o-mini"'))
    check('optional stays marked optional', sketch.includes('max_tokens?: integer'))

    // Long enums must not swallow the prompt.
    const many = JSON.stringify({
      body: { properties: { m: { enum: Array.from({ length: 40 }, (_, i) => `model-${i}`) } } },
    })
    const capped = bodyShapeOf(many) ?? ''
    check('a long value set is truncated', capped.includes('…') && capped.length < 200, String(capped.length))

    /*
     * Deeply nested but finite — a JSON schema cannot contain a cycle, so
     * runaway depth is the real risk, not self-reference.
     */
    let nested: Record<string, unknown> = { type: 'string' }
    for (let i = 0; i < 12; i += 1) {
      nested = { type: 'object', properties: { deeper: nested } }
    }
    const deepSketch = bodyShapeOf(JSON.stringify({ body: { properties: { root: nested } } })) ?? ''
    check(
      'deep nesting stops at a bounded depth',
      deepSketch.length > 0 && deepSketch.length < 200,
      `${deepSketch.length} chars`,
    )

    const enumSchema = JSON.stringify({
      body: { properties: { model: { enum: ['a/one', 'b/two'] }, prompt: { type: 'string' } } },
    })
    check(
      'published enums are read out of the body schema',
      paramEnumsOf(enumSchema)['model']?.join() === 'a/one,b/two',
    )
    check(
      'a property without an enum is not given an empty one',
      !('prompt' in paramEnumsOf(enumSchema)),
    )
  }

  // ------------------------------------------------------- the free catalog
  section('Free catalog URLs')
  {
    const withExamples = FREE_API_CATALOG.filter((api) => {
      if (!api.params?.length) return false
      const url = new URL(api.resource)
      return api.params.some((p) => url.searchParams.has(p))
    })
    check(
      'every declared parameter still has its example in the source catalog',
      withExamples.length > 0,
      'the fixture this test guards has gone',
    )

    const rows = __testFreeApiRows()
    const leaked = rows.filter((row) => {
      const api = FREE_API_CATALOG.find((a) => `free-${a.id}` === row.id)
      if (!api?.params?.length) return false
      const url = new URL(row.resource)
      return api.params.some((p) => url.searchParams.has(p))
    })
    check(
      'no example value reaches the registry as though it were an answer',
      leaked.length === 0,
      leaked.map((r) => r.resource).join(' '),
    )

    const geo = rows.find((r) => r.id === 'free-openmeteo-geocode')
    check('the geocoding entry no longer carries name=lagos', !geo?.resource.includes('lagos'), geo?.resource)
    check('its fixed count=3 is kept', geo?.resource.includes('count=3') === true, geo?.resource)
  }

  // ------------------------------------------------ undeclared parameters
  section('Undeclared parameters')
  {
    // The verbatim body from three failed steps in one run.
    const surf =
      'Request failed with status 400 — endpoint said: {"error":"Missing required parameters",' +
      '"message":"Surf endpoint /api/v1/surf/search/news requires: q. Payment was NOT charged.",' +
      '"missing_params":["q"],"all_required":["q"]}'

    check('the seller names the field it wants', undeclaredParamsFrom(surf).join() === 'q')
    check(
      'several names are all read',
      undeclaredParamsFrom(
        'Payment was NOT charged. {"missing_params":["q","limit"]}',
      ).join() === 'q,limit',
    )

    /*
     * The guard that matters. Without an explicit "not charged" the retry could
     * pay a second time for a call that already took the money, and being wrong
     * about billing is far worse than a failed step.
     */
    check(
      'no retry unless the seller says nothing was charged',
      undeclaredParamsFrom('{"error":"bad request","missing_params":["q"]}').length === 0,
    )
    check(
      'an unrelated 400 yields nothing',
      undeclaredParamsFrom('Request failed with status 400').length === 0,
    )
    check(
      'junk in the field list is discarded, not injected',
      undeclaredParamsFrom(
        'Payment was NOT charged. {"missing_params":["ok_1","../etc","a b","' + 'x'.repeat(60) + '"]}',
      ).join() === 'ok_1',
    )
  }

  // ------------------------------------------------- substitution relevance
  section('Substitution relevance')
  {
    /*
     * The exact pair that cost money. A bridge revert knocked out the
     * candlesticks endpoint, failover scored an events endpoint highest because
     * both matched "polymarket", and the user paid for an events list after
     * asking for OHLCV data.
     */
    const svc = (resource: string, tags: string[] = []) => ({
      resource,
      host: new URL(resource).host,
      tags,
    })

    const candlesticks = svc('https://nano.blockrun.ai/api/v1/pm/polymarket/candlesticks/{hash}')
    const events = svc('https://nano.blockrun.ai/api/v1/pm/polymarket/events')
    const otherCandles = svc('https://api.other.io/v1/polymarket/candlesticks')
    const kalshiMarkets = svc('https://nano.blockrun.ai/api/v1/pm/kalshi/markets')
    const polyMarkets = svc('https://nano.blockrun.ai/api/v1/pm/polymarket/markets')

    check(
      'events is not a substitute for candlesticks',
      !__testAnswersTheSameQuestion(candlesticks, events),
      'this is the substitution the user was charged for',
    )
    check(
      'another provider’s candlesticks is a substitute',
      __testAnswersTheSameQuestion(candlesticks, otherCandles),
    )
    check(
      'one markets endpoint substitutes another',
      __testAnswersTheSameQuestion(kalshiMarkets, polyMarkets),
    )
    /*
     * A deliberate false negative. `quotes` and `bars` are plausibly the same
     * thing under a shared `ohlcv` tag, and this refuses to substitute them.
     *
     * String comparison cannot tell a synonym from a different resource, and
     * the two failure modes are not symmetric: refusing a good substitute costs
     * a retry, accepting a bad one charges for an answer to a question nobody
     * asked. That happened. So when both paths name a capability, they must
     * agree.
     */
    check(
      'differing capabilities are refused even under a shared tag',
      !__testAnswersTheSameQuestion(
        svc('https://a.io/v1/quotes', ['ohlcv']),
        svc('https://b.io/v1/bars', ['ohlcv']),
      ),
    )
    /*
     * The substitution the last run still let through. Both paths name what
     * they return, and they differ — a shared provider tag must not overrule
     * that, or a people lookup stands in for a posts lookup.
     */
    check(
      'shared tags do not overrule differing capabilities',
      !__testAnswersTheSameQuestion(
        svc('https://nano.blockrun.ai/api/v1/surf/search/social/posts', ['surf', 'social']),
        svc('https://nano.blockrun.ai/api/v1/surf/search/social/people', ['surf', 'social']),
      ),
    )
    check(
      'but tags still vouch when a path names no capability',
      __testAnswersTheSameQuestion(
        svc('https://a.io/', ['ohlcv']),
        svc('https://b.io/v1/bars', ['ohlcv']),
      ),
    )

    check(
      'the provider name alone is never enough',
      !__testAnswersTheSameQuestion(
        svc('https://blockrun.ai/v1/blockrun/weather'),
        svc('https://blockrun.ai/v1/blockrun/flights'),
      ),
    )
  }

  // -------------------------------------------------------- catalog freshness
  section('Catalog rebuild gate')
  {
    /*
     * The gate that let four fixes ship against data nobody rewrote. Age is not
     * a proxy for "written by this build", and the source marker was unchanged
     * because the source really had not changed — only what we read from it.
     */
    const saved = (
      db.prepare('SELECT source_version FROM registry_sync WHERE id = 1').get() as
        | { source_version: string | null }
        | undefined
    )?.source_version

    /*
     * catalogNeedsRebuild() reads two things, and this block used to set only
     * one of them.
     *
     * The other is whether any x402 row carries an input_schema — the self-heal
     * for rows written before this build extracted schemas. The only x402 row
     * these tests insert has none, so on a clean database that row IS the whole
     * catalog and the heuristic fires: the assertion below then failed while
     * passing on any developer machine holding a real synced catalog of ~930
     * schema-bearing rows.
     *
     * CI is always clean, so it failed on every run for two days. Owning both
     * inputs here is what makes the result the same everywhere.
     *
     * Driven through the seeded fixture by name, never whichever x402 row comes
     * back first: on a developer machine that would be a real synced service,
     * and blanking its schema would corrupt the local catalog.
     */
    const FIXTURE = 'https://x402.org/protected'
    const savedSchema = (
      db.prepare('SELECT input_schema FROM services WHERE resource = ?').get(FIXTURE) as
        | { input_schema: string | null }
        | undefined
    )?.input_schema
    const withSchema = (schema: string | null) => {
      db.prepare('UPDATE services SET input_schema = ? WHERE resource = ?').run(schema, FIXTURE)
    }

    db.prepare(
      `INSERT INTO registry_sync (id, started_at, status, source_version) VALUES (1, 0, 'done', ?)
       ON CONFLICT(id) DO UPDATE SET source_version = excluded.source_version`,
    ).run(CATALOG_SOURCE)
    check(
      'a catalog written before the schema bump is rebuilt',
      catalogNeedsRebuild(),
      'this is exactly what production was serving',
    )
    check(
      'but its rows are not treated as another provider’s',
      !catalogSourceChanged(),
      'a schema bump must not trigger the delete',
    )

    db.prepare('UPDATE registry_sync SET source_version = ? WHERE id = 1').run(CATALOG_VERSION)
    withSchema('{"queryParams":{"required":[]}}')
    check('a current catalog is left alone', !catalogNeedsRebuild())

    /*
     * The rule itself, asserted directly rather than through the table.
     *
     * The second clause counts every x402 row, so it cannot be driven from a
     * test that owns one fixture: blanking that fixture proves the rule on an
     * empty database and disproves it on a developer's populated one. Both
     * results are about the environment, not the rule — which is exactly how
     * the assertion above came to fail in CI for two days.
     */
    const CURRENT = CATALOG_VERSION
    check('no sync has ever run, so there is nothing to rebuild',
      !needsRebuild(undefined, { x402: 0, withSchema: 0 }))
    check('a version from another build is rebuilt',
      needsRebuild('circle-agent-marketplace-v1#3', { x402: 900, withSchema: 900 }))
    check('a NULL version is rebuilt, since no build claimed it',
      needsRebuild(null, { x402: 900, withSchema: 900 }))
    check('the current version over schema-bearing rows is left alone',
      !needsRebuild(CURRENT, { x402: 900, withSchema: 900 }))
    // The case four inert fixes shipped through: the source really had not
    // changed, so the marker matched, but nothing had read a schema.
    check('the current version over schema-less rows is still rebuilt',
      needsRebuild(CURRENT, { x402: 900, withSchema: 0 }))
    check('one schema-bearing row is enough to trust the rest',
      !needsRebuild(CURRENT, { x402: 900, withSchema: 1 }))
    check('an empty catalog at the current version is not stale',
      !needsRebuild(CURRENT, { x402: 0, withSchema: 0 }))

    db.prepare('UPDATE registry_sync SET source_version = ? WHERE id = 1').run(
      'coinbase-bazaar-v1#2',
    )
    check('a genuine source change is still caught', catalogSourceChanged() && catalogNeedsRebuild())

    db.prepare('UPDATE registry_sync SET source_version = ? WHERE id = 1').run(saved ?? CATALOG_VERSION)
    // Both inputs restored, not just the version — the fixture is a real row on
    // a developer machine, and a test must hand the database back as it found it.
    withSchema(savedSchema ?? null)
  }

  // --------------------------------------------------- unified balance math
  section('Unified Gateway balance')
  {
    // Summed in atomic units because this figure gates spending. Adding the
    // decimal strings as floats loses money in the sixth place.
    check('a whole number parses', toAtomicUsdc('5') === 5_000_000n)
    check('six decimals parse exactly', toAtomicUsdc('0.123456') === 123_456n)
    check('a short fraction is padded, not truncated', toAtomicUsdc('0.1') === 100_000n)
    check('more than six decimals is cut, never rounded up', toAtomicUsdc('0.1234567') === 123_456n)
    check('round-trips', fromAtomicUsdc(toAtomicUsdc('12.345678')) === '12.345678')
    check('trailing zeros are dropped', fromAtomicUsdc(1_500_000n) === '1.5')
    check('zero reads as zero, not 0.', fromAtomicUsdc(0n) === '0')

    // The case this exists for: the same funds spread over three domains.
    const spread = ['0.05', '0.1', '0.000001'].reduce((sum, v) => sum + toAtomicUsdc(v), 0n)
    check('balances across domains sum exactly', fromAtomicUsdc(spread) === '0.150001', fromAtomicUsdc(spread))
    check(
      'the float route would have been wrong',
      0.05 + 0.1 + 0.000001 !== 0.150001,
      'if this ever fails, the bigint path is no longer load-bearing',
    )
  }

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
      goal: 'test goal',
      steps,
      completed: new Map(),
      walletFor: () => TEST_WALLET,
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
      goal: 'test goal',
      steps,
      completed: new Map(),
      walletFor: () => TEST_WALLET,
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
      goal: 'test goal',
      steps,
      completed: new Map(),
      walletFor: () => TEST_WALLET,
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
      goal: 'test goal',
      steps,
      completed: new Map(),
      walletFor: () => TEST_WALLET,
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
      goal: 'test goal',
      steps,
      completed: new Map(),
      walletFor: () => TEST_WALLET,
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

    /*
     * The single most important property, and the reason the runner stopped
     * taking a private key at all.
     *
     * This used to check for one specific key it had been handed. Now that the
     * runner is never given one, that check would pass whatever the code did,
     * so it asks the stronger question instead: does anything key-shaped appear
     * anywhere in the stream? A 32-byte hex run is what a private key looks
     * like, and nothing the agent legitimately emits has that shape. Transaction
     * hashes are also 32 bytes, so they are excluded by their 0x prefix being
     * reported as `txRef` rather than bare.
     */
    const raw = fake.raw()
    const keyShaped = raw.match(/(?<![0-9a-fA-Fx])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g) ?? []
    check(`nothing key-shaped in the stream (found ${keyShaped.length})`, keyShaped.length === 0)

    // Belt and braces: the key this test generated is not on the wire either,
    // which would catch a leak through a path the shape check somehow misses.
    check('the generated key never appears in the stream', !raw.includes(key.slice(2)))

    const persisted = db
      .prepare('SELECT response_summary FROM task_steps WHERE task_id = ?')
      .all(taskId) as { response_summary: string | null }[]
    check(
      'nothing key-shaped persisted to the database',
      persisted.every((r) => !/(?<![0-9a-fA-Fx])[0-9a-fA-F]{64}(?![0-9a-fA-F])/.test(r.response_summary ?? '')),
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
      goal: 'test goal',
      steps,
      completed: new Map(),
      walletFor: () => TEST_WALLET,
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

  // ------------------------------------------------------- retry / resume
  section('Retry resumes instead of re-paying')
  {
    const key = generatePrivateKey()
    const userId = seedUser()
    const steps: PlanStep[] = [0, 1, 2].map((i) => ({
      stepIndex: i,
      serviceName: `Service ${i}`,
      endpointUrl: `https://api.coingecko.com/api/v3/simple/price?step=${i}`,
      httpMethod: 'GET',
      params: { i: String(i) },
      purpose: `step ${i}`,
      estimatedCostUsdc: 0.01,
    }))
    const taskId = seedTask(userId, steps)

    // First attempt: steps 0 and 1 settled, step 2 failed.
    for (const i of [0, 1]) {
      db.prepare(
        `UPDATE task_steps SET status='done', actual_cost_usdc=0.01, tx_ref=?, response_summary=?
         WHERE task_id=? AND step_index=?`,
      ).run(`0xtx${i}`, JSON.stringify({ value: i }), taskId, i)
    }
    db.prepare(`UPDATE task_steps SET status='failed' WHERE task_id=? AND step_index=2`).run(taskId)

    const completed = __testSyncApprovedSteps(taskId, structuredClone(steps))
    check('settled steps are reused', [...completed.keys()].join(',') === '0,1')
    check(
      'their cost is carried forward',
      [...completed.values()].reduce((sum, s) => sum + s.cost, 0) === 0.02,
    )
    check(
      'the failed step is reset to pending',
      (
        db
          .prepare('SELECT status FROM task_steps WHERE task_id=? AND step_index=2')
          .get(taskId) as { status: string }
      ).status === 'pending',
    )

    const fake = fakeResponse()
    await runTask({
      taskId,
      userId,
      goal: 'test goal',
      steps,
      completed,
      walletFor: () => TEST_WALLET,
      budgetUsdc: null,
      spendingCapUsdc: 100,
      policy: TEST_POLICY,
      res: fake.res,
    })

    const frames = fake.frames()
    const replayed = frames.filter((f) => f.event === 'step_replayed')
    const started = frames.filter((f) => f.event === 'step_start')
    check('both settled steps are replayed', replayed.length === 2, `got ${replayed.length}`)
    check(
      'only the unsettled step is attempted',
      started.length === 1 && started[0]?.data['stepIndex'] === 2,
      started.map((f) => f.data['stepIndex']).join(','),
    )
    check(
      'replayed results are carried into the stream',
      JSON.stringify(replayed[0]?.data['result']) === JSON.stringify({ value: 0 }),
    )
    const start = frames.find((f) => f.event === 'start')
    check('prior spend seeds the running total', start?.data['alreadySpent'] === 0.02)

    // The whole point: the wallet is unfunded, so a re-payment would fail —
    // and the earlier steps must not even be attempted.
    check(
      'no payment is attempted for settled steps',
      !frames.some(
        (f) =>
          f.event === 'step_failed' &&
          (f.data['stepIndex'] === 0 || f.data['stepIndex'] === 1),
      ),
    )
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
