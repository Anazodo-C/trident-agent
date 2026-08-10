import { CHAIN_CONFIGS } from '@circle-fin/x402-batching/client'
import type { SupportedChainName } from '@circle-fin/x402-batching/client'
import type { UserRow } from '../db.ts'
import { isTestnetChain } from './registryService.ts'

/**
 * Which chains a given user is allowed to spend on.
 *
 * Mainnet is opt-in and off by default. Until a user turns it on, the agent can
 * only settle with testnet funds, so no goal can cost real money by accident —
 * which matters because the agent spends autonomously once a plan is approved.
 *
 * Once it is on, though, the user's chosen chain is not a spending allowlist —
 * every Gateway mainnet domain is permitted, and the per-service choice is made
 * from what that service accepts. BlockRun publishes 138 endpoints, 124 of them
 * Gateway-payable and 119 Polygon-only, and treating "funded on Base" as
 * "may only spend on Base" made all of them unreachable.
 *
 * Permitted is not the same as payable. Settlement draws from the chain the
 * invoice names, so the balance has to be there too — see fundedFor, which is
 * the check that turns a permitted chain into a usable one.
 */

/** Label used in the users table and the API. */
export type ChainLabel = 'ARC-TESTNET' | 'BASE' | 'ARC'

export const CHAIN_LABEL_TO_KEY: Record<ChainLabel, SupportedChainName> = {
  'ARC-TESTNET': 'arcTestnet',
  BASE: 'base',
  // Arc mainnet — usable once it is live and an RPC URL is configured.
  ARC: 'arc',
}

/**
 * Every mainnet chain Gateway settles on and this process can reach.
 *
 * Read from the SDK rather than listed here, so a chain Circle adds is
 * available without a code change. Arc mainnet is excluded for the moment: it
 * ships no RPC URL, and constructing a client for it throws.
 */
export const GATEWAY_MAINNET_CHAINS: SupportedChainName[] = (
  Object.keys(CHAIN_CONFIGS) as SupportedChainName[]
).filter((chain) => {
  if (isTestnetChain(chain)) return false
  const config = CHAIN_CONFIGS[chain]
  return Boolean(config.rpcUrl ?? config.chain?.rpcUrls?.default?.http?.[0])
})

export interface ChainPolicy {
  /** Every chain this user may settle on. */
  allowed: SupportedChainName[]
  /** Testnet chain used for verification and the default demo path. */
  testnet: SupportedChainName
  /**
   * Where mainnet USDC is deposited and withdrawn, only set once the user has
   * opted in. Deliberately NOT a limit on settlement — see `allowed`.
   */
  fundingChain: SupportedChainName | null
  mainnetEnabled: boolean
}

export function policyFor(user: Pick<UserRow, 'default_chain' | 'mainnet_enabled' | 'mainnet_chain'>): ChainPolicy {
  const testnet = CHAIN_LABEL_TO_KEY[(user.default_chain as ChainLabel) ?? 'ARC-TESTNET'] ?? 'arcTestnet'
  const mainnetEnabled = user.mainnet_enabled === 1
  const fundingChain = mainnetEnabled
    ? (CHAIN_LABEL_TO_KEY[(user.mainnet_chain as ChainLabel) ?? 'BASE'] ?? 'base')
    : null

  /*
   * Opting into mainnet opts into all of Gateway's mainnet domains, not one.
   * The consent that matters is "may this agent spend real money" — which chain
   * the invoice happens to name is an implementation detail of the seller, and
   * the funds are drawn from the same balance either way.
   */
  const allowed: SupportedChainName[] = [testnet]
  if (mainnetEnabled) {
    for (const chain of GATEWAY_MAINNET_CHAINS) {
      if (!allowed.includes(chain)) allowed.push(chain)
    }
  }

  return { allowed, testnet, fundingChain, mainnetEnabled }
}

export interface ChainChoice {
  chain: SupportedChainName
  network: string
  priceUsdc: number
  isTestnet: boolean
  /** Which rail to pay on. The runner routes on this. */
  rail: 'gateway' | 'vanilla' | 'verification'
}

export interface ServiceNetworkLike {
  network: string
  chainKey: SupportedChainName
  isTestnet: boolean
  priceUsdc: number
  /** x402 settlement scheme. */
  scheme?: string
  /** True only when Circle Gateway can settle this option. */
  gatewayBatchable?: boolean
  /** Which rail settles it, and therefore which balance pays. */
  rail?: 'gateway' | 'vanilla' | 'verification'
}

/**
 * The only scheme GatewayClient.pay() can settle.
 *
 * A service can advertise a chain and a price and still be unpayable: Gateway
 * settles batched authorisations, and an endpoint without the batching marker
 * has no option for the client to use. Choosing without checking is how a run
 * reaches "No Gateway batching option available" after the user has already
 * approved it.
 *
 * Note this is the scheme *label*, which is not what the check keys on —
 * Circle's listings all read `exact` and carry the marker in `extra`. See
 * `gatewayBatchable`.
 */
export const GATEWAY_SCHEME = 'batch-settlement'

export interface ChooseChainOptions {
  /**
   * Require an option Gateway can settle. True for x402 services, which the
   * runner pays through Gateway. False for free services, which are metered by
   * a direct transfer and carry the `verification` scheme instead.
   */
  gatewayOnly?: boolean
  /**
   * Gateway ledger balance per mainnet chain, in USDC. Omit to skip the check.
   *
   * Settlement draws from the chain the invoice names, and nowhere else. A
   * balance on the wrong chain is not spendable here — see fundedFor.
   */
  balances?: Map<SupportedChainName, number>
  /**
   * Plain ERC-20 USDC held by the EOA per chain, which is what the vanilla rail
   * spends. Tracked separately because the two are genuinely different pots: a
   * wallet can hold Gateway balance on Base and no wallet USDC there, or the
   * reverse, and each pays only its own rail.
   */
  walletBalances?: Map<SupportedChainName, number>
}

