/**
 * How a Circle transaction's state is read, and the chain-key mapping.
 *
 * Pure logic, no network and no credentials, so this runs in CI exactly as it
 * runs locally. It earns its place because both halves fail silently and
 * expensively: a terminal state read as "still working" hangs a payment
 * forever, a terminal failure read as success reports a charge that never
 * happened, and a wrong chain key sends real USDC to the right address on the
 * wrong network.
 *
 * Run with:  npm run test:circle -w @trident/node-backend
 */
import {
  circleEnvFor,
  classifyTransactionState,
  circleChainFor,
  isCircleChain,
  jsonWithBigints,
  CIRCLE_SUPPORTED_CHAINS,
} from '../src/circle/circleWallets.ts'
import { toAtomicUsdc } from '../src/circle/gatewayService.ts'
import { parseShortfall } from '../src/routes/migrate.ts'

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

console.log('\n  terminal states\n')

check('COMPLETE is the only success', classifyTransactionState('COMPLETE').ok, true)
check('and it stops the poll', classifyTransactionState('COMPLETE').done, true)
check('with no message to show, because nothing went wrong', classifyTransactionState('COMPLETE').message, '')

for (const state of ['FAILED', 'DENIED', 'CANCELLED', 'STUCK']) {
  const verdict = classifyTransactionState(state)
  check(`${state} stops the poll`, verdict.done, true)
  check(`${state} is not success`, verdict.ok, false)
  check(`${state} explains itself`, verdict.message.length > 20, true)
}

/*
 * The distinction is the point. A user who sees the same sentence for all four
 * cannot tell whether to retry, wait, or stop trying, which is the difference
 * between recovering a payment and giving up on one that would have worked.
 */
{
  const messages = ['FAILED', 'DENIED', 'CANCELLED', 'STUCK'].map(
    (s) => classifyTransactionState(s).message,
  )
  check('all four failures read differently', new Set(messages).size, 4)
}

check(
  'only STUCK asks for a higher fee',
  ['FAILED', 'DENIED', 'CANCELLED', 'STUCK'].filter(
    (s) => classifyTransactionState(s).retryWithHigherFee,
  ),
  ['STUCK'],
)
check(
  'DENIED says retrying will not help, because it will not',
  classifyTransactionState('DENIED').message.includes('not something retrying will change'),
  true,
)

console.log('\n  states still in flight\n')

for (const state of [
  'INITIATED',
  'PENDING_RISK_SCREENING',
  'WAITING',
  'QUEUED',
  'CLEARED',
  'SENT',
]) {
  check(`${state} keeps polling`, classifyTransactionState(state).done, false)
}

/*
 * CONFIRMED is in a block but not final, and a reorg can still take it. The
 * whole reason this module polls rather than trusting a receipt is that a
 * resolved promise was never proof a transaction succeeded.
 */
check('CONFIRMED is not yet success', classifyTransactionState('CONFIRMED').done, false)

/*
 * An unrecognised state must keep polling rather than be guessed at. Circle can
 * add one, and treating an unknown as failure would abandon a live transaction
 * while inviting a retry that double-spends.
 */
check('an unknown state keeps polling', classifyTransactionState('SOMETHING_NEW').done, false)
check('and is never reported as success', classifyTransactionState('SOMETHING_NEW').ok, false)

console.log('\n  chain mapping\n')

check('base maps to BASE', circleChainFor('base'), 'BASE')
check('polygon maps to MATIC, not POLYGON', circleChainFor('polygon'), 'MATIC')
check('the testnet the free tier runs on is supported', circleChainFor('arcTestnet'), 'ARC-TESTNET')
check('ethereum maps to ETH', circleChainFor('ethereum'), 'ETH')

/*
 * These four have no Circle wallet support. They must refuse loudly rather than
 * fall through to a default, which is the failure mode that once routed a
 * mainnet Gateway deposit onto a testnet.
 */
for (const chain of ['hyperEvm', 'sei', 'sonic', 'worldChain'] as const) {
  check(`${chain} is not claimed as supported`, isCircleChain(chain), false)
  let threw = false
  try {
    circleChainFor(chain)
  } catch {
    threw = true
  }
  check(`${chain} throws rather than guessing a network`, threw, true)
}

check(
  'both chains the catalog actually settles on are covered',
  ['base', 'polygon'].every((c) => CIRCLE_SUPPORTED_CHAINS.includes(c as never)),
  true,
)

