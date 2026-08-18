import { randomUUID } from 'node:crypto'
import { createWalletClient, formatEther, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { SupportedChainName } from '@circle-fin/x402-batching/client'
import db from '../db.ts'
import { httpError } from '../http.ts'
import { chainConfig, nativeBalanceFor, safeErrorMessage, transportFor } from './gatewayService.ts'
import { dataSuffixOption } from './attribution.ts'
import { KEEPER_PRIVATE_KEY } from '../env.ts'

/**
 * Gas, sent by the keeper so a user never has to hold any.
 *
 * Agent wallets are Circle EOAs, so they pay for their own transactions. A user
 * who funds their wallet with USDC exactly as the deposit panel instructs still
 * cannot move it: the deposit is two transactions and there is nothing to pay
 * for them with. That is a state reached by following the instructions, and it
 * happened to a real wallet holding 0.87 USDC on Base.
 *
 * Circle's own answer to this is Gas Station, which is ERC-4337 and therefore
 * SCA-only; our wallets are EOAs because x402 settlement verifies a plain
 * EIP-712 signature and an SCA would need every facilitator in the catalog to
 * support ERC-1271. So the gas comes from the keeper instead, which already
 * pays for the destination-chain mint in a cross-chain settlement. Same actor,
 * same key, one more job.
 *
 * Only for chains listed below. Arc Testnet is deliberately absent: its faucet
 * hands out gas and USDC together, and a user has to visit it for the USDC
 * regardless, so sponsoring there would spend the keeper to save nobody a step.
 */

/**
 * When to top up, and by how much, in native currency.
 *
 * `floor` is the balance below which a wallet is considered unable to act, and
 * `grant` is what it receives. The grant is deliberately several transactions'
 * worth: topping up the exact cost of one would mean a keeper transaction
 * before every user transaction, doubling the on-chain traffic and the latency
 * of every deposit.
 *
 * Numbers are conservative rather than tuned. On Base a transaction costs a
 * fraction of a cent, so 0.00002 ETH covers many; on Polygon the native token
 * is cheap enough that 0.05 POL is the same order of generosity.
 */
const SPONSORED: Partial<Record<SupportedChainName, { floor: string; grant: string }>> = {
  base: { floor: '0.000005', grant: '0.00002' },
  polygon: { floor: '0.01', grant: '0.05' },
}

/**
 * How much a single address may be given in a day, and over what window.
 *
 * The cap is the control on the whole feature. Without it this is a funded key
 * that anyone with an account can make spend, and a caller looping the deposit
 * route would drain it. Expressed as a multiple of the grant so the two cannot
 * drift apart: three top-ups is far more than a legitimate day of use and
 * cheap enough that a stuck loop costs pennies before it stops.
 */
const GRANTS_PER_WINDOW = 3
const WINDOW_SECONDS = 24 * 60 * 60

/**
 * In-flight top-ups, so two concurrent requests do not both fund the same
 * wallet.
 *
 * The daily cap is the real backstop; this only stops the common case, which is
 * a user pressing deposit twice or a run and a manual deposit overlapping. A
 * lock in one process is not a distributed lock, and does not pretend to be.
 */
const inFlight = new Map<string, Promise<void>>()

export interface GasOutcome {
  /** Whether anything was sent. False when the wallet already had enough. */
  granted: boolean
  txHash?: string
  amount?: string
}

/**
 * Make sure this wallet can pay for the transaction about to be submitted.
 *
 * Silent when the wallet already has gas, which is the overwhelming majority of
 * calls: one balance read, no transaction. Never throws for a reason the user
 * did not cause — a keeper that is empty or a chain that is not sponsored ends
 * with the caller proceeding and Circle refusing on its own terms, which is the
 * behaviour that existed before this.
 */
export async function ensureGas(
  address: `0x${string}`,
  chain: SupportedChainName,
): Promise<GasOutcome> {
  const policy = SPONSORED[chain]
  if (!policy || !KEEPER_PRIVATE_KEY) return { granted: false }

  const key = `${chain}:${address.toLowerCase()}`
  const running = inFlight.get(key)
  if (running) {
    await running.catch(() => undefined)
    return { granted: false }
  }

  const work = topUp(address, chain, policy)
  inFlight.set(key, work.then(() => undefined))
  try {
    return await work
  } finally {
    inFlight.delete(key)
  }
}

async function topUp(
  address: `0x${string}`,
  chain: SupportedChainName,
  policy: { floor: string; grant: string },
): Promise<GasOutcome> {
  const balance = await nativeBalanceFor(chain, address)
  /*
   * An unreadable balance is not an empty one. Sending on a failed read would
   * hand out gas to wallets that already have it every time an RPC blinks.
   */
  if (balance === null || balance >= parseEther(policy.floor)) return { granted: false }

  if (grantsInWindow(address, chain) >= GRANTS_PER_WINDOW) {
    console.warn(
      '[trident] gas grant refused, daily cap reached:',
      JSON.stringify({ address, chain }),
    )
    return { granted: false }
  }

  const config = chainConfig(chain)
  /*
   * Built here rather than imported from cctpBridge, which would close a cycle:
   * circleWallets imports this module, and cctpBridge imports circleWallets.
   * Two lines of duplication against an import graph that resolves by accident.
   */
  const keeper = privateKeyToAccount(KEEPER_PRIVATE_KEY as `0x${string}`)
  const amount = parseEther(policy.grant)

  /*
   * Checked before sending rather than discovered by a revert: a keeper that
   * cannot cover the grant is an operator problem, and the log line is the only
   * place it will be noticed before deposits start failing.
   */
  const keeperBalance = await nativeBalanceFor(chain, keeper.address)
  if (keeperBalance !== null && keeperBalance < amount) {
    console.error(
      '[trident] keeper cannot sponsor gas, top it up:',
      JSON.stringify({
        chain,
        keeper: keeper.address,
        has: formatEther(keeperBalance),
        needs: policy.grant,
        symbol: config.chain.nativeCurrency.symbol,
      }),
    )
    return { granted: false }
  }

  try {
    const wallet = createWalletClient({
      account: keeper,
      chain: config.chain,
      transport: transportFor(chain),
      ...dataSuffixOption(),
    })
    const txHash = await wallet.sendTransaction({ to: address, value: amount })

    /*
     * Recorded before waiting for the receipt. The cap has to count what was
     * sent, not what was confirmed: a crash between the two would otherwise
     * leave a grant uncounted and the ceiling meaningless.
     */
    db.prepare(
      'INSERT INTO gas_grants (id, address, chain, amount_wei, tx_hash) VALUES (?, ?, ?, ?, ?)',
    ).run(randomUUID(), address.toLowerCase(), chain, amount.toString(), txHash)

    console.warn(
      '[trident] gas granted:',
      JSON.stringify({ address, chain, amount: policy.grant, txHash }),
    )
    return { granted: true, txHash, amount: policy.grant }
  } catch (err) {
    /*
     * Never fatal. The caller was about to submit a transaction that may well
     * succeed on the balance already there, and Circle's own refusal says more
     * about why than this could.
     */
    console.error('[trident] gas grant failed:', safeErrorMessage(err))
    return { granted: false }
  }
}

/** Grants to this address on this chain inside the rolling window. */
function grantsInWindow(address: string, chain: SupportedChainName): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM gas_grants
       WHERE address = ? AND chain = ? AND created_at > strftime('%s','now') - ?`,
    )
    .get(address.toLowerCase(), chain, WINDOW_SECONDS) as { n: number }
  return row.n
}

/** The configured policy for a chain, for tests and for the status surface. */
export function sponsorshipFor(chain: SupportedChainName): { floor: string; grant: string } | null {
  return SPONSORED[chain] ?? null
}

/** Exposed so a test can assert the cap without reaching for the constant twice. */
export const GAS_GRANT_LIMIT = { perWindow: GRANTS_PER_WINDOW, windowSeconds: WINDOW_SECONDS }

/** Refuse a deposit clearly when nothing can be done about the gas. */
export function gasRefusal(chain: SupportedChainName, address: string): Error {
  const symbol = chainConfig(chain).chain.nativeCurrency.symbol
  return httpError(
    400,
    `Your agent wallet holds no ${symbol} on ${chain} and the automatic top-up did not go ` +
      `through, so it cannot pay for this transaction. Send a small amount of ${symbol} to ` +
      `${address} on ${chain} and try again. Your USDC is untouched.`,
  )
}
