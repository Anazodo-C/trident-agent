import { Router } from 'express'
import { z } from 'zod'
import { erc20Abi, createPublicClient, http } from 'viem'
import db from '../db.ts'
import { asyncRoute, httpError } from '../http.ts'
import { currentUser, requireAuth } from '../auth/jwt.ts'
import { findUserById } from '../auth/users.ts'
import {
  chainConfig,
  rpcUrlFor,
  safeErrorMessage,
  fromAtomicUsdc,
  toAtomicUsdc,
  unifiedGatewayBalance,
  walletUsdcByChain,
} from '../circle/gatewayService.ts'
import {
  jsonWithBigints,
  circleEnabled,
  circleEnvFor,
  provisionWallet,
  walletForChain,
  type CircleEnv,
} from '../circle/circleWallets.ts'
import {
  buildBurnIntent,
  BURN_INTENT_TYPES,
  gatewayApiBase,
  mintGatewayAttestation,
  submitBurnIntent,
} from '../circle/gatewayMoves.ts'
import { GATEWAY_MAINNET_CHAINS, policyFor } from '../circle/chainPolicy.ts'
import type { SupportedChainName } from '@circle-fin/x402-batching/client'

/**
 * Moving an existing user from a key we hold to a wallet Circle signs for.
 *
 * The hard constraint shaping all of this: the old address's funds can only be
 * released by the old key, and Circle cannot sign for an address it did not
 * create. So the browser signs and this relays, rather than the key being sent
 * here even once. A single transmission during migration would be a smaller
 * version of exactly the problem this whole change exists to remove.
 *
 * Every step is separately resumable. A migration that dies half way must
 * continue from where it stopped, because the alternative to resuming is
 * re-running a transfer that already landed.
 */

const router = Router()

/** Chains a migrating user might hold funds on. */
function chainsFor(row: { default_chain: string; mainnet_enabled: number; mainnet_chain: string }) {
  const policy = policyFor(row)
  return policy.mainnetEnabled ? [policy.testnet, ...GATEWAY_MAINNET_CHAINS] : [policy.testnet]
}

/**
 * The chains whose balances are worth blocking a migration over.
 *
 * Only mainnet. Testnet USDC has no value, and refusing to finish because some
 * is left behind protects nothing while stranding the user in a half-migrated
 * state, which is the genuinely dangerous place to be. It is also still theirs:
 * they keep the old key, so a faucet balance stays reachable forever.
 */
function realMoneyChains(row: Parameters<typeof chainsFor>[0]) {
  return chainsFor(row).filter((c) => chainConfig(c).chain.testnet !== true)
}

/* ------------------------------------------------------------------ status */

router.get(
  '/status',
  requireAuth,
  asyncRoute(async (req, res) => {
    const row = findUserById(currentUser(req).id)
    if (!row) throw httpError(404, 'No such account')

    const oldAddress = row.eoa_address
    const chains = chainsFor(row)

    /*
     * What is still at the old address. Read live rather than remembered: a
     * migration can span days, and a stale figure is how a sweep gets marked
     * complete while money is still sitting there.
     */
    let walletByChain: { chain: string; usdc: string }[] = []
    let testnetByChain: { chain: string; usdc: string }[] = []
    let gatewayByChain: { chain: string; usdc: string }[] = []
    let gatewayUsdc = '0'
    if (oldAddress) {
      const [wallet, gateway] = await Promise.all([
        walletUsdcByChain(oldAddress, chains).catch(() => null),
        unifiedGatewayBalance(oldAddress, chains.filter((c) => !chainConfig(c).chain.testnet)).catch(
          () => null,
        ),
      ])
      /*
       * Split by whether it is real. Only mainnet balances hold up finishing;
       * testnet ones are listed so the user knows what they are leaving, and
       * leaving them is fine because the old key goes with them.
       */
      const all = [...(wallet?.entries() ?? [])].filter(([, amount]) => Number(amount) > 0)
      walletByChain = all
        .filter(([chain]) => chainConfig(chain as SupportedChainName).chain.testnet !== true)
        .map(([chain, amount]) => ({ chain, usdc: String(amount) }))
      testnetByChain = all
        .filter(([chain]) => chainConfig(chain as SupportedChainName).chain.testnet === true)
        .map(([chain, amount]) => ({ chain, usdc: String(amount) }))
      gatewayUsdc = gateway?.totalUsdc ?? '0'
      /*
       * Per chain, because a Gateway balance is not one pot.
       *
       * The panel used to offer a single button that asked to move the total
       * from Base. A ledger holding 0.04 on Base and 0.07 on Polygon cannot
       * satisfy a request for 0.11 against Base, and Circle rightly refused.
       */
      gatewayByChain = (gateway?.byChain ?? [])
        .filter((b) => Number(b.usdc) > 0)
        .map((b) => ({ chain: b.chain, usdc: b.usdc }))
    }

    res.json({
      state: row.migration_state,
      oldAddress,
      newAddress: row.circle_wallet_address,
      newTestnetAddress: row.circle_wallet_address_testnet,
      hasVerifier: Boolean(row.passphrase_verifier),
      /** True while the old key still exists and can be handed back. */
      keyStillAvailable: Boolean(row.encrypted_payment_key),
      remaining: { walletByChain, gatewayByChain, gatewayUsdc },
      /** Left behind by choice. Never blocks finishing. */
      testnetRemaining: testnetByChain,
    })
  }),
)