/* No two chains may share an identifier, or one of them settles on the other. */
{
  const ids = CIRCLE_SUPPORTED_CHAINS.map((c) => circleChainFor(c))
  check('every chain maps to a distinct identifier', ids.length, new Set(ids).size)
}

console.log('\n  which Circle environment a chain belongs to\n')

/*
 * Sandbox and production are separate account spaces. Getting this wrong does
 * not fail loudly: it sends a production key at a testnet chain, or worse tries
 * to sign a real Base payment with sandbox credentials.
 */
for (const chain of ['arcTestnet', 'baseSepolia', 'polygonAmoy', 'arbitrumSepolia'] as const) {
  check(`${chain} is testnet`, circleEnvFor(chain), 'testnet')
}
for (const chain of ['base', 'polygon', 'ethereum', 'arbitrum', 'arc'] as const) {
  check(`${chain} is mainnet`, circleEnvFor(chain), 'mainnet')
}

/* The two chains the catalog actually settles on must both be mainnet, or real
 * payments would be attempted with sandbox credentials. */
check(
  'the settlement chains are both mainnet',
  ['base', 'polygon'].every((c) => circleEnvFor(c as never) === 'mainnet'),
  true,
)

console.log('\n  serialising an authorisation\n')

/*
 * An EIP-3009 authorisation carries uint256 amounts as bigints. JSON.stringify
 * throws on a bigint rather than coercing it, so without this every payment
 * above zero fails at the point of signing, and only above zero: a test that
 * used 0 would pass while the product could not take a single real payment.
 */
{
  let threw = false
  try {
    JSON.stringify({ value: 1_000_000n })
  } catch {
    threw = true
  }
  check('plain JSON.stringify cannot carry a uint256 at all', threw, true)
}

check(
  'a real authorisation amount survives',
  jsonWithBigints({ value: 1_000_000n, validAfter: 0n, validBefore: 1799999999n }),
  '{"value":"1000000","validAfter":"0","validBefore":"1799999999"}',
)
check(
  'and a value past Number.MAX_SAFE_INTEGER keeps every digit',
  jsonWithBigints({ value: 2n ** 80n }),
  '{"value":"1208925819614629174706176"}',
)
check('ordinary fields are untouched', jsonWithBigints({ to: '0xabc', n: 2 }), '{"to":"0xabc","n":2}')

console.log('\n  reading Circle\u2019s fee back out of a rejection\n')

/*
 * Both cases below are verbatim from a real migration. Circle takes its fee
 * from the same ledger, so moving the whole balance is always refused, and the
 * fee is published nowhere: not in /v1/info, not in the SDK, and it differs per
 * chain. The rejection is the only source, which makes parsing it load-bearing.
 */
check(
  'Base: 0.03996 available, 0.04996 required, so 0.01 is the fee',
  parseShortfall(
    new Error(
      'Insufficient balance for depositor 0x236a: available 0.039960, required 0.04996',
    ),
    39_960n,
  ),
  { movableUsdc: '0.02996', feeUsdc: '0.01' },
)
check(
  'Polygon: a different fee on the same code path',
  parseShortfall(
    new Error(
      'Insufficient balance for depositor 0x236a: available 0.074991, required 0.076491',
    ),
    74_991n,
  ),
  { movableUsdc: '0.073491', feeUsdc: '0.0015' },
)

/* Moving the named amount must consume the balance exactly, or finishing the
 * migration is impossible: it requires a zero balance. */
check(
  'the movable amount plus the fee equals what was available',
  (() => {
    const r = parseShortfall(
      new Error('Insufficient balance for depositor 0x0: available 0.074991, required 0.076491'),
      74_991n,
    )!
    // As a string: this harness compares with JSON.stringify, which throws on
    // a bigint, which is the very fault being fixed here.
    return String(toAtomicUsdc(r.movableUsdc) + toAtomicUsdc(r.feeUsdc))
  })(),
  '74991',
)

/* Anything that is not a fee shortfall must not be dressed up as one. */
check('an unrelated error is not a shortfall', parseShortfall(new Error('boom'), 1n), null)
check(
  'a fee larger than the balance is not actionable',
  parseShortfall(new Error('available 0.001, required 5.001'), 1_000n),
  null,
)

console.log(failures === 0 ? '\nall Circle wallet tests passed\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
