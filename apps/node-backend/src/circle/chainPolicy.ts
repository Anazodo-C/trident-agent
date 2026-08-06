import type { SupportedChainName } from '@circle-fin/x402-batching/client'
import type { UserRow } from '../db.ts'
import { isTestnetChain } from './registryService.ts'

/**
 * Which chains a given user is allowed to spend on.
 *
 * Mainnet is opt-in and off by default. Until a user turns it on, the agent can
 * only settle with testnet funds, so no goal can cost real money by accident —
 * which matters because the agent spends autonomously once a plan is approved.
 */

/** Label used in the users table and the API. */
export type ChainLabel = 'ARC-TESTNET' | 'BASE' | 'ARC'

export const CHAIN_LABEL_TO_KEY: Record<ChainLabel, SupportedChainName> = {
  'ARC-TESTNET': 'arcTestnet',
  BASE: 'base',
  // Arc mainnet — usable once it is live and an RPC URL is configured.
  ARC: 'arc',
}

export interface ChainPolicy {
  /** Every chain this user may settle on. */
  allowed: SupportedChainName[]
  /** Testnet chain used for verification and the default demo path. */
  testnet: SupportedChainName
  /** Mainnet chain, only present when the user has opted in. */
  mainnet: SupportedChainName | null
  mainnetEnabled: boolean
}

export function policyFor(user: Pick<UserRow, 'default_chain' | 'mainnet_enabled' | 'mainnet_chain'>): ChainPolicy {
  const testnet = CHAIN_LABEL_TO_KEY[(user.default_chain as ChainLabel) ?? 'ARC-TESTNET'] ?? 'arcTestnet'
  const mainnetEnabled = user.mainnet_enabled === 1
  const mainnet = mainnetEnabled
    ? (CHAIN_LABEL_TO_KEY[(user.mainnet_chain as ChainLabel) ?? 'BASE'] ?? 'base')
    : null

  const allowed: SupportedChainName[] = [testnet]
  if (mainnet && !allowed.includes(mainnet)) allowed.push(mainnet)

  return { allowed, testnet, mainnet, mainnetEnabled }
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
): ChainChoice | null {
  const permitted = options.filter((o) => policy.allowed.includes(o.chainKey))
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
): string | null {
  if (chooseChain(options, policy)) return null
  if (!policy.mainnetEnabled && options.some((o) => !o.isTestnet)) {
    return 'This service settles on mainnet. Enable mainnet spending in Wallet to use it.'
  }
  return 'No settlement network this wallet supports.'
}

export { isTestnetChain }
