/**
 * The routes a new account touches on its first visit, over real HTTP.
 *
 * This suite exists because of a specific failure. A commit stopped writing
 * `users.eoa_address` at signup and left three routes gating on it, so every
 * account created after that deploy got 409 on its balance, its deposit address
 * and its first run. Typecheck passed, all eight suites passed, and the break
 * was found by an outside audit creating an account by hand.
 *
 * What that gap was made of: every existing suite tests a function, and the
 * defect lived in the agreement between what signup writes and what the routes
 * read. Nothing crossed that seam. This does, by seeding a row shaped exactly as
 * signup leaves it and then asking the routes about it.
 *
 * Deliberately credential-free. Provisioning a Circle wallet needs a sandbox key
 * that CI does not have, but the seam being tested is on this side of that call:
 * given a row with wallet columns filled in, do the routes recognise the
 * account? So the row is written directly and the Circle call is never made.
 * The full signup path is covered by test:e2e, which does need credentials.
 *
 * Run with:  npm run test:account -w @trident/node-backend
 */
import { randomUUID } from 'node:crypto'

/*
 * Set before importing the server, which reads both at module load and starts
 * listening on PORT as a side effect of the import.
 */
const PORT = Number(process.env['TEST_PORT'] ?? 3987)
process.env['PORT'] = String(PORT)
process.env['JWT_SECRET'] ??= 'test-only-not-a-real-secret'

const { default: db } = await import('../src/db.ts')
const { signFullToken, signSetupToken } = await import('../src/auth/jwt.ts')
const { needsPassphraseSetup } = await import('../src/auth/users.ts')
await import('../src/server.ts')

const BASE = `http://localhost:${PORT}`

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

async function get<T>(path: string, token: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T }
}

async function send<T>(
  path: string,
  token: string,
  body: unknown,
  method = 'POST',
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T }
}

interface SeedOptions {
  testnetWallet?: boolean
  mainnetWallet?: boolean
  mainnetEnabled?: boolean
  /** The legacy column, which no current signup writes. */
  eoaAddress?: string | null
}

/** A row shaped the way a given kind of account actually sits in the table. */
function seed(options: SeedOptions): { id: string; token: string; testnet: string; mainnet: string } {
  const id = randomUUID()
  const testnet = `0x${'a'.repeat(39)}1`
  const mainnet = `0x${'b'.repeat(39)}2`
  db.prepare(
    `INSERT INTO users (
       id, email, eoa_address, spending_cap_usdc, default_chain,
       mainnet_enabled, mainnet_chain, kdf_iterations, payment_key_salt,
       passphrase_verifier,
       circle_wallet_id_testnet, circle_wallet_address_testnet,
       circle_wallet_id, circle_wallet_address
     ) VALUES (?, ?, ?, 10.0, 'ARC-TESTNET', ?, 'BASE', 600000, 'aa', 'bb', ?, ?, ?, ?)`,
  ).run(
    id,
    `account-test-${id}@example.test`,
    options.eoaAddress ?? null,
    options.mainnetEnabled ? 1 : 0,
    options.testnetWallet === false ? null : 'circle-testnet-wallet',
    options.testnetWallet === false ? null : testnet,
    options.mainnetWallet ? 'circle-mainnet-wallet' : null,
    options.mainnetWallet ? mainnet : null,
  )
  return { id, token: signFullToken(id), testnet, mainnet }
}

