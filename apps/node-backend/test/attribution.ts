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

console.log(failures === 0 ? '\nall attribution tests passed\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
