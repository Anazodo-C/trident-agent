/**
 * Planner parsing / validation tests. No Anthropic calls — these cover the
 * pure logic that guards what the model is allowed to make us pay for.
 *
 * Run with:  npm run test:planner -w @trident/node-backend
 */
import {
  PlanSchema,
  assertStepsAreCatalogued,
  extractJson,
  normalise,
  type ExecutionPlan,
} from '../src/llm/planner.ts'
import {
  GATEWAY_MAINNET_CHAINS,
  chooseChain,
  policyFor,
  unpayableReason,
} from '../src/circle/chainPolicy.ts'
import { findUpgrades } from '../src/circle/upgradeService.ts'
import db from '../src/db.ts'
import { isKnownResource, type Service } from '../src/circle/registryService.ts'

/**
 * A tiny stand-in registry. The real one is synced from the x402 discovery API;
 * these tests only care that the allowlist matches exactly and nothing else.
 */
const DEMO = 'https://x402.org/protected'
function svc(resource: string, name = 'Demo'): Service {
  return {
    id: resource, resource, source: 'x402', premiumCategory: null,
    serviceName: name, description: '', tags: [],
    host: new URL(resource).host, network: 'eip155:8453', chainKey: 'base',
    isTestnet: false, networks: [], priceUsdc: 0.01, httpMethod: 'GET',
    curated: true, calls30d: 10, payers30d: 1, lastCalledAt: null, iconUrl: null,
    trust: 'curated',
  requiredParams: [], pathParams: [],
  bodyShape: null, paramLocation: null, paramEnums: {},
  }
}
const SERVICE_CATALOG: Service[] = [svc(DEMO)]

// isKnownResource reads the services table, so seed the one row it should find.
db.prepare(
  `INSERT OR REPLACE INTO services (id, resource, service_name, host, network, chain_key,
     is_testnet, networks_json, price_usdc, http_method, curated, calls_30d, payers_30d, synced_at)
   VALUES (?, ?, 'Demo', 'x402.org', 'eip155:8453', 'base', 0, '[]', 0.01, 'GET', 1, 10, 1, 0)`,
).run('demo-1', DEMO)

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

function threw(fn: () => unknown): boolean {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

function plan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    goal: 'test',
    steps: [],
    totalEstimatedCostUsdc: 0,
    reasoning: 'because',
    alternativeSteps: [],
    alternativeRoute: null,
    ...overrides,
  }
}

function step(endpointUrl: string, cost = 0.01, stepIndex = 0) {
  return {
    stepIndex,
    serviceName: 'x402 Reference Endpoint',
    endpointUrl,
    httpMethod: 'GET' as const,
    params: {},
    purpose: 'test',
    estimatedCostUsdc: cost,
  }
}

console.log('\x1b[1mTrident planner tests\x1b[0m\n')

// ------------------------------------------------------------- JSON extraction
section('extractJson')
check('parses a bare object', extractJson('{"a":1}') === '{"a":1}')
check(
  'strips a ```json fence',
  extractJson('here you go\n```json\n{"a":1}\n```\nthanks') === '{"a":1}',
)
check('strips a bare ``` fence', extractJson('```\n{"a":2}\n```') === '{"a":2}')
check(
  'recovers an object surrounded by prose',
  extractJson('Sure! {"a":3} Hope that helps.') === '{"a":3}',
)
check('throws when there is no JSON', threw(() => extractJson('no json here')))

// ------------------------------------------------------------ schema coercion
section('PlanSchema')
{
  const parsed = PlanSchema.safeParse({
    goal: 'g',
    steps: [
      {
        stepIndex: 0,
        serviceName: 'x402 Reference Endpoint',
        endpointUrl: 'https://x402.org/protected',
        httpMethod: 'GET',
        // Models routinely emit non-string param values; these must be accepted.
        params: { limit: 10, verbose: true, q: 'text' },
        purpose: 'p',
        estimatedCostUsdc: 0.01,
      },
    ],
    totalEstimatedCostUsdc: 0.01,
    reasoning: 'r',
  })
  check('accepts numeric and boolean params', parsed.success, JSON.stringify(parsed.error?.issues))
  check('defaults alternativeSteps to []', parsed.success && parsed.data.alternativeSteps.length === 0)
}

check(
  'rejects a non-URL endpoint',
  !PlanSchema.safeParse(
    plan({ steps: [step('not-a-url')], totalEstimatedCostUsdc: 0.01 }),
  ).success,
)
check(
  'rejects a negative cost',
  !PlanSchema.safeParse(
    plan({ steps: [step('https://x402.org/protected', -1)], totalEstimatedCostUsdc: -1 }),
  ).success,
)

