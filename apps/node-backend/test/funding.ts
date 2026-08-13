/**
 * The funding ladder: which chain a payment settles on, and what has to move
 * first.
 *
 * Pure selection logic over a fake balance map, so none of this touches a
 * network. It is worth testing hard because the alternative to getting it right
 * is not an error message: it is real USDC crossing a bridge it did not need to
 * cross, or a service reported as unaffordable while the money sits one chain
 * away.
 *
 * Run with:  npm run test:funding -w @trident/node-backend
 */
import type { SupportedChainName } from '@circle-fin/x402-batching/client'
import {
  chooseChain,
  fundingRouteFor,
  unpayableReason,
  type ChainPolicy,
  type ServiceNetworkLike,
} from '../src/circle/chainPolicy.ts'
import { spendableTotalUsdc } from '../src/circle/gatewayService.ts'

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

/** Mainnet enabled, which is what makes every Gateway chain permitted. */
const POLICY: ChainPolicy = {
  allowed: ['arcTestnet', 'base', 'polygon', 'arbitrum', 'optimism'],
  testnet: 'arcTestnet',
  fundingChain: 'base',
  mainnetEnabled: true,
}

/** A Gateway-settleable option on one chain at one price. */
const gw = (chain: SupportedChainName, priceUsdc: number): ServiceNetworkLike => ({
  network: `eip155:${chain}`,
  chainKey: chain,
  isTestnet: false,
  priceUsdc,
  gatewayBatchable: true,
  rail: 'gateway',
})

const vanilla = (chain: SupportedChainName, priceUsdc: number): ServiceNetworkLike => ({
  ...gw(chain, priceUsdc),
  gatewayBatchable: false,
  rail: 'vanilla',
})

const pot = (entries: Partial<Record<SupportedChainName, number>>) =>
  new Map(Object.entries(entries) as [SupportedChainName, number][])

const empty = pot({})

// ───────────────────────────────────────────────────── the four rungs

console.log('\nrungs')

check(
  'already in Gateway on the invoice chain is ready',
  fundingRouteFor(gw('base', 1), { balances: pot({ base: 5 }), walletBalances: empty }),
  'ready',
)
check(
  'in the wallet on the invoice chain needs a deposit',
  fundingRouteFor(gw('base', 1), { balances: empty, walletBalances: pot({ base: 5 }) }),
  'deposit',
)
check(
  'in the wallet on another chain needs a bridge',
  fundingRouteFor(gw('polygon', 1), { balances: empty, walletBalances: pot({ base: 5 }) }),
  'bridge',
)
check(
  'in Gateway on another chain needs a withdrawal first',
  fundingRouteFor(gw('polygon', 1), { balances: pot({ base: 5 }), walletBalances: empty }),
  'withdraw-bridge',
)
check(
  'nothing anywhere is unpayable',
  fundingRouteFor(gw('base', 1), { balances: empty, walletBalances: empty }),
  null,
)

// ─────────────────────────────────────────────────────── what blocks a rung

console.log('\nlimits')

/*
 * Bridging can only deliver to a chain the router and receiver are deployed on.
 * Arbitrum is permitted and may well be funded one day; it cannot be a bridge
 * target until the contracts exist there, and pretending otherwise would start
 * a burn with nowhere to land.
 */
check(
  'an invoice on a chain we cannot deliver to is unpayable from elsewhere',
  fundingRouteFor(gw('arbitrum', 1), { balances: empty, walletBalances: pot({ base: 50 }) }),
  null,
)
check(
  'but it is payable when the money is already there',
  fundingRouteFor(gw('arbitrum', 1), { balances: pot({ arbitrum: 5 }), walletBalances: empty }),
  'ready',
)
// The vanilla rail signs against the USDC contract on the invoice's own chain.
// Nothing can be moved in to help, so it is strict where the Gateway rail is not.
check(
  'the vanilla rail cannot be funded by moving money',
  fundingRouteFor(vanilla('polygon', 1), { balances: pot({ base: 50 }), walletBalances: pot({ base: 50 }) }),
  null,
)
check(
  'the vanilla rail pays from the wallet on its own chain',
  fundingRouteFor(vanilla('polygon', 1), { balances: empty, walletBalances: pot({ polygon: 5 }) }),
  'ready',
)
check(
  'a balance below the price does not count',
  fundingRouteFor(gw('base', 10), { balances: pot({ base: 9.99 }), walletBalances: empty }),
  null,
)
check(
  'no balance information at all means no gating',
  fundingRouteFor(gw('base', 1), {}),
  'ready',
)

// ──────────────────────────────────────────── effort beats price

console.log('\nordering')

/*
 * The rule that stops the agent paying a CCTP fee and waiting minutes to save a
 * tenth of a cent. A cheaper option on a chain the money is not on loses to a
 * dearer one that can be paid immediately.
 */
