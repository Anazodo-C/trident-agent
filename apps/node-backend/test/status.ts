/**
 * Deterministic tests for the reachability prober.
 *
 * The classifier decides what the status page shows AND, through
 * `unreachable_since`, what the agent is allowed to propose — so a wrong rule
 * here quietly shrinks the catalog. Everything below runs offline: the
 * classifier is pure, and the hysteresis test drives the database directly.
 *
 * Run with:  npm run test:status -w @trident/node-backend
 */
import db from '../src/db.ts'
import {
  classifyProbe,
  hostOf,
  isReachableState,
  statusSnapshot,
  __testPersist,
  type ProbeState,
} from '../src/circle/statusProber.ts'
import { fillTemplate, isTemplated } from '../src/circle/pathParams.ts'

let failures = 0

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failures += 1
    console.error(`  FAIL  ${label}\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  } else {
    console.log(`  ok    ${label}`)
  }
}

// ─────────────────────────────────────────────── the classification table

console.log('\nclassifier')

const plain = (status: number | null, terms = false): ProbeState =>
  classifyProbe(status, terms, false)

check('402 with terms is live', plain(402, true), 'live')
check('402 without terms is only answering', plain(402, false), 'answering')
check('200 is live (free tier)', plain(200), 'live')
check('204 is live', plain(204), 'live')
// BlockRun validates the request body before its payment gate. It answered, so
// it is reachable — this is the single largest bucket after 'live' in practice.
check('400 is answering, not down', plain(400), 'answering')
check('401 is answering', plain(401), 'answering')
check('403 is answering', plain(403), 'answering')
check('422 is answering', plain(422), 'answering')
// Being rate-limited is proof of life. Counting it as an outage would turn our
// own request rate into a red dot on someone else's service.
check('429 is throttled', plain(429), 'throttled')
check('throttled counts as reachable', isReachableState('throttled'), true)
check('404 on a plain path is gone', plain(404), 'gone')
check('410 on a plain path is gone', plain(410), 'gone')
check('500 is erroring', plain(500), 'erroring')
check('503 is erroring', plain(503), 'erroring')
check('no response at all is down', plain(null), 'down')

check('gone is not reachable', isReachableState('gone'), false)
check('erroring is not reachable', isReachableState('erroring'), false)
check('down is not reachable', isReachableState('down'), false)

// ───────────────────────────────────────────────── templated paths

console.log('\ntemplated paths')

/*
 * The defect this guards against, found by a dry run over the real catalog:
 * probing `/usstock/price/{symbol}` with the braces intact returns 404, while
 * the same path with a real symbol returns 402. Twelve working endpoints were
 * reported gone. With the planner reading these results, two sweeps would have
 * removed them from the agent's shortlist for a week.
 */
check(
  'placeholders are substituted, not sent raw',
  fillTemplate('https://nano.blockrun.ai/api/v1/usstock/price/{symbol}'),
  'https://nano.blockrun.ai/api/v1/usstock/price/probe',
)
check(
  'every placeholder in a path is replaced',
  fillTemplate('https://x/{a}/y/{b}/z/{c}'),
  'https://x/probe/y/probe/z/probe',
)
check('a plain path is untouched', fillTemplate('https://x/y/z'), 'https://x/y/z')
check('templated paths are detected', isTemplated('https://x/{id}'), true)
check('plain paths are not', isTemplated('https://x/id'), false)
// Detection must not be stateful across calls — a lastIndex left set by a
// previous test would make every other call return false.
check('detection repeats correctly', isTemplated('https://x/{id}'), true)

// A 404 for an id we invented is the endpoint working correctly, not a dead
// path. `/agentphone/v1/calls/probe` 404s for exactly that reason.
check('404 on a templated path is inconclusive', classifyProbe(404, false, true), 'answering')
check('410 on a templated path is inconclusive', classifyProbe(410, false, true), 'answering')
check('a templated path can still be live', classifyProbe(402, true, true), 'live')

check('host is parsed from a resource', hostOf('https://api.x.dev/a/b?c=1'), 'api.x.dev')
check('an unparseable resource falls back to itself', hostOf('not a url'), 'not a url')

// ───────────────────────────────────────────── hysteresis on the shared column

console.log('\nhysteresis')

/*
 * `unreachable_since` is the column the planner filters on, so the rule that
 * matters is: slow to condemn, instant to forgive. One failure must not
 * blacklist a working seller — the exact failure mode the column's own comment
 * in db.ts warns about, after a bridge bug of ours marked two live BlockRun
 * endpoints as failed.
 *
 * persist() is not exported, so this drives the same statements it does.
 */
const RESOURCE = 'https://test.invalid/probe-hysteresis'
db.prepare(`DELETE FROM services WHERE resource = ?`).run(RESOURCE)
db.prepare(
  `INSERT INTO services (id, resource, host, http_method, source, price_usdc)
   VALUES (?, ?, 'test.invalid', 'GET', 'x402', 0)`,
).run('test-hysteresis', RESOURCE)

const unreachableSince = (): number | null =>
  (db.prepare(`SELECT unreachable_since FROM services WHERE resource = ?`).get(RESOURCE) as {
    unreachable_since: number | null
  }).unreachable_since
const streak = (): number =>
  (db.prepare(`SELECT probe_fail_streak FROM services WHERE resource = ?`).get(RESOURCE) as {
    probe_fail_streak: number
  }).probe_fail_streak

__testPersist(RESOURCE, { state: 'down', status: null, latencyMs: 10 })
check('one failure records a streak', streak(), 1)
check('one failure does NOT condemn', unreachableSince(), null)

__testPersist(RESOURCE, { state: 'down', status: null, latencyMs: 10 })
check('two failures record a streak', streak(), 2)
check('two consecutive failures condemn', unreachableSince() !== null, true)

__testPersist(RESOURCE, { state: 'live', status: 402, latencyMs: 120 })
check('a success clears the streak', streak(), 0)
check('a success clears the condemnation immediately', unreachableSince(), null)

// A 4xx is not a hard failure, so it must never start a streak at all.
__testPersist(RESOURCE, { state: 'answering', status: 400, latencyMs: 90 })
__testPersist(RESOURCE, { state: 'answering', status: 400, latencyMs: 90 })
check('answering never condemns, however often', unreachableSince(), null)
check('answering leaves the streak at zero', streak(), 0)

// Throttling is our fault, not theirs.
__testPersist(RESOURCE, { state: 'throttled', status: 429, latencyMs: 90 })
__testPersist(RESOURCE, { state: 'throttled', status: 429, latencyMs: 90 })
check('throttling never condemns', unreachableSince(), null)

// A hard failure interrupted by a success starts over rather than accumulating.
__testPersist(RESOURCE, { state: 'erroring', status: 500, latencyMs: 90 })
__testPersist(RESOURCE, { state: 'live', status: 402, latencyMs: 90 })
__testPersist(RESOURCE, { state: 'erroring', status: 500, latencyMs: 90 })
check('a success resets the count, it does not accumulate', unreachableSince(), null)

// ───────────────────────────────────────────────────────── snapshot shape

console.log('\nsnapshot')

const snap = statusSnapshot()
check('reachable and unreachable partition the total', snap.total, snap.endpoints.length)
check(
  'reachable count matches the endpoint flags',
  snap.reachable,
  snap.endpoints.filter((e) => e.reachable).length,
)
check(
  'byState sums to the total',
  Object.values(snap.byState).reduce((a, b) => a + b, 0),
  snap.total,
)
const probed = snap.endpoints.find((e) => e.path === '/probe-hysteresis')
check('a probed endpoint carries its path', probed?.path, '/probe-hysteresis')
check('a probed endpoint carries its host', probed?.host, 'test.invalid')
check(
  'confirmedSelling only counts live',
  snap.confirmedSelling,
  snap.endpoints.filter((e) => e.state === 'live').length,
)

db.prepare(`DELETE FROM services WHERE resource = ?`).run(RESOURCE)

console.log(failures === 0 ? '\nall status tests passed\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