// -------------------------------------------------------------- normalisation
section('normalise')
{
  const messy = plan({
    steps: [
      step('https://x402.org/protected', 0.01, 7),
      step('https://x402.org/protected', 0.02, 3),
    ],
    // Deliberately wrong: the model's own arithmetic must not be trusted.
    totalEstimatedCostUsdc: 99,
  })
  const clean = normalise(messy)
  check('renumbers stepIndex from 0', clean.steps.map((s) => s.stepIndex).join(',') === '0,1')
  check('recomputes the total from the steps', clean.totalEstimatedCostUsdc === 0.03)
}

// ---------------------------------------------------------- catalog allowlist
section('assertStepsAreCatalogued')
check(
  'accepts a real catalog endpoint',
  !threw(() =>
    assertStepsAreCatalogued(
      plan({ steps: [step(DEMO)] }),
      SERVICE_CATALOG,
    ),
  ),
)
check(
  'rejects a hallucinated host',
  threw(() =>
    assertStepsAreCatalogued(
      plan({ steps: [step('https://attacker.example.com/drain')] }),
      SERVICE_CATALOG,
    ),
  ),
)
check(
  'rejects an invented path on a real host',
  threw(() =>
    assertStepsAreCatalogued(
      plan({ steps: [step('https://x402.org/admin')] }),
      SERVICE_CATALOG,
    ),
  ),
)
check(
  'rejects a prefix-matching lookalike host',
  threw(() =>
    assertStepsAreCatalogued(
      plan({ steps: [step('https://x402.org.evil.com/protected')] }),
      SERVICE_CATALOG,
    ),
  ),
)
check(
  'accepts an empty plan',
  !threw(() => assertStepsAreCatalogued(plan(), SERVICE_CATALOG)),
)

// The runner applies its own allowlist to client-supplied approvedSteps, so it
// must reject exactly the same URLs — including prefix-matching lookalikes.
section('isCataloguedEndpoint (runner allowlist)')
check('accepts an exact catalog URL', isKnownResource(DEMO))
check('rejects an unknown host', !isKnownResource('https://attacker.example.com/drain'))
check(
  'rejects a lookalike host that shares the baseUrl prefix',
  !isKnownResource('https://x402.org.evil.com/protected'),
)
check('rejects an uncatalogued path on a real host', !isKnownResource('https://x402.org/admin'))
check(
  'rejects a query-string appended to a real endpoint',
  !isKnownResource('https://x402.org/protected?redirect=https://evil.com'),
)