const cheapElsewhere = [gw('base', 0.05), gw('polygon', 0.01)]
check(
  'an option payable now beats a cheaper one that needs a bridge',
  chooseChain(cheapElsewhere, POLICY, { balances: pot({ base: 5 }), walletBalances: empty })?.chain,
  'base',
)
check(
  'and it is reported as ready',
  chooseChain(cheapElsewhere, POLICY, { balances: pot({ base: 5 }), walletBalances: empty })?.route,
  'ready',
)
check(
  'with no reason to prefer either, price decides',
  chooseChain(cheapElsewhere, POLICY, {
    balances: pot({ base: 5, polygon: 5 }),
    walletBalances: empty,
  })?.chain,
  'polygon',
)
check(
  'a deposit is preferred over a bridge',
  chooseChain([gw('base', 0.05), gw('polygon', 0.01)], POLICY, {
    balances: empty,
    walletBalances: pot({ base: 5 }),
  })?.route,
  'deposit',
)
check(
  'and when only a bridge will do, it is chosen and reported',
  chooseChain([gw('polygon', 0.01)], POLICY, {
    balances: empty,
    walletBalances: pot({ base: 5 }),
  })?.route,
  'bridge',
)

// ───────────────────────────────────────────────── what the user is told

console.log('\nrefusals')

check(
  'too little money reads as a shortfall, not a deposit instruction',
  unpayableReason([gw('base', 10)], POLICY, {
    gatewayOnly: true,
    balances: pot({ base: 1 }),
    walletBalances: pot({ polygon: 2 }),
  }),
  'This service costs 10 USDC and your balance is 3 USDC across every network. Add funds in Wallet to use it.',
)
check(
  'a chain we cannot reach reads as our gap, not the user’s',
  unpayableReason([gw('arbitrum', 1)], POLICY, {
    gatewayOnly: true,
    balances: empty,
    walletBalances: pot({ base: 50 }),
  }),
  'This service settles only on arbitrum, which the agent cannot move funds to yet. Nothing was charged.',
)
check(
  'mainnet still takes priority over any funding advice',
  unpayableReason([gw('base', 1)], { ...POLICY, mainnetEnabled: false, allowed: ['arcTestnet'] }, {
    gatewayOnly: true,
    balances: empty,
    walletBalances: empty,
  }),
  'This service settles on mainnet. Enable mainnet spending in Wallet to use it.',
)

/*
 * The one mainnet number.
 *
 * Its whole justification is that a user should not have to know which chain or
 * which pot their money is in, so the two properties worth pinning are that the
 * sum is exact and that it does not flinch when the agent shuffles funds.
 */
console.log('\n  one mainnet balance\n')

check(
  'wallet across chains sums every chain, not just the active one',
  spendableTotalUsdc(new Map([['base', '10.5'], ['polygon', '4.25'], ['arbitrum', '0.25']]), '0')
    ?.walletAcrossChains,
  '15',
)
check(
  'the total is wallet plus Gateway',
  spendableTotalUsdc(new Map([['base', '10.5'], ['polygon', '4.25']]), '6.75')?.spendable,
  '21.5',
)
check(
  'summing in atomic units, so 0.1 + 0.2 is 0.3 and not 0.30000000000000004',
  spendableTotalUsdc(new Map([['base', '0.1'], ['polygon', '0.2']]), '0')?.walletAcrossChains,
  '0.3',
)
check(
  'a sub-cent balance survives to six places',
  spendableTotalUsdc(new Map([['base', '0.000001']]), '0.000002')?.spendable,
  '0.000003',
)

/*
 * Moving money between pots must not move the number. This is the invariant the
 * user actually watches: the agent deposits wallet USDC into Gateway to pay a
 * batched invoice, and a total that twitched during that would look like a
 * charge that never happened.
 */
{
  const before = spendableTotalUsdc(new Map([['base', '12.5'], ['polygon', '4']]), '6.75')
  // Rung 2 of the ladder: 5 USDC leaves the Base wallet, arrives in Gateway.
  const after = spendableTotalUsdc(new Map([['base', '7.5'], ['polygon', '4']]), '11.75')
  check('a wallet to Gateway deposit leaves the total unchanged', after?.spendable, before?.spendable)
  check(
    'though the wallet side alone does move',
    after?.walletAcrossChains !== before?.walletAcrossChains,
    true,
  )
}
{
  const before = spendableTotalUsdc(new Map([['base', '20'], ['polygon', '0']]), '5')
  // Rung 3: a CCTP burn on Base credits Gateway on Polygon.
  const after = spendableTotalUsdc(new Map([['base', '12'], ['polygon', '0']]), '13')
  check('a bridge to Gateway leaves the total unchanged', after?.spendable, before?.spendable)
}

check(
  'an unreadable wallet is null, not a total that omits it',
  spendableTotalUsdc(null, '5'),
  null,
)
check(
  'a failed Gateway read nulls the total but keeps the wallet figure',
  spendableTotalUsdc(new Map([['base', '3']]), null)?.spendable,
  null,
)
check(
  'and that wallet figure is still correct',
  spendableTotalUsdc(new Map([['base', '3']]), null)?.walletAcrossChains,
  '3',
)

console.log(failures === 0 ? '\nall funding tests passed\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