async function main(): Promise<void> {
  console.log(`\x1b[1mAccount routes\x1b[0m  →  ${BASE}\n`)

  const health = await fetch(`${BASE}/health`)
  check('the server answers', health.ok)

  // ------------------------------------------------------- the new account
  section('An account as signup leaves it: a Circle wallet and no EOA')
  const fresh = seed({})

  {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(fresh.id) as never
    check('is not sent back to passphrase setup', needsPassphraseSetup(row) === false)
  }

  const me = await get<{ user: { eoaAddress: string | null } }>('/auth/me', fresh.token)
  check('can load its own profile', me.status === 200, JSON.stringify(me.body))

  /*
   * The three routes that returned 409 to every new account. Each is asserted
   * on the status code rather than the body: a balance read can legitimately
   * fail on an RPC timeout, but it must never fail because the account is not
   * recognised.
   */
  const balance = await get<{ eoaAddress: string; error?: string }>(
    '/api/wallet/balance',
    fresh.token,
  )
  check(
    'balance does not refuse the account',
    balance.status !== 409,
    `${balance.status} ${balance.body?.error ?? ''}`,
  )
  if (balance.status === 200) {
    check(
      'balance reports the testnet wallet address',
      balance.body.eoaAddress?.toLowerCase() === fresh.testnet.toLowerCase(),
      `${balance.body.eoaAddress} vs ${fresh.testnet}`,
    )
  } else {
    console.log(`  \x1b[33m•\x1b[0m balance returned ${balance.status}, address check skipped`)
  }

  const deposit = await get<{
    address: string | null
    chain: string
    availableChains: { chain: string; isTestnet: boolean; address: string | null }[]
  }>('/api/wallet/deposit-address', fresh.token)
  check('deposit address is issued', deposit.status === 200, JSON.stringify(deposit.body))
  check(
    'and it is the testnet wallet, not a legacy EOA',
    deposit.body?.address?.toLowerCase() === fresh.testnet.toLowerCase(),
    String(deposit.body?.address),
  )
  check(
    'a testnet-only account is offered exactly one chain',
    deposit.body?.availableChains?.length === 1,
    JSON.stringify(deposit.body?.availableChains?.map((c) => c.chain)),
  )

  /*
   * A run must clear the wallet gate. An unknown task id is used deliberately:
   * the 404 proves execution got past the account check to the task lookup,
   * without needing a planner, an LLM or a funded wallet to get there.
   */
  const run = await send<{ error: string }>('/api/agent/run', fresh.token, {
    taskId: '00000000-0000-4000-8000-000000000000',
    approvedSteps: [],
    budgetUsdc: null,
  })
  check(
    'a run is not refused for want of a wallet',
    run.status !== 409,
    `${run.status} ${run.body?.error ?? ''}`,
  )

  // --------------------------------------------------- the two-wallet case
  section('An account with both wallets')
  const both = seed({ mainnetWallet: true, mainnetEnabled: true })
  const twoNetworks = await get<{
    address: string | null
    availableChains: { chain: string; isTestnet: boolean; address: string | null }[]
  }>('/api/wallet/deposit-address', both.token)

  check('deposit address is issued', twoNetworks.status === 200)
  check(
    'the default is still testnet, never mainnet',
    twoNetworks.body?.address?.toLowerCase() === both.testnet.toLowerCase(),
    String(twoNetworks.body?.address),
  )
  check(
    'mainnet chains are offered once opted in',
    (twoNetworks.body?.availableChains ?? []).some((c) => !c.isTestnet),
  )

  /*
   * The check the deposit panel depends on, and the reason this file names
   * addresses at all. Every entry must carry the address of its own
   * environment: one mismatch here is real USDC sent to a sandbox wallet that
   * the production key cannot sign for.
   */
  for (const entry of twoNetworks.body?.availableChains ?? []) {
    const expected = entry.isTestnet ? both.testnet : both.mainnet
    check(
      `${entry.chain} carries its own environment's address`,
      entry.address?.toLowerCase() === expected.toLowerCase(),
      `${entry.address} vs ${expected}`,
    )
  }

  const perChain = await get<{ chain: string; address: string | null }>(
    '/api/wallet/deposit-address?chain=base',
    both.token,
  )
  check('asking for base returns the mainnet address', perChain.body?.address?.toLowerCase() === both.mainnet.toLowerCase())

  // ------------------------------------------- opted in, nothing provisioned
  section('Mainnet enabled but never provisioned')
  const halfway = seed({ mainnetEnabled: true })
  const partial = await get<{
    address: string | null
    availableChains: { chain: string; isTestnet: boolean; address: string | null }[]
  }>('/api/wallet/deposit-address', halfway.token)

  check('the route still answers', partial.status === 200, JSON.stringify(partial.body))
  check(
    'the missing mainnet address reads as missing, not as the testnet one',
    (partial.body?.availableChains ?? [])
      .filter((c) => !c.isTestnet)
      .every((c) => c.address === null),
    JSON.stringify(partial.body?.availableChains),
  )
  check(
    'and the testnet address is unaffected',
    partial.body?.address?.toLowerCase() === halfway.testnet.toLowerCase(),
  )

  // --------------------------------------------------- an account with none
  section('An account with no wallet at all')
  const empty = seed({ testnetWallet: false, eoaAddress: `0x${'c'.repeat(40)}` })

  {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(empty.id) as never
    /*
     * A legacy EOA is not a wallet this product can sign with. Treating one as
     * sufficient is the mirror image of the bug above, and it would let an
     * account through to a payment that cannot be made.
     */
    check('a legacy EOA does not count as a wallet', needsPassphraseSetup(row) === true)
  }

  const noWallet = await get<{ error: string }>('/api/wallet/balance', empty.token)
  check('balance refuses', noWallet.status === 409, `got ${noWallet.status}`)
  check(
    'and the refusal says what to do about it',
    /wallet/i.test(noWallet.body?.error ?? '') && (noWallet.body?.error?.length ?? 0) > 30,
    noWallet.body?.error,
  )

  // ------------------------------------------------------------ token scope
  section('Token scope')
  const setupOnly = signSetupToken(fresh.id)
  const scopeAbuse = await get('/api/wallet/deposit-address', setupOnly)
  check('a setup token cannot read a deposit address', scopeAbuse.status === 403, `got ${scopeAbuse.status}`)

  report()
}

function report(): void {
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

// The server needs a moment to bind before the first request.
await new Promise((resolve) => setTimeout(resolve, 500))
main().catch((err: unknown) => {
  console.error('\n\x1b[31mAccount route harness crashed:\x1b[0m', err)
  process.exit(1)
})
