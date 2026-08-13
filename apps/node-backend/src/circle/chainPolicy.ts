import { CHAIN_CONFIGS } from '@circle-fin/x402-batching/client'
import type { SupportedChainName } from '@circle-fin/x402-batching/client'
import type { UserRow } from '../db.ts'
import { isTestnetChain } from './registryService.ts'
// Leaf module with no imports of ours, so this cannot create a cycle.
import { canBridgeTo } from './deployments.ts'

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
  /**
   * What has to happen before this can be paid, decided from the balances the
   * caller supplied. The runner follows it rather than re-deriving it.
   */
  route: FundingRoute
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
/**
 * How much work it takes to pay an option, or null when it cannot be paid.
 *
 * The rungs are ordered by cost to the user in fees and in waiting, and the
 * number is used only for that ordering.
 */
export type FundingRoute = 'ready' | 'deposit' | 'bridge' | 'withdraw-bridge'

const ROUTE_COST: Record<FundingRoute, number> = {
  ready: 0,
  // One transaction on the chain we are already paying on.
  deposit: 1,
  // A burn, an attestation and a mint: minutes, and a CCTP fee.
  bridge: 2,
  // The same, preceded by pulling the money out of Gateway first.
  'withdraw-bridge': 3,
}

/**
 * Can this option be paid at all, and at what cost.
 *
 * This used to ask whether one pot on one chain held the price, which is the
 * question settlement asks but not the question the user cares about. Money in
 * the wallet on Base pays a Polygon invoice perfectly well; it just has to
 * travel first. Reporting that as unfunded made a balance the user could see
 * look unusable, and pushed them to deposit again on a second chain.
 *
 * The vanilla rail is the exception and stays strict: it signs against the USDC
 * contract on the invoice's own chain, so only wallet funds already sitting
 * there can pay it. Nothing can be moved in to help.
 */
export function fundingRouteFor(
  option: ServiceNetworkLike,
  opts: ChooseChainOptions,
): FundingRoute | null {
  if (option.isTestnet) return 'ready'

  const price = option.priceUsdc
  const wallet = opts.walletBalances
  const gateway = opts.balances

  // No balance information at all means the caller is not gating on funds.
  if (!wallet && !gateway) return 'ready'

  const walletHere = wallet?.get(option.chainKey) ?? 0
  const gatewayHere = gateway?.get(option.chainKey) ?? 0

  if (option.rail === 'vanilla') {
    return walletHere >= price ? 'ready' : null
  }

  // Gateway rail from here down.
  if (gatewayHere >= price) return 'ready'
  if (walletHere >= price) return 'deposit'

  // Somewhere else entirely. Only chains the router and receiver are deployed
  // on can take delivery, so a balance on a chain we cannot bridge to or from
  // is not reachable however large it is.
  if (!canBridgeTo(option.chainKey)) return null

  const elsewhere = (pot: Map<SupportedChainName, number> | undefined) =>
    [...(pot?.entries() ?? [])].some(
      ([chain, held]) => chain !== option.chainKey && held >= price && canBridgeTo(chain),
    )

  if (elsewhere(wallet)) return 'bridge'
  if (elsewhere(gateway)) return 'withdraw-bridge'
  return null
}

function fundedFor(option: ServiceNetworkLike, opts: ChooseChainOptions): boolean {
  return fundingRouteFor(option, opts) !== null
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
  const routed = pool
    .map((o) => ({ option: o, route: fundingRouteFor(o, { gatewayOnly, balances, walletBalances }) }))
    .filter((r): r is { option: ServiceNetworkLike; route: FundingRoute } => r.route !== null)
  if (routed.length === 0) return null

  /*
   * Cheapest to reach first, cheapest to buy second.
   *
   * Price alone would pick a marginally cheaper option on a chain the money is
   * not on, and pay for that saving with a CCTP fee and several minutes of
   * bridging. A tenth of a cent is not worth a round trip, so an option that
   * can be paid right now beats one that has to be funded first, and price only
   * decides between options of equal effort.
   */
  const best = routed.reduce((a, b) => {
    const byRoute = ROUTE_COST[a.route] - ROUTE_COST[b.route]
    if (byRoute !== 0) return byRoute < 0 ? a : b
    return b.option.priceUsdc < a.option.priceUsdc ? b : a
  })

  return {
    chain: best.option.chainKey,
    network: best.option.network,
    priceUsdc: best.option.priceUsdc,
    isTestnet: best.option.isTestnet,
    rail: best.option.rail ?? (best.option.gatewayBatchable ? 'gateway' : 'vanilla'),
    route: best.route,
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
  /*
   * Vary only the batching requirement, holding the balances fixed.
   *
   * This used to call chooseChain with no options at all, which dropped the
   * funding check too, so any shortfall came back as "does not offer Gateway
   * batch settlement" and sent the user looking at the wrong thing entirely.
   * A diagnosis has to change one variable.
   */
  if (opts.gatewayOnly && chooseChain(options, policy, { ...opts, gatewayOnly: false })) {
    return 'This service does not offer Gateway batch settlement, so the agent cannot pay it.'
  }

  if (!policy.mainnetEnabled && options.some((o) => !o.isTestnet)) {
    return 'This service settles on mainnet. Enable mainnet spending in Wallet to use it.'
  }

  /*
   * Separate "not enough money" from "money that cannot get there".
   *
   * The agent now moves funds to whichever chain an invoice names, so the old
   * advice to deposit on a particular chain is no longer the fix and would send
   * the user to do something the agent does for them. What remains are two
   * genuinely different failures, and they need different sentences.
   */
  const gatingOnFunds = Boolean(opts.balances ?? opts.walletBalances)
  if (gatingOnFunds && chooseChain(options, policy, { ...opts, balances: undefined, walletBalances: undefined })) {
    const wanted = [...new Set(options.filter((o) => !o.isTestnet).map((o) => o.chainKey))]
    const total =
      [...(opts.balances?.values() ?? [])].reduce((a, b) => a + b, 0) +
      [...(opts.walletBalances?.values() ?? [])].reduce((a, b) => a + b, 0)
    const cheapest = Math.min(...options.filter((o) => !o.isTestnet).map((o) => o.priceUsdc))

    // Reachable chains are the ones the router and receiver are deployed on.
    // A service priced only on a chain we cannot deliver to is a coverage gap
    // on our side, not a shortfall on the user's, and should not read as one.
    if (!wanted.some((chain) => canBridgeTo(chain))) {
      return (
        `This service settles only on ${wanted.join(', ')}, which the agent cannot move funds ` +
        'to yet. Nothing was charged.'
      )
    }
    return (
      `This service costs ${cheapest} USDC and your balance is ${Number(total.toFixed(6))} USDC ` +
      'across every network. Add funds in Wallet to use it.'
    )
  }

  return 'No settlement network this wallet supports.'
}

export { isTestnetChain }
