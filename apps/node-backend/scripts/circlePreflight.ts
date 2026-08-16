/**
 * Is Circle actually usable, in each environment, right now?
 *
 * This exists because working it out by hand took an afternoon and produced two
 * wrong conclusions along the way. Sandbox and production are separate account
 * spaces with separate keys, separate wallet sets and separate entity secret
 * registrations, and nothing about a misconfiguration announces itself: a
 * missing production registration looks exactly like a working setup until the
 * first real payment fails.
 *
 * Prints names, shapes and ids. Never a key, never the entity secret.
 *
 * Run with:      npm run circle:preflight -w @trident/node-backend
 * Against prod:  railway run --service trident-agent npm run circle:preflight -w @trident/node-backend
 *
 * Pass --write to additionally prove the entity secret is registered, which no
 * read-only call can show. That creates one wallet, so it is opt-in and refused
 * outright on mainnet: a stray production wallet is clutter in an account that
 * holds real money.
 */
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets'
import { CIRCLE_API_KEY, CIRCLE_API_KEY_MAINNET } from '../src/env.ts'
import {
  circleEnabled,
  entitySecretFor,
  walletSetFor,
  type CircleEnv,
} from '../src/circle/circleWallets.ts'

const WRITE = process.argv.includes('--write')

const ok = (m: string) => console.log(`  \x1b[32mok\x1b[0m    ${m}`)
const bad = (m: string) => console.log(`  \x1b[31mno\x1b[0m    ${m}`)
const note = (m: string) => console.log(`        ${m}`)

let problems = 0
function fail(m: string, remedy?: string): void {
  problems += 1
  bad(m)
  if (remedy) note(remedy)
}

/** The environment a key claims by its prefix, which must match where it is used. */
function keyKind(key: string): 'testnet' | 'mainnet' | 'unknown' {
  if (key.startsWith('TEST_API_KEY')) return 'testnet'
  if (key.startsWith('LIVE_API_KEY')) return 'mainnet'
  return 'unknown'
}

async function checkEnv(env: CircleEnv): Promise<void> {
  console.log(`\n\x1b[1m${env}\x1b[0m`)

  const key = env === 'mainnet' ? CIRCLE_API_KEY_MAINNET : CIRCLE_API_KEY
  const secret = entitySecretFor(env)
  const setId = walletSetFor(env)
  const keyVar = env === 'mainnet' ? 'CIRCLE_API_KEY_MAINNET' : 'CIRCLE_API_KEY'
  const setVar = env === 'mainnet' ? 'CIRCLE_WALLET_SET_ID_MAINNET' : 'CIRCLE_WALLET_SET_ID'

  if (!key) return fail(`${keyVar} is not set`)
  if (!secret) {
    return fail(
      env === 'mainnet'
        ? 'no entity secret for mainnet (CIRCLE_ENTITY_SECRET_MAINNET or CIRCLE_ENTITY_SECRET)'
        : 'CIRCLE_ENTITY_SECRET is not set',
    )
  }
  if (!setId) {
    return fail(
      `${setVar} is not set`,
      `Create a wallet set with the ${env} key, then set ${setVar} to the id it returns.`,
    )
  }

  /*
   * A key used in the wrong environment authenticates against the wrong account
   * space and reports an empty one, which reads as "nothing configured" rather
   * than "wrong key". Catch it on the prefix instead.
   */
  const kind = keyKind(key)
  if (kind === 'unknown') note(`${keyVar} has an unrecognised prefix, cannot confirm its environment`)
  else if (kind !== env) {
    return fail(
      `${keyVar} is a ${kind} key but is being used for ${env}`,
      'Circle scopes every resource to the key. Wallets made with the other key are invisible here.',
    )
  } else ok(`${keyVar} is a ${env} key`)

  if (!circleEnabled(env)) return fail(`${env} is not enabled despite the variables above`)

  const client = initiateDeveloperControlledWalletsClient({ apiKey: key, entitySecret: secret })

  let sets: { id?: string; name?: string }[]
  try {
    const res = await client.listWalletSets({})
    sets = res.data?.walletSets ?? []
    ok(`the key authenticates, ${sets.length} wallet set(s) visible`)
  } catch (err) {
    return fail(
      `the key was rejected: ${(err as Error)?.message?.slice(0, 160)}`,
      'Check it is the right key for this environment and has not been revoked.',
    )
  }

  if (sets.some((s) => s.id === setId)) {
    ok(`${setVar} points at a real wallet set`)
  } else {
    fail(
      `${setVar} (${setId}) is not among this environment's wallet sets`,
      sets.length > 0
        ? `Available here: ${sets.map((s) => `${s.id} (${s.name ?? 'unnamed'})`).join(', ')}`
        : 'This environment has no wallet sets at all. Create one with this key.',
    )
  }

  /*
   * The registration check. Listing wallet sets needs only the API key, so
   * everything above can pass while signing is impossible, which is exactly the
   * state that shipped a broken mainnet once already.
   */
  if (!WRITE) {
    note('entity secret registration unverified (read-only). Re-run with --write on testnet.')
    return
  }
  if (env === 'mainnet') {
    note('entity secret registration unverified: --write is refused on mainnet by design.')
    return
  }

  try {
    const res = await client.createWallets({
      accountType: 'EOA',
      blockchains: ['ARC-TESTNET'] as never[],
      count: 1,
      walletSetId: setId,
      idempotencyKey: crypto.randomUUID(),
    })
    ok(`entity secret is registered here (made ${res.data?.wallets?.[0]?.address})`)
  } catch (err) {
    const message = (err as Error)?.message ?? String(err)
    fail(
      `entity secret is not usable here: ${message.slice(0, 160)}`,
      /entity secret/i.test(message)
        ? 'Register the same 32-byte secret in Circle’s console with the environment switched ' +
          'to this one, and keep that recovery file. Registration is per environment.'
        : undefined,
    )
  }
}

console.log('\nCircle preflight' + (WRITE ? ' (--write)' : ''))
await checkEnv('testnet')
await checkEnv('mainnet')

console.log(
  problems === 0
    ? '\n\x1b[32m\x1b[1mBoth environments look usable.\x1b[0m\n'
    : `\n\x1b[31m\x1b[1m${problems} problem(s). Payments will fail in any environment marked above.\x1b[0m\n`,
)
process.exit(problems === 0 ? 0 : 1)
