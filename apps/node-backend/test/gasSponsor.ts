/**
 * The keeper's gas sponsorship, and the cap that stops it being a drain.
 *
 * This is a funded key that any account holder can cause to spend, so the
 * interesting tests are the refusals, not the happy path. Nothing here sends a
 * transaction: the grant ledger is driven directly, which is what the cap
 * actually reads.
 *
 * Run with:  npm run test:gas -w @trident/node-backend
 */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { parseEther } from 'viem'
import db from '../src/db.ts'
import { GAS_GRANT_LIMIT, ensureGas, gasRefusal, sponsorshipFor } from '../src/circle/gasSponsor.ts'

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

function grant(address: string, chain: string, agoSeconds = 0): void {
  db.prepare(
    `INSERT INTO gas_grants (id, address, chain, amount_wei, tx_hash, created_at)
     VALUES (?, ?, ?, '1', '0xdead', strftime('%s','now') - ?)`,
  ).run(randomUUID(), address.toLowerCase(), chain, agoSeconds)
}

console.log('\n  which chains are sponsored\n')

/*
 * Mainnet only, on purpose. Arc Testnet's faucet hands out gas and USDC
 * together and a user has to visit it for the USDC regardless, so sponsoring
 * there would spend the keeper to save nobody a step.
 */
check('Base is sponsored', sponsorshipFor('base') !== null, true)
check('Polygon is sponsored', sponsorshipFor('polygon') !== null, true)
check('Arc Testnet is not', sponsorshipFor('arcTestnet'), null)

/* The grant has to be worth more than one transaction, or every user
 * transaction is preceded by a keeper transaction and the traffic doubles. */
{
  const base = sponsorshipFor('base')!
  check('the grant exceeds the floor', parseEther(base.grant) > parseEther(base.floor), true)
}

console.log('\n  an unsponsored chain is left alone\n')

{
  const address = `0x${'a'.repeat(40)}` as `0x${string}`
  const outcome = await ensureGas(address, 'arcTestnet')
  check('nothing is granted', outcome.granted, false)
  check(
    'and nothing is recorded',
    db.prepare('SELECT COUNT(*) AS n FROM gas_grants WHERE address = ?').get(address.toLowerCase()),
    { n: 0 },
  )
}

console.log('\n  the daily cap\n')

/*
 * The cap is the entire control on a key that holds real funds and that any
 * account holder can make spend. A caller looping the deposit route must run
 * out, and it must run out per address rather than globally, or one abusive
 * account would deny gas to everybody else.
 */
{
  const address = `0x${'b'.repeat(40)}`
  for (let i = 0; i < GAS_GRANT_LIMIT.perWindow; i += 1) grant(address, 'base')

  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM gas_grants
       WHERE address = ? AND chain = 'base' AND created_at > strftime('%s','now') - ?`,
    )
    .get(address, GAS_GRANT_LIMIT.windowSeconds) as { n: number }
  check('the window counts what was granted', row.n, GAS_GRANT_LIMIT.perWindow)
  check('which is at the cap', row.n >= GAS_GRANT_LIMIT.perWindow, true)

  /* Another address must be unaffected. */
  const other = `0x${'c'.repeat(40)}`
  const otherRow = db
    .prepare('SELECT COUNT(*) AS n FROM gas_grants WHERE address = ?')
    .get(other) as { n: number }
  check('the cap is per address, not global', otherRow.n, 0)
}

console.log('\n  the window rolls\n')

/*
 * A rolling window rather than a running total: a counter would need resetting
 * on a schedule nothing owns, and would lock an account out permanently after
 * one busy day.
 */
{
  const address = `0x${'d'.repeat(40)}`
  grant(address, 'base', GAS_GRANT_LIMIT.windowSeconds + 60)
  const inWindow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM gas_grants
       WHERE address = ? AND created_at > strftime('%s','now') - ?`,
    )
    .get(address, GAS_GRANT_LIMIT.windowSeconds) as { n: number }
  check('a grant older than the window no longer counts', inWindow.n, 0)

  const everRow = db
    .prepare('SELECT COUNT(*) AS n FROM gas_grants WHERE address = ?')
    .get(address) as { n: number }
  check('but it is still on the ledger', everRow.n, 1)
}

console.log('\n  the refusal, when nothing could be done\n')

{
  const message = gasRefusal('base', `0x${'e'.repeat(40)}`).message
  check('names the asset that is missing', /ETH/.test(message), true)
  check('names the chain', /base/i.test(message), true)
  check('gives the address to send to', message.includes('e'.repeat(40)), true)
  check('and says the USDC is safe', /untouched/i.test(message), true)
}

console.log('\n  a grant is not finished when it is sent\n')

/*
 * The bug the first real deposit hit.
 *
 * topUp returned as soon as the transfer was submitted. The caller's very next
 * act is to re-read the balance or ask Circle to estimate, both in the same
 * millisecond, and unmined gas reads exactly like no gas — so the grant went
 * through and the deposit was refused anyway. Asserted on the source, because
 * the alternative is a test that spends real money to prove a wait exists.
 */
{
  const source = await readFile(
    new URL('../src/circle/gasSponsor.ts', import.meta.url),
    'utf8',
  )
  const sendAt = source.indexOf('sendTransaction')
  const waitAt = source.indexOf('waitForTransactionReceipt')
  check('the receipt is awaited at all', waitAt > 0, true)
  check('and after the send, not before', waitAt > sendAt, true)

  /* Bounded, because a user request is blocked on it. An unbounded wait turns a
   * stuck transaction into a hung deposit. */
  check('the wait has a timeout', /timeout: RECEIPT_TIMEOUT_MS/.test(source), true)

  /* The ledger write has to precede the wait, or a timeout loses the record and
   * the cap stops counting a grant that really was sent. */
  const insertAt = source.indexOf('INSERT INTO gas_grants')
  check('the grant is recorded before the wait', insertAt < waitAt, true)
}

db.prepare("DELETE FROM gas_grants WHERE tx_hash = '0xdead'").run()

console.log(failures === 0 ? '\nall gas sponsor tests passed\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
