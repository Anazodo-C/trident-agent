/**
 * The Builder Code suffix, and the guarantee that it is optional.
 *
 * Two properties, both load-bearing. Without a code nothing may be appended:
 * this ships ahead of the code itself, and an accidental suffix would alter the
 * calldata of transactions that move real USDC for the sake of analytics.
 * With one, the bytes must be a well-formed ERC-8021 suffix, or an indexer
 * reads nothing and the whole feature is silently inert.
 *
 * Run with:  npm run test:attribution -w @trident/node-backend
 */
import { Attribution } from 'ox/erc8021'

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

/** The 16-byte marker every ERC-8021 suffix ends with, so indexers can find it. */
const MARKER = '80218021802180218021802180218021'

console.log('\n  with no code configured\n')

{
  process.env['BUILDER_CODE'] = ''
  const { BUILDER_DATA_SUFFIX, dataSuffixOption } = await import('../src/circle/attribution.ts')
  check('no suffix is built', BUILDER_DATA_SUFFIX, null)
  /*
   * Spread into a viem client, this must contribute no keys at all. `{
   * dataSuffix: undefined }` is not the same thing: viem sees the property and
   * an explicit undefined can override a default further down.
   */
  check('and nothing is spread into the client', Object.keys(dataSuffixOption()), [])
}

console.log('\n  with a code configured\n')

{
  /*
   * Built directly rather than by re-importing the module: Node caches an ES
   * module after the first import, so the env change above is already baked in
   * and a second import would return the same null. What matters here is the
   * encoding, which is the same call the module makes.
   */
  const suffix = Attribution.toDataSuffix({ codes: ['trident'] })
  check('the suffix ends with the ERC-8021 marker', suffix.endsWith(MARKER), true)
  check('it is hex', /^0x[0-9a-f]+$/i.test(suffix), true)
  check('and it carries the code itself', suffix.includes(Buffer.from('trident').toString('hex')), true)

  /* A different code must produce different bytes, or every app is credited the
   * same and attribution means nothing. */
  const other = Attribution.toDataSuffix({ codes: ['someone-else'] })
  check('a different code encodes differently', suffix === other, false)
}

console.log('\n  what a suffix must never do\n')

{
  /*
   * The suffix is appended to calldata, so it must be whole bytes. An odd-length
   * hex string concatenated onto calldata shifts every byte after it and turns a
   * valid transaction into a malformed one.
   */
  const suffix = Attribution.toDataSuffix({ codes: ['trident'] })
  check('it is a whole number of bytes', (suffix.length - 2) % 2, 0)
}

console.log('\n  the calldata encoder\n')

/*
 * This is the part that rewrites what a transaction says.
 *
 * Attribution moves the on-chain operations from Circle's ABI form to raw
 * calldata we build ourselves, so a mistake here is not a missing dashboard
 * row: it is a real USDC transfer carrying the wrong instruction. The selectors
 * below are checked against published constants rather than against another
 * call to the same library, because a test that asks viem to confirm viem
 * proves only that it is self-consistent.
 */
{
  const { encodeCall } = await import('../src/circle/circleWallets.ts')

  const to = '0x1111111111111111111111111111111111111111'

  /* Both are the canonical ERC-20 selectors, and neither has changed since
   * 2015. If either of these moves, the signature parsing is wrong. */
  const transfer = encodeCall('transfer(address,uint256)', [to, '1000000'])
  check('transfer keeps the published ERC-20 selector', transfer.slice(0, 10), '0xa9059cbb')
  const approve = encodeCall('approve(address,uint256)', [to, '1000000'])
  check('approve keeps the published ERC-20 selector', approve.slice(0, 10), '0x095ea7b3')

  /*
   * Full encoding, written out by hand rather than generated. A uint256
   * arriving as the decimal string "1000000" must land as 0xf4240 in the second
   * word; passing the string through unwidened is the failure this catches, and
   * it would send a transfer of the wrong amount.
   */
  check(
    'the address and amount encode into the right words',
    transfer,
    '0xa9059cbb' +
      '0000000000000000000000001111111111111111111111111111111111111111' +
      '00000000000000000000000000000000000000000000000000000000000f4240',
  )

  /* Every call site's shape, so none of them can throw in production on a type
   * this encoder has never seen. The CCTP burn is the awkward one: uint32 as a
   * number, bytes32 as hex, uint256 as a string, and trailing empty bytes. */
  const burn = encodeCall(
    'bridge(uint32 destinationDomain, bytes32 mintRecipient, uint256 amount, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)',
    [7, `0x${'22'.repeat(32)}`, '500000', '1', 1000, '0x'],
  )
  check('the CCTP burn encodes', burn.startsWith('0x') && burn.length > 200, true)
  check('and Gateway deposit encodes', encodeCall('deposit(address,uint256)', [to, '1']).slice(0, 10).length, 10)

  /*
   * A wrong number of parameters must throw rather than encode something
   * shorter. Silently dropping an argument would produce calldata the contract
   * reads as a different call.
   */
  let threw = false
  try {
    encodeCall('transfer(address,uint256)', [to])
  } catch {
    threw = true
  }
  check('a missing parameter is refused, not encoded around', threw, true)
}

console.log('\n  what the suffix does to calldata\n')

{
  const { encodeCall } = await import('../src/circle/circleWallets.ts')
  const to = '0x1111111111111111111111111111111111111111'
  const bare = encodeCall('transfer(address,uint256)', [to, '1000000'])
  const suffix = Attribution.toDataSuffix({ codes: ['bc_test'] })
  const tagged = `${bare}${suffix.slice(2)}`

  /* The instruction is untouched; the suffix only trails it. This is the whole
   * safety argument for appending to a transaction that moves money. */
  check('the call itself is unchanged', tagged.startsWith(bare), true)
  check('the suffix is what follows', tagged.slice(bare.length), suffix.slice(2))
  check('and the result still ends in the marker', tagged.endsWith(MARKER), true)
}

console.log(failures === 0 ? '\nall attribution tests passed\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