/* -------------------------------------------------------------- provision */

router.post(
  '/provision',
  requireAuth,
  asyncRoute(async (req, res) => {
    const user = currentUser(req)
    const row = findUserById(user.id)
    if (!row) throw httpError(404, 'No such account')

    /*
     * One wallet per environment the user actually needs.
     *
     * Sandbox and production are separate account spaces, so a user who spends
     * real money needs two, at two addresses. Both are provisioned here rather
     * than lazily at first payment, so a run never stops half way to create a
     * wallet.
     *
     * Idempotent per environment: an existing one is returned rather than a
     * second being made that the user would then have to migrate again.
     */
    const chains = chainsFor(row)
    const wanted: CircleEnv[] = [...new Set(chains.map(circleEnvFor))]
    const created: string[] = []

    for (const env of wanted) {
      const already =
        env === 'mainnet'
          ? row.circle_wallet_id && row.circle_wallet_address
          : row.circle_wallet_id_testnet && row.circle_wallet_address_testnet
      if (already) continue
      if (!circleEnabled(env)) {
        // Not fatal for the other environment: a user who can only be set up on
        // testnet today should still get that far.
        continue
      }

      const wallet = await provisionWallet(env, chains)
      const cols =
        env === 'mainnet'
          ? 'circle_wallet_id = ?, circle_wallet_address = ?'
          : 'circle_wallet_id_testnet = ?, circle_wallet_address_testnet = ?'
      db.prepare(
        `UPDATE users SET ${cols}, migration_state = COALESCE(migration_state, 'provisioned')
         WHERE id = ?`,
      ).run(wallet.walletId, wallet.address, user.id)
      created.push(env)
    }

    const after = findUserById(user.id)!
    res.json({
      address: after.circle_wallet_address,
      testnetAddress: after.circle_wallet_address_testnet,
      created,
      missing: wanted.filter((e) => !circleEnabled(e)),
    })
  }),
)

/**
 * Read the fee back out of a rejection.
 *
 * Circle reports "available X, required Y" in USDC decimals. Y exceeds the
 * requested value by exactly the fee, so the largest movable amount is
 * available minus that fee, and moving it empties the ledger.
 *
 * Returns null for any other failure, so an unrelated error is never
 * misreported as a fee problem.
 */
export function parseShortfall(
  err: unknown,
  requestedAtomic: bigint,
): { movableUsdc: string; feeUsdc: string } | null {
  const message = err instanceof Error ? err.message : String(err)
  const match = /available\s+([\d.]+),\s*required\s+([\d.]+)/i.exec(message)
  if (!match?.[1] || !match[2]) return null

  const available = toAtomicUsdc(match[1])
  const required = toAtomicUsdc(match[2])
  const fee = required - requestedAtomic
  if (fee <= 0n || fee >= available) return null

  return { movableUsdc: fromAtomicUsdc(available - fee), feeUsdc: fromAtomicUsdc(fee) }
}

/* --------------------------------------------------- gateway balance out */