// ------------------------------------------------------ mainnet opt-in gate
section('chain policy (mainnet is opt-in)')
{
  const mainnetOnly = [
    { network: 'eip155:8453', chainKey: 'base' as const, isTestnet: false, priceUsdc: 0.01 },
  ]
  const bothChains = [
    ...mainnetOnly,
    { network: 'eip155:5042002', chainKey: 'arcTestnet' as const, isTestnet: true, priceUsdc: 0.01 },
  ]

  const locked = policyFor({ default_chain: 'ARC-TESTNET', mainnet_enabled: 0, mainnet_chain: 'BASE' })
  const opted = policyFor({ default_chain: 'ARC-TESTNET', mainnet_enabled: 1, mainnet_chain: 'BASE' })

  check('mainnet is off by default', locked.mainnetEnabled === false)
  check('a locked wallet cannot pay a mainnet-only service', chooseChain(mainnetOnly, locked) === null)
  check(
    'and the refusal explains why',
    (unpayableReason(mainnetOnly, locked) ?? '').includes('mainnet'),
    String(unpayableReason(mainnetOnly, locked)),
  )
  check('opting in unlocks it', chooseChain(mainnetOnly, opted)?.chain === 'base')
  check(
    'testnet is preferred when a service supports both',
    chooseChain(bothChains, opted)?.isTestnet === true,
  )
  check('a locked wallet still pays the testnet option', chooseChain(bothChains, locked)?.chain === 'arcTestnet')

  /*
   * Gateway pools every domain into one balance, so the chain a seller names
   * is not a constraint on a wallet funded elsewhere. BlockRun publishes 119
   * Polygon-only endpoints; all of them were unreachable while the user's
   * funding chain doubled as a spending allowlist.
   */
  const polygonOnly = [
    { network: 'eip155:137', chainKey: 'polygon' as const, isTestnet: false, priceUsdc: 0.003 },
  ]
  check(
    'the funding chain does not restrict which chains policy permits',
    chooseChain(polygonOnly, opted)?.chain === 'polygon',
    String(chooseChain(polygonOnly, opted)?.chain),
  )
  check(
    'opting into mainnet opts into every Gateway domain, not one',
    GATEWAY_MAINNET_CHAINS.every((chain) => opted.allowed.includes(chain)) &&
      opted.allowed.length > 2,
    opted.allowed.join(','),
  )
  check(
    'the funding chain is still recorded, just no longer a limit',
    opted.fundingChain === 'base',
  )
  check(
    'mainnet stays off until opted in, on every chain',
    locked.allowed.length === 1 && locked.allowed[0] === 'arcTestnet',
    locked.allowed.join(','),
  )
  check(
    'Arc mainnet is excluded — it has no RPC and constructing a client throws',
    !GATEWAY_MAINNET_CHAINS.includes('arc'),
  )
  /*
   * The BlockRun failure, reduced. 0.063 USDC on Base, nothing on Polygon, and
   * a Polygon invoice came back SETTLEMENT_FAILED / insufficient_balance: a
   * Gateway payment draws only from the chain it settles on.
   */
  const onBase = new Map([['base' as const, 0.063]])
  check(
    'a Polygon-only service is refused when the money is on Base',
    chooseChain(polygonOnly, opted, { balances: onBase }) === null,
  )
  check(
    'and the refusal says where to deposit rather than blaming settlement',
    (unpayableReason(polygonOnly, opted, { balances: onBase }) ?? '').includes('polygon') &&
      (unpayableReason(polygonOnly, opted, { balances: onBase }) ?? '').includes('0.063'),
    String(unpayableReason(polygonOnly, opted, { balances: onBase })),
  )
  check(
    'a service offering both settles where the funds are, not where it is cheapest',
    chooseChain(
      [
        { network: 'eip155:137', chainKey: 'polygon' as const, isTestnet: false, priceUsdc: 0.001 },
        { network: 'eip155:8453', chainKey: 'base' as const, isTestnet: false, priceUsdc: 0.01 },
      ],
      opted,
      { balances: onBase },
    )?.chain === 'base',
  )
  check(
    'a balance too small for the price does not count as funded',
    chooseChain(
      [{ network: 'eip155:8453', chainKey: 'base' as const, isTestnet: false, priceUsdc: 0.5 }],
      opted,
      { balances: onBase },
    ) === null,
  )
  check(
    'testnet is exempt — it settles by verification transfer, not Gateway',
    chooseChain(bothChains, opted, { balances: new Map() })?.chain === 'arcTestnet',
  )
  check(
    'with no balance information the check is skipped entirely',
    chooseChain(polygonOnly, opted)?.chain === 'polygon',
  )

  /*
   * The two rails are funded from different pots, so "can we pay this" depends
   * on which one settles it. Gateway draws the ledger inside the GatewayWallet;
   * vanilla draws the EOA's own USDC on the same chain.
   */
  const gatewayOnBase = [
    { network: 'eip155:8453', chainKey: 'base' as const, isTestnet: false, priceUsdc: 0.01,
      gatewayBatchable: true, rail: 'gateway' as const },
  ]
  const vanillaOnBase = [
    { network: 'eip155:8453', chainKey: 'base' as const, isTestnet: false, priceUsdc: 0.01,
      gatewayBatchable: false, rail: 'vanilla' as const },
  ]
  const ledgerOnly = { balances: new Map([['base' as const, 1]]), walletBalances: new Map() }
  const walletOnly = { balances: new Map(), walletBalances: new Map([['base' as const, 1]]) }

  check(
    'a vanilla service is not paid from the Gateway ledger',
    chooseChain(vanillaOnBase, opted, { gatewayOnly: true, ...ledgerOnly }) === null,
  )
  check(
    'but is paid from the wallet balance',
    chooseChain(vanillaOnBase, opted, { gatewayOnly: true, ...walletOnly })?.rail === 'vanilla',
  )
  check(
    'a Gateway service is not paid from the wallet balance',
    chooseChain(gatewayOnBase, opted, { gatewayOnly: true, ...walletOnly }) === null,
  )
  check(
    'gatewayOnly no longer discards the vanilla rail outright',
    chooseChain(vanillaOnBase, opted, { gatewayOnly: true })?.rail === 'vanilla',
  )

  check(
    'the cheapest permitted mainnet option still wins across chains',
    chooseChain(
      [
        { network: 'eip155:137', chainKey: 'polygon' as const, isTestnet: false, priceUsdc: 0.05 },
        { network: 'eip155:10', chainKey: 'optimism' as const, isTestnet: false, priceUsdc: 0.01 },
      ],
      opted,
    )?.chain === 'optimism',
  )
}

