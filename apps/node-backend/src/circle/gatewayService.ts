import { GatewayClient, CHAIN_CONFIGS } from '@circle-fin/x402-batching/client'
import { generatePrivateKey } from 'viem/accounts'
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
  // Mainnets. Their absence here was a live hazard: resolveChain fell back to
  // the testnet default, so a request to act on BASE silently acted on Arc
  // Testnet instead — including Gateway deposits of real USDC.
  BASE: 'base',
  ARC: 'arc',
}

/**
 * Lenient lookup, for the stored `default_chain` label where an unrecognised
 * value should not break a page. Falls back to the testnet default.
 *
 * Never use this for a chain the caller asked for — see strictChain.
 */
export function resolveChain(label?: string | null): SupportedChainName {
  if (!label) return DEFAULT_CHAIN
  return CHAIN_LABELS[label.toUpperCase()] ?? DEFAULT_CHAIN
}

/**
 * Resolve a caller-supplied chain, or refuse.
 *
 * Accepts either the SDK key ("base") or the label form ("BASE"). Unknown
 * input is an error, never a fallback: quietly substituting a different chain
 * than the one asked for is how money ends up on the wrong network.
 */
export function strictChain(input: string): SupportedChainName {
  const raw = input.trim()
  if (raw in CHAIN_CONFIGS) return raw as SupportedChainName

  const mapped = CHAIN_LABELS[raw.toUpperCase()]
  if (mapped) return mapped

  throw httpError(400, `Unknown chain: ${input}`)
}

/**
 * SDK chain key -> the label form used by the bridge options and stored on
 * users.default_chain. The two forms coexist, and comparing one against the
 * other silently fails, so conversions go through here rather than by hand.
 */
export function chainLabel(chain: SupportedChainName): string {
  const found = Object.entries(CHAIN_LABELS).find(([, key]) => key === chain)
  return found?.[0] ?? chain
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
 * A signer used only to construct a client for reads.
 *
 * GatewayClient requires a private key to exist, but `getBalances(address)`
 * queries whatever address it is given — verified against a direct on-chain
 * read, where an unrelated signer returned the queried address's true balance.
 * So reading a Gateway balance needs no access to the user's wallet, and
 * demanding their passphrase to see their own balance was a self-imposed lock.
 *
 * Generated once per process, never used to sign, never funded.
 */
let readOnlySigner: `0x${string}` | null = null

/** A client for reads only. Never pass this anywhere that signs or spends. */
export function readOnlyGatewayClient(chain: SupportedChainName = DEFAULT_CHAIN): GatewayClient {
  readOnlySigner ??= generatePrivateKey()
  return new GatewayClient({ chain, privateKey: readOnlySigner, rpcUrl: rpcUrlFor(chain) })
}

/**
 * SDK errors can embed request context. Scrub any 32-byte hex run before an
 * error message is logged or returned, so a key can never leak through a stack.
 */
export function scrubSecrets(message: string): string {
  return message.replace(/0x[0-9a-fA-F]{64}/g, '0x<redacted>')
}

/**
 * Last error body seen per URL, so a failure can say what the endpoint said.
 *
 * The SDK builds its error as `Payment failed: ${error.error}` — a template
 * literal — so when an endpoint returns a structured error object it arrives
 * as the string "[object Object]" and the detail is gone before we can catch
 * it. The only place it still exists is the HTTP response, so it is recorded
 * as it goes past.
 *
 * Installed once and never removed: restoring a patched global around each
 * call would race with any concurrent run. Bounded so it cannot grow.
 */
const lastErrorBodies = new Map<string, string>()
const MAX_TRACKED_BODIES = 50

const originalFetch = globalThis.fetch
globalThis.fetch = async function trackingFetch(input, init) {
  const response = await originalFetch(input, init)
  if (!response.ok) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    // Read from a clone so the caller still gets an unconsumed body.
    void response
      .clone()
      .text()
      .then((text) => {
        if (!text) return
        if (lastErrorBodies.size >= MAX_TRACKED_BODIES) {
          lastErrorBodies.delete(lastErrorBodies.keys().next().value as string)
        }
        lastErrorBodies.set(url, text.slice(0, 400))
      })
      .catch(() => undefined)
  }
  return response
}

/** What the endpoint actually returned, when the SDK flattened it away. */
export function lastErrorBodyFor(url: string): string | null {
  return lastErrorBodies.get(url) ?? null
}

export function safeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)

  /*
   * SDK errors sometimes carry the real detail in a nested object, and
   * String() renders that as "[object Object]" — which is what a Goldsky
   * failure looked like in the logs, saying nothing at all. Serialise the
   * payload instead, and keep any Error message alongside it.
   */
  const detail = objectDetail(err)
  const combined = detail && !raw.includes(detail) ? `${raw} ${detail}` : raw

  return scrubSecrets(combined).slice(0, 600)
}

/** JSON for the parts of a thrown value that String() would flatten away. */
function objectDetail(err: unknown): string {
  const candidates = [
    (err as { cause?: unknown })?.cause,
    (err as { response?: unknown })?.response,
    (err as { data?: unknown })?.data,
    (err as { body?: unknown })?.body,
    err instanceof Error ? null : err,
  ]
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    try {
      const json = JSON.stringify(candidate)
      if (json && json !== '{}') return json
    } catch {
      /* circular or unserialisable — try the next candidate */
    }
  }
  return ''
}

export { CHAIN_CONFIGS }
export type { SupportedChainName }
