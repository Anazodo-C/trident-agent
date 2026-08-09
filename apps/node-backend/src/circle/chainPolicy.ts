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
 * Once it is on, though, the user's chosen chain says where they *fund*, not
 * where they can spend. Gateway holds one balance across every domain it
 * supports, so USDC deposited on Base settles a Polygon invoice without a
 * bridge — that is the product. Treating the funding chain as a spending
 * restriction threw away the whole point of paying through Gateway: BlockRun
 * publishes 138 endpoints, 124 of them Gateway-payable and 119 Polygon-only,
 * and every one was unreachable to a wallet funded on Base.
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
  { gatewayOnly = false }: ChooseChainOptions = {},
): ChainChoice | null {
  let permitted = options.filter((o) => policy.allowed.includes(o.chainKey))
  if (gatewayOnly) {
    // The marker, not the scheme label. `batch-settlement` is generic and
    // other implementations use it, which the SDK then refuses to pay.
    permitted = permitted.filter((o) => o.gatewayBatchable === true)
  }
  if (permitted.length === 0) return null

  const testnet = permitted.filter((o) => o.isTestnet)
  const pool = testnet.length > 0 ? testnet : permitted
  const best = pool.reduce((a, b) => (b.priceUsdc < a.priceUsdc ? b : a))

  return {
    chain: best.chainKey,
    network: best.network,
    priceUsdc: best.priceUsdc,
    isTestnet: best.isTestnet,
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

  return 'No settlement network this wallet supports.'
}

export { isTestnetChain }