/**
 * Burn intents awaiting a signature, keyed by user.
 *
 * Held here rather than round-tripped through the browser so the client cannot
 * choose what it is signing. A client-supplied intent would have to be checked
 * field by field against what we would have built anyway, and getting that
 * check subtly wrong is how a signature ends up authorising a transfer to
 * somewhere nobody intended.
 *
 * In memory and short lived: a lost one costs a retry, nothing more.
 */
const pendingIntents = new Map<
  string,
  { intent: unknown; chain: SupportedChainName; requestedAtomic: bigint; at: number }
>()
const INTENT_TTL_MS = 10 * 60_000

router.post(
  '/gateway-intent',
  requireAuth,
  asyncRoute(async (req, res) => {
    const user = currentUser(req)
    const row = findUserById(user.id)
    if (!row?.eoa_address) throw httpError(404, 'No agent wallet for this account')
    const parsed = z
      .object({ chain: z.string().min(1), amountUsdc: z.string().min(1) })
      .safeParse(req.body)
    if (!parsed.success) throw httpError(400, 'Invalid request body')
    const chain = parsed.data.chain as SupportedChainName
    const wallet = walletForChain(row, chain)

    /*
     * Straight to the new wallet, not back to the old address first.
     *
     * A Gateway withdrawal can name any recipient, so routing it through the
     * old EOA would add a transfer, a gas requirement on an address we are
     * abandoning, and one more place for a half-finished migration to strand
     * funds.
     */
    const value = BigInt(Math.round(Number(parsed.data.amountUsdc) * 1_000_000))
    const intent = buildBurnIntent({
      fromChain: chain,
      toChain: chain,
      depositor: row.eoa_address,
      recipient: wallet.address,
      value,
      maxFee: 2_010_000n,
    })

    pendingIntents.set(user.id, { intent, chain, requestedAtomic: value, at: Date.now() })

    /*
     * Sent with bigints stringified, not through res.json.
     *
     * A burn intent carries uint256 values, and JSON.stringify throws on a
     * bigint rather than coercing it, so res.json produced a 500 for every
     * attempt. Verified that viem signs a decimal-string uint256 to the exact
     * same signature as the bigint, so the browser is signing the same digest.
     *
     * The copy held server-side keeps its real bigints: submitBurnIntent does
     * its own bigint-safe serialisation, and the value Circle attests must come
     * from there rather than from a round trip through the client.
     */
    res.type('application/json').send(
      jsonWithBigints({
        typedData: {
          domain: { name: 'GatewayWallet', version: '1' },
          types: BURN_INTENT_TYPES,
          primaryType: 'BurnIntent',
          message: intent,
        },
      }),
    )
  }),
)

router.post(
  '/gateway-transfer',
  requireAuth,
  asyncRoute(async (req, res) => {
    const user = currentUser(req)
    const row = findUserById(user.id)
    if (!row) throw httpError(404, 'No such account')

    const parsed = z.object({ signature: z.string().min(1) }).safeParse(req.body)
    if (!parsed.success) throw httpError(400, 'Invalid request body')

    const pending = pendingIntents.get(user.id)
    if (!pending || Date.now() - pending.at > INTENT_TTL_MS) {
      pendingIntents.delete(user.id)
      throw httpError(409, 'That transfer request expired. Start the step again.')
    }

    /*
     * Circle takes its fee out of the same ledger, so a request to move the
     * whole balance can never be satisfied: it needs value + fee and only
     * value is there.
     *
     * The fee is not published anywhere. It is not in /v1/info, the SDK has no
     * endpoint for it, and it differs per chain (0.01 on Base, 0.0015 on
     * Polygon when this was written). The rejection states it exactly though,
     * so rather than hardcode a number that will drift, read it back and tell
     * the caller precisely how much is movable. Requesting available minus fee
     * consumes the balance to zero, which is what finishing requires.
     */
    let attestation: { attestation: string; signature: string }
    try {
      attestation = await submitBurnIntent(
        gatewayApiBase(pending.chain),
        pending.intent,
        parsed.data.signature,
      )
    } catch (err) {
      const shortfall = parseShortfall(err, pending.requestedAtomic)
      if (shortfall) {
        pendingIntents.delete(user.id)
        throw httpError(
          409,
          `Circle charges a fee from the same balance, so the whole amount cannot move at ` +
            `once. Retry with ${shortfall.movableUsdc} USDC.`,
          { movableUsdc: shortfall.movableUsdc, feeUsdc: shortfall.feeUsdc },
        )
      }
      throw err
    }

    /*
     * The keeper pays for the mint, not the wallet receiving the funds.
     *
     * A freshly provisioned Circle wallet holds no native token anywhere, so
     * charging it for its own first delivery would make migration impossible
     * for exactly the people who need it. Zero destinationCaller means anyone
     * may submit, and the attestation names the recipient, so this cannot be
     * redirected.
     */
    const mintTxHash = await mintGatewayAttestation(
      pending.chain,
      attestation.attestation,
      attestation.signature,
    )

    pendingIntents.delete(user.id)
    db.prepare(
      `UPDATE users SET migration_state = 'gateway-withdrawn' WHERE id = ? AND migration_state = 'provisioned'`,
    ).run(user.id)

    res.json({ mintTxHash })
  }),
)