// ------------------------------------------------------------ premium upsell
section('premium upgrade suggestions')
{
  // A free service with a declared premium category, and one without.
  db.prepare(
    `INSERT OR REPLACE INTO services (id, resource, source, service_name, description, tags, host,
       network, chain_key, is_testnet, networks_json, price_usdc, http_method, curated, calls_30d,
       payers_30d, synced_at)
     VALUES ('free-wiki', 'https://wiki.test/search', 'free', 'Wiki Search', 'search wikipedia',
       ?, 'wiki.test', 'eip155:5042002', 'arcTestnet', 1, '[]', 0.000001, 'GET', 1, 1000, 0, 0)`,
  ).run(JSON.stringify(['wiki', 'search', 'premium:web search and research']))

  db.prepare(
    `INSERT OR REPLACE INTO services (id, resource, source, service_name, description, tags, host,
       network, chain_key, is_testnet, networks_json, price_usdc, http_method, curated, calls_30d,
       payers_30d, synced_at)
     VALUES ('free-cat', 'https://cat.test/fact', 'free', 'Cat Facts', 'a cat fact',
       ?, 'cat.test', 'eip155:5042002', 'arcTestnet', 1, '[]', 0.000001, 'GET', 0, 100, 0, 0)`,
  ).run(JSON.stringify(['cat', 'facts', 'fun']))

  // A paid search service that should be recommended, and a well-used but
  // unrelated one that should not.
  const paidNets = JSON.stringify([
    { network: 'eip155:8453', chainKey: 'base', isTestnet: false, priceUsdc: 0.01, asset: null, scheme: 'exact' },
  ])
  db.prepare(
    `INSERT OR REPLACE INTO services (id, resource, source, service_name, description, tags, host,
       network, chain_key, is_testnet, networks_json, price_usdc, http_method, curated, calls_30d,
       payers_30d, synced_at)
     VALUES ('paid-search', 'https://paid.test/search', 'x402', 'PaidSearch', 'neural web search and research',
       ?, 'paid.test', 'eip155:8453', 'base', 0, ?, 0.01, 'GET', 1, 5000, 10, 0)`,
  ).run(JSON.stringify(['search', 'research']), paidNets)

  db.prepare(
    `INSERT OR REPLACE INTO services (id, resource, source, service_name, description, tags, host,
       network, chain_key, is_testnet, networks_json, price_usdc, http_method, curated, calls_30d,
       payers_30d, synced_at)
     VALUES ('paid-fun', 'https://fun.test/jokes', 'x402', 'FunGateway', 'jokes and fun content',
       ?, 'fun.test', 'eip155:8453', 'base', 0, ?, 0.01, 'GET', 1, 9000, 10, 0)`,
  ).run(JSON.stringify(['fun', 'facts']), paidNets)

  const opted = policyFor({ default_chain: 'ARC-TESTNET', mainnet_enabled: 1, mainnet_chain: 'BASE' })
  const locked = policyFor({ default_chain: 'ARC-TESTNET', mainnet_enabled: 0, mainnet_chain: 'BASE' })

  const forWiki = findUpgrades([{ stepIndex: 0, endpointUrl: 'https://wiki.test/search' }], opted)
  check('a free service with a paid equivalent gets a suggestion', forWiki.length === 1)
  check(
    'and it is the matching paid service',
    forWiki[0]?.options[0]?.serviceName === 'PaidSearch',
    String(forWiki[0]?.options[0]?.serviceName),
  )

  // The bug this guards: Cat Facts once matched an AI gateway on the tag "fun".
  const forCat = findUpgrades([{ stepIndex: 0, endpointUrl: 'https://cat.test/fact' }], opted)
  check('a free service with no paid equivalent gets no suggestion', forCat.length === 0)

  const forPaidStep = findUpgrades([{ stepIndex: 0, endpointUrl: 'https://paid.test/search' }], opted)
  check('x402 steps are never upsold', forPaidStep.length === 0)

  const whenLocked = findUpgrades([{ stepIndex: 0, endpointUrl: 'https://wiki.test/search' }], locked)
  check('suggestions still appear when mainnet is off', whenLocked.length === 1)
  check(
    'but are marked unavailable',
    whenLocked[0]?.options[0]?.available === false,
    String(whenLocked[0]?.options[0]?.available),
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
