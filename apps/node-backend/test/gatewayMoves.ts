/**
 * The Gateway burn intent, diffed field by field against the SDK's own.
 *
 * `GatewayClient` cannot be given a signer, so `withdrawFromGateway` rebuilds
 * its burn intent by hand. That transcription is the risky part of this
 * migration: EIP-712 hashes a struct in declaration order, so a reordered field
 * or a mis-padded address yields a different digest, and the failure is either a
 * signature Circle rejects or, worse, one it accepts for a destination nobody
 * intended.
 *
 * This test builds the same intent both ways and asserts they are identical, so
 * a future SDK change that moves a field fails here rather than on mainnet. It
 * needs no credentials and no network: constructing a GatewayClient with a
 * throwaway key is entirely local, and nothing is ever signed or sent.
 *
 * Run with:  npm run test:gateway-moves -w @trident/node-backend
 */
import { GatewayClient } from '@circle-fin/x402-batching/client'
import { privateKeyToAccount } from 'viem/accounts'
import { chainConfig } from '../src/circle/gatewayService.ts'
import { buildBurnIntent } from '../src/circle/gatewayMoves.ts'

let failures = 0

function check(label: string, actual: unknown, expected: unknown): void {
  const norm = (v: unknown) =>
    JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))
  if (norm(actual) !== norm(expected)) {
    failures += 1
    console.error(`  FAIL  ${label}\n        expected ${norm(expected)}, got ${norm(actual)}`)
  } else {
    console.log(`  ok    ${label}`)
  }
}

/* A key that exists only here and holds nothing, purely to satisfy the SDK's
 * constructor. Nothing in this file signs, sends, or reaches the network. */
const THROWAWAY = ('0x' + '11'.repeat(32)) as `0x${string}`
const address = privateKeyToAccount(THROWAWAY).address

console.log('\n  burn intent, ours against the SDK\n')

/* Same-chain and cross-chain, since the two differ in every domain and contract
 * field and a same-chain-only test would miss a swapped source and destination. */
for (const [from, to] of [
  ['baseSepolia', 'baseSepolia'],
  ['baseSepolia', 'arbitrumSepolia'],
  ['base', 'polygon'],
] as const) {
  const client = new GatewayClient({ chain: from, privateKey: THROWAWAY })
  const value = 1_500_000n
  const maxFee = 2_010_000n

  const theirs = (
    client as unknown as { createBurnIntent: (...a: unknown[]) => { spec: Record<string, unknown> } }
  ).createBurnIntent(chainConfig(from), chainConfig(to), value, address, maxFee)

  const ours = buildBurnIntent({
    fromChain: from,
    toChain: to,
    depositor: address,
    recipient: address,
    value,
    maxFee,
    // The only field that legitimately differs: it is random by design.
    salt: theirs.spec['salt'] as `0x${string}`,
  })

  const label = from === to ? `${from} (same chain)` : `${from} to ${to}`
  check(`${label}: field order matches`, Object.keys(ours.spec), Object.keys(theirs.spec))
  check(`${label}: every field identical`, ours, theirs)
}

console.log('\n  the parts that silently lose money\n')

{
  const client = new GatewayClient({ chain: 'base', privateKey: THROWAWAY })
  const theirs = (
    client as unknown as { createBurnIntent: (...a: unknown[]) => { spec: Record<string, unknown> } }
  ).createBurnIntent(chainConfig('base'), chainConfig('polygon'), 1n, address, 1n)

  /* Source and destination must not be interchangeable. If they were, a
   * withdrawal would mint on the chain it burned from. */
  check(
    'source and destination domains differ across chains',
    theirs.spec['sourceDomain'] !== theirs.spec['destinationDomain'],
    true,
  )
  /* Addresses are left-padded to 32 bytes and lowercased. A checksummed or
   * right-padded address hashes differently and the signature is void. */
  check(
    'addresses are lowercase left-padded bytes32',
    /^0x0{24}[0-9a-f]{40}$/.test(String(theirs.spec['sourceDepositor'])),
    true,
  )
  check('and ours pads the same way', 
    /^0x0{24}[0-9a-f]{40}$/.test(
      String(buildBurnIntent({
        fromChain: 'base', toChain: 'polygon', depositor: address,
        recipient: address, value: 1n, maxFee: 1n,
      }).spec.sourceDepositor),
    ),
    true,
  )
}

/* Two intents must never collide, or Circle treats the second as a replay. */
{
  const args = {
    fromChain: 'base', toChain: 'polygon', depositor: address,
    recipient: address, value: 1n, maxFee: 1n,
  } as const
  const a = buildBurnIntent(args)
  const b = buildBurnIntent(args)
  check('each intent gets a fresh salt', a.spec.salt !== b.spec.salt, true)
  check('and it is 32 bytes', /^0x[0-9a-f]{64}$/.test(a.spec.salt), true)
}

console.log(failures === 0 ? '\nall Gateway move tests passed\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