/* ---------------------------------------------------------------- finish */

router.post(
  '/complete',
  requireAuth,
  asyncRoute(async (req, res) => {
    const user = currentUser(req)
    const row = findUserById(user.id)
    if (!row?.eoa_address) throw httpError(404, 'No agent wallet for this account')
    if (!row.passphrase_verifier) {
      throw httpError(
        409,
        'Cannot finish: no passphrase verifier is set, so you would be locked out of ' +
          'confirming spends. Unlock once and try again.',
      )
    }

    /*
     * Verify the money actually moved before destroying the only thing that
     * could move it. Trusting the client's word here would turn a failed sweep
     * into permanently stranded funds.
     */
    const chains = realMoneyChains(row)
    const [wallet, gateway] = await Promise.all([
      walletUsdcByChain(row.eoa_address, chains).catch(() => null),
      unifiedGatewayBalance(row.eoa_address, chains).catch(() => null),
    ])
    if (!wallet || !gateway) {
      throw httpError(502, 'Could not read the old balances, so nothing was deleted. Try again.')
    }

    const stillHeld = [...wallet.entries()].filter(([, amount]) => Number(amount) > 0)
    if (stillHeld.length > 0 || Number(gateway.totalUsdc) > 0) {
      const where = stillHeld.map(([c, a]) => `${a} on ${c}`).join(', ')
      throw httpError(
        409,
        `The old wallet still holds real funds (${where || `${gateway.totalUsdc} in Gateway`}), ` +
          'so nothing was deleted. Finish moving them first.',
      )
    }

    /*
     * The ciphertext and IV go; the salt and iteration count stay.
     *
     * Those two are parameters, not secrets: a salt is public by design, and
     * with no ciphertext left there is nothing for either to unlock. They are
     * kept because the passphrase verifier is derived from them, and deleting
     * them would lock the user out of confirming their own spends.
     */
    db.prepare(
      `UPDATE users
       SET encrypted_payment_key = NULL, payment_key_iv = NULL, migration_state = 'complete'
       WHERE id = ?`,
    ).run(user.id)

    res.json({ ok: true })
  }),
)

/* ------------------------------------------------------------ old balance */

/**
 * What the old address holds on one chain, for the browser's sweep.
 *
 * The sweep itself is signed in the browser with the old key, so this only
 * answers the question of how much to move.
 */
router.get(
  '/old-balance',
  requireAuth,
  asyncRoute(async (req, res) => {
    const row = findUserById(currentUser(req).id)
    if (!row?.eoa_address) throw httpError(404, 'No agent wallet for this account')

    const chain = String(req.query['chain'] ?? '') as SupportedChainName
    const config = chainConfig(chain)
    const client = createPublicClient({ chain: config.chain, transport: http(rpcUrlFor(chain)) })

    try {
      const [usdc, native] = await Promise.all([
        client.readContract({
          address: config.usdc,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [row.eoa_address as `0x${string}`],
        }),
        client.getBalance({ address: row.eoa_address as `0x${string}` }),
      ])
      res.json({
        chain,
        usdc: fromAtomicUsdc(usdc),
        usdcAtomic: usdc.toString(),
        nativeWei: native.toString(),
        usdcAddress: config.usdc,
        chainId: config.chain.id,
        rpcUrl: rpcUrlFor(chain),
        newAddress: row.circle_wallet_address,
      })
    } catch (err) {
      throw httpError(502, `Could not read the old balance: ${safeErrorMessage(err)}`)
    }
  }),
)

export default router
