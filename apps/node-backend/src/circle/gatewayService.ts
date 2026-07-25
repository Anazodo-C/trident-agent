import { GatewayClient, CHAIN_CONFIGS } from '@circle-fin/x402-batching/client'
import type { SupportedChainName } from '@circle-fin/x402-batching/client'
import { httpError } from '../http.ts'
import { isValidPrivateKey } from '../auth/keySetup.ts'

export const DEFAULT_CHAIN: SupportedChainName = 'arcTestnet'

/** Human label -> SDK chain key. `default_chain` on users stores the label form. */
export const CHAIN_LABELS: Record<string, SupportedChainName> = {
  'ARC-TESTNET': 'arcTestnet',
  'BASE-SEPOLIA': 'baseSepolia',
  'ETHEREUM-SEPOLIA': 'sepolia',
  'ARBITRUM-SEPOLIA': 'arbitrumSepolia',
  'AVALANCHE-FUJI': 'avalancheFuji',
  'OPTIMISM-SEPOLIA': 'optimismSepolia',
  'POLYGON-AMOY': 'polygonAmoy',
  'UNICHAIN-SEPOLIA': 'unichainSepolia',
}

export function resolveChain(label?: string | null): SupportedChainName {
  if (!label) return DEFAULT_CHAIN
  return CHAIN_LABELS[label.toUpperCase()] ?? DEFAULT_CHAIN
}

export function chainConfig(chain: SupportedChainName = DEFAULT_CHAIN) {
  const config = CHAIN_CONFIGS[chain]
  if (!config) throw httpError(400, `Unsupported chain: ${chain}`)
  return config
}

/** RPC URL for a chain, preferring the SDK's own configuration. */
export function rpcUrlFor(chain: SupportedChainName = DEFAULT_CHAIN): string {
  const config = chainConfig(chain)
  const url = config.rpcUrl ?? config.chain.rpcUrls.default.http[0]
  if (!url) throw httpError(500, `No RPC URL configured for chain ${chain}`)
  return url
}

/**
 * Build a GatewayClient for a user-supplied EOA key.
 *
 * The key is validated structurally first so a malformed value fails here with a
 * clean 400 rather than deep inside the SDK, where the message could echo it back.
 */
export function gatewayClientFor(
  agentPrivateKey: unknown,
  chain: SupportedChainName = DEFAULT_CHAIN,
): GatewayClient {
  if (!isValidPrivateKey(agentPrivateKey)) {
    throw httpError(400, 'agentPrivateKey must be a 0x-prefixed 32-byte hex string')
  }
  return new GatewayClient({
    chain,
    privateKey: agentPrivateKey,
    rpcUrl: rpcUrlFor(chain),
  })
}

/**
 * SDK errors can embed request context. Scrub any 32-byte hex run before an
 * error message is logged or returned, so a key can never leak through a stack.
 */
export function scrubSecrets(message: string): string {
  return message.replace(/0x[0-9a-fA-F]{64}/g, '0x<redacted>')
}

export function safeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return scrubSecrets(raw)
}

export { CHAIN_CONFIGS }
export type { SupportedChainName }
