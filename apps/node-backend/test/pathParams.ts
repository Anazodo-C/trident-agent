/**
 * Path placeholders, and the visibility rules that depend on them.
 *
 * These two things are one test file because they were one bug. The prober sent
 * `{symbol}` literally, read the resulting 404 as the endpoint being dead, and
 * wrote the column the planner filters on — so a defect in how a URL was built
 * was one sweep away from removing twelve working endpoints from the catalog.
 *
 * What is asserted here is the corrected design: a placeholder is a required
 * parameter that every layer can see, and nothing is withheld from the agent
 * except an endpoint the prober has actually confirmed dead.
 *
 * Run with:  npm run test:pathparams -w @trident/node-backend
 */
import db from '../src/db.ts'
import {
  applyPathParams,
  fillTemplate,
  isTemplated,
  missingPathParams,
  pathPlaceholders,
} from '../src/circle/pathParams.ts'
import { requiredParamsFor } from '../src/circle/registryService.ts'
import { paramsFit } from '../src/agent/runner.ts'
import { reachableClause } from '../src/circle/candidateService.ts'

let failures = 0

function check(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures += 1
    console.error(
      `  FAIL  ${label}\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    )
  } else {
    console.log(`  ok    ${label}`)
  }
}

const STOCK = 'https://nano.blockrun.ai/api/v1/usstock/price/{symbol}'

// ───────────────────────────────────────────────────── parsing and filling

console.log('\nplaceholders')

check('a placeholder is found', pathPlaceholders(STOCK), ['symbol'])
check('several are found in order', pathPlaceholders('https://x/{a}/y/{b}'), ['a', 'b'])
check('a plain path has none', pathPlaceholders('https://x/y'), [])
check('detection is not stateful', [isTemplated(STOCK), isTemplated(STOCK)], [true, true])

check(
  'a value from the goal fills the path',
  applyPathParams(STOCK, { symbol: 'AAPL' }).url,
  'https://nano.blockrun.ai/api/v1/usstock/price/AAPL',
)
check(
  'a filled placeholder is reported as consumed, so it is not repeated in the query',
  [...applyPathParams(STOCK, { symbol: 'AAPL' }).consumed],
  ['symbol'],
)
check(
  'every placeholder is filled, not just the first',
  applyPathParams('https://x/{a}/y/{b}', { a: '1', b: '2' }).url,
  'https://x/1/y/2',
)
// The value comes from a person and is being spliced into a URL.
check(
  'values are percent-encoded',
  applyPathParams('https://x/{q}', { q: 'a b/c?d' }).url,
  'https://x/a%20b%2Fc%3Fd',
)
check(
  'an absent value leaves the braces rather than sending an empty segment',
  applyPathParams(STOCK, {}).url,
  STOCK,
)
// Filling and asking must agree about what counts as a value, or a request gets
// built from whitespace and money is spent on a call that cannot mean anything.
check(
  'whitespace is not filled in',
  applyPathParams(STOCK, { symbol: '  ' }).url,
  STOCK,
)
check(
  'and filling agrees with asking about it',
  [
    applyPathParams(STOCK, { symbol: '  ' }).consumed.size,
    missingPathParams(STOCK, { symbol: '  ' }).length,
  ],
  [0, 1],
)

check('a missing value is reported', missingPathParams(STOCK, {}), ['symbol'])
check('an empty value is reported', missingPathParams(STOCK, { symbol: '' }), ['symbol'])
check('whitespace is not a value', missingPathParams(STOCK, { symbol: '   ' }), ['symbol'])
check('a supplied value is not reported', missingPathParams(STOCK, { symbol: 'AAPL' }), [])

// Probing only. A real call never uses this — it fills from the user or asks.
check(
  'the probe token replaces braces so liveness can be checked',
  fillTemplate(STOCK),
  'https://nano.blockrun.ai/api/v1/usstock/price/probe',
)

// ─────────────────────────────────────── placeholders as required parameters

console.log('\nvisible to the planner')

/*
 * The heart of the fix. `requiredParams` was built from the input schema alone,
 * so a template with no schema was advertised to the model as needing nothing —
 * the model supplied nothing, and the call went out with the braces intact.
 */
check(
  'a placeholder is a required parameter even with no schema',
  requiredParamsFor(STOCK, null),
  ['symbol'],
)
check(
  'schema fields and placeholders are combined',
  requiredParamsFor('https://x/{id}', JSON.stringify({ queryParams: { required: ['limit'] } })),
  ['limit', 'id'],
)
check(
  'a name declared in both places is asked for once',
  requiredParamsFor('https://x/{id}', JSON.stringify({ queryParams: { required: ['id'] } })),
  ['id'],
)
check('a plain resource is unaffected', requiredParamsFor('https://x/y', null), [])

console.log('\nusable once the value is known')

const svc = (resource: string) => ({ resource, requiredParams: ['symbol'], paramEnums: {} })
check('a template with no value does not fit', paramsFit(svc(STOCK), {}), false)
check('the same template fits once filled', paramsFit(svc(STOCK), { symbol: 'AAPL' }), true)

// ─────────────────────────────────────────────── what may be hidden, and why

console.log('\nvisibility')

/*
 * Only the prober's confirmed verdict withholds an endpoint now. The previous
 * rule — seven days since `unreachable_since` was first set — is what turned a
 * probe defect into a week-long blacklist.
 */
const clause = reachableClause()
const CASES: [string, Record<string, unknown>, boolean][] = [
  ['never probed', { probe_state: null, probe_fail_streak: 0 }, true],
  ['live', { probe_state: 'live', probe_fail_streak: 0 }, true],
  ['answering a 4xx', { probe_state: 'answering', probe_fail_streak: 0 }, true],
  ['rate-limited by us', { probe_state: 'throttled', probe_fail_streak: 0 }, true],
  ['dead once — a blip', { probe_state: 'gone', probe_fail_streak: 1 }, true],
  ['dead twice running', { probe_state: 'gone', probe_fail_streak: 2 }, false],
  ['erroring twice running', { probe_state: 'erroring', probe_fail_streak: 3 }, false],
  ['silent twice running', { probe_state: 'down', probe_fail_streak: 2 }, false],
]

for (const [label, row, expected] of CASES) {
  db.prepare(`DELETE FROM services WHERE resource = 'https://vis.invalid/x'`).run()
  db.prepare(
    `INSERT INTO services (id, resource, host, http_method, source, price_usdc,
                           probe_state, probe_fail_streak)
     VALUES ('vis-test', 'https://vis.invalid/x', 'vis.invalid', 'GET', 'x402', 0, ?, ?)`,
  ).run(row['probe_state'], row['probe_fail_streak'])

  const visible =
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM services
            WHERE resource = 'https://vis.invalid/x' AND ${clause}`,
        )
        .get() as { n: number }
    ).n === 1
  check(`${label} → ${expected ? 'offered' : 'withheld'}`, visible, expected)
}
db.prepare(`DELETE FROM services WHERE resource = 'https://vis.invalid/x'`).run()

console.log(failures === 0 ? '\nall path-parameter tests passed\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