/**
 * Whether a settlement option can actually be paid from what is on hand.
 *
 * Gateway pools deposits for its own transfers, but an x402 batched payment is
 * not one of those. The buyer signs a TransferWithAuthorization against the
 * GatewayWallet contract deployed on the chain the invoice names, and that
 * contract can only draw the depositor's balance on that same chain. Circle's
 * "balance can live on any supported blockchain" describes the burn-intent
 * transfer API, not a seller redeeming a per-chain authorisation.
 *
 * Observed, not inferred: with 0.063 USDC on Base and nothing on Polygon, a
 * 0.027983 invoice on Polygon came back SETTLEMENT_FAILED, debug
 * "insufficient_balance".
 *
 * Testnet options are exempt. They settle through the verification transfer
 * rather than Gateway, and that path is already working.
 */
function fundedFor(option: ServiceNetworkLike, opts: ChooseChainOptions): boolean {
  if (option.isTestnet) return true

  // The vanilla rail spends the EOA's own USDC, not the Gateway ledger, so it
  // must be measured against the wallet balance or it would be judged unfunded
  // on a chain where it can pay perfectly well.
  const pot = option.rail === 'vanilla' ? opts.walletBalances : opts.balances
  if (!pot) return true
  return (pot.get(option.chainKey) ?? 0) >= option.priceUsdc
}

/**
 * Pick the chain to pay a service on, given what the user is allowed to use.
 *
 * Testnet is preferred when available so a verification run never touches real
 * funds; otherwise the cheapest permitted mainnet option wins.
 */
export function chooseChain(
  options: ServiceNetworkLike[],
  policy: ChainPolicy,
  { gatewayOnly = false, balances, walletBalances }: ChooseChainOptions = {},
): ChainChoice | null {
  let permitted = options.filter((o) => policy.allowed.includes(o.chainKey))
  if (gatewayOnly) {
    /*
     * "Payable on some rail", not "payable through Gateway".
     *
     * This used to keep only options carrying Circle's batching marker, which
     * was correct while Gateway was the only rail. Applied now it would discard
     * every plain-x402 option and undo the point of ingesting them.
     */
    permitted = permitted.filter((o) => o.gatewayBatchable === true || o.rail === 'vanilla')
  }
  if (permitted.length === 0) return null

  const testnet = permitted.filter((o) => o.isTestnet)
  let pool = testnet.length > 0 ? testnet : permitted

  /*
   * Among mainnet options, only ones the wallet can actually settle on.
   *
   * Cheapest-wins alone sent a payment to whichever chain the seller priced
   * lowest, regardless of where the money was, and the rejection came back as
   * a generic settlement failure. A service listing both Base and Polygon is
   * payable today; one listing Polygon alone is not, and saying so up front
   * beats signing an authorisation that cannot clear.
   */
  const funded = pool.filter((o) => fundedFor(o, { gatewayOnly, balances, walletBalances }))
  if (funded.length === 0) return null
  pool = funded

  const best = pool.reduce((a, b) => (b.priceUsdc < a.priceUsdc ? b : a))

  return {
    chain: best.chainKey,
    network: best.network,
    priceUsdc: best.priceUsdc,
    isTestnet: best.isTestnet,
    rail: best.rail ?? (best.gatewayBatchable ? 'gateway' : 'vanilla'),
  }
}

/** Human-readable reason a service cannot be paid for under this policy. */
export function unpayableReason(
  options: ServiceNetworkLike[],
  policy: ChainPolicy,
  opts: ChooseChainOptions = {},
): string | null {
  if (chooseChain(options, policy, opts)) return null

  /*
   * Order matters. A service can have a permitted testnet option that simply
   * is not Gateway-batchable, and also list a mainnet one — reporting
   * "enable mainnet" there sends the user to flip a setting that would not
   * have helped. Check the batching case first, because it is the more
   * specific diagnosis.
   */
  if (opts.gatewayOnly && chooseChain(options, policy)) {
    return 'This service does not offer Gateway batch settlement, so the agent cannot pay it.'
  }

  if (!policy.mainnetEnabled && options.some((o) => !o.isTestnet)) {
    return 'This service settles on mainnet. Enable mainnet spending in Wallet to use it.'
  }

  /*
   * Distinguish "cannot be paid" from "cannot be paid from where the money
   * currently is". The second is the user's to fix in one deposit, and
   * reporting it as a settlement failure told them nothing.
   */
  if (opts.balances && chooseChain(options, policy, { ...opts, balances: undefined })) {
    const wanted = [...new Set(options.filter((o) => !o.isTestnet).map((o) => o.chainKey))]
    const held = [...opts.balances.entries()]
      .filter(([, amount]) => amount > 0)
      .map(([chain, amount]) => `${amount} USDC on ${chain}`)
    return (
      `This service settles on ${wanted.join(', ')}, and a Gateway payment can only draw from ` +
      `the chain it settles on. ${held.length ? `You hold ${held.join(', ')}.` : 'No Gateway balance was found.'} ` +
      `Deposit to ${wanted[0]} to use it.`
    )
  }

  return 'No settlement network this wallet supports.'
}

export { isTestnetChain }
