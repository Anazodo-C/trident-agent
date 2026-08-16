import { GatewayClient, CHAIN_CONFIGS } from '@circle-fin/x402-batching/client'
import { generatePrivateKey } from 'viem/accounts'
import { createPublicClient, fallback, http, erc20Abi, type Transport } from 'viem'
import type { SupportedChainName } from '@circle-fin/x402-batching/client'
import { httpError } from '../http.ts'
import { rpcOverridesFor } from '../env.ts'

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
/**
 * A transport that survives one endpoint throttling.
 *
 * viem's `fallback` moves to the next URL when a request errors, which is what
 * a public RPC does under load rather than failing outright. A wallet page fans
 * out balance reads across every supported chain at once, and the free Base
 * endpoint answers that with rate limits; a single-URL transport turns that
 * into "balance unavailable" and a user reasonably concludes their funds are
 * gone.
 *
 * Configured endpoints come first, then the chain's public default, so this is
 * never worse than what it replaced.
 */
export function transportFor(chain: SupportedChainName = DEFAULT_CHAIN): Transport {
  const urls = [...rpcOverridesFor(chain), rpcUrlFor(chain)]
  const unique = [...new Set(urls)]
  return fallback(
    unique.map((url) => http(url)),
    // Retries are handled per URL before moving on, so a blip does not burn a
    // whole endpoint out of the rotation.
    { rank: false, retryCount: 1 },
  )
}

export function rpcUrlFor(chain: SupportedChainName = DEFAULT_CHAIN): string {
  const config = chainConfig(chain)
  const url = config.rpcUrl ?? config.chain.rpcUrls.default.http[0]
  if (!url) throw httpError(500, `No RPC URL configured for chain ${chain}`)
  return url
}

/*
 * `gatewayClientFor` lived here and is gone.
 *
 * It was the last constructor in the backend that took a user's private key,
 * and it existed only because GatewayClient demands one. Deposits, withdrawals
 * and payments all go through the Circle wallet now, so nothing needs it, and
 * leaving a key-accepting factory in place would be an open door to a room we
 * no longer keep anything in. `readOnlyGatewayClient` below is unaffected: it
 * invents a throwaway key purely to satisfy the constructor for reads.
 */


export interface LiveQuote {
  /** Exactly what the endpoint asks for, in USDC atomic units. */
  amountAtomic: bigint
  /** The same figure as a decimal string. Never rounded — this is what is paid. */
  amountUsdc: string
  network: string
}

/**
 * What this call costs right now, from the endpoint itself.
 *
 * The catalog price is a snapshot and some sellers do not price statically:
 * BlockRun lists 0.003 for chat completions and quoted 0.027982 for
 * openai/gpt-5.5 — nearly ten times the figure the plan was approved at. The
 * spending cap is meant to be absolute, and a cap tested against a stale number
 * is not a cap at all.
 *
 * This is the unpaid half of the x402 handshake, which the SDK performs again
 * inside pay(). One extra round trip buys the guarantee that nothing is ever
 * charged above what the user approved.
 *
 * Null means the endpoint did not answer 402 — no quote to enforce against, so
 * the caller proceeds and lets pay() surface whatever the real problem is.
 */
export async function quoteFromEndpoint(
  url: string,
  chain: SupportedChainName,
  init: { method: 'GET' | 'POST'; body?: unknown },
  { timeoutMs = 20_000 }: { timeoutMs?: number } = {},
): Promise<LiveQuote | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: init.method,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    })
    if (response.status !== 402) return null

    const header = response.headers.get('payment-required')
    if (!header) return null

    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf-8')) as {
      accepts?: { network?: string; amount?: string; extra?: Record<string, unknown> }[]
    }

    // The same option pay() will choose: our chain, and Gateway-settleable.
    const expected = `eip155:${chainConfig(chain).chain.id}`
    const option = decoded.accepts?.find(
      (a) =>
        a.network === expected &&
        a.extra?.['name'] === 'GatewayWalletBatched' &&
        a.extra?.['version'] === '1',
    )
    if (!option?.amount) return null

    const amountAtomic = BigInt(option.amount)
    return { amountAtomic, amountUsdc: fromAtomicUsdc(amountAtomic), network: expected }
  } catch {
    // A quote is an optimisation on top of pay(), never a new way to fail.
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Plain ERC-20 USDC held by an address on each chain.
 *
 * Distinct from the Gateway ledger and spent by different things: the vanilla
 * x402 rail signs against the token contract, and the CCTP burn pulls from the
 * caller. Neither can touch a Gateway deposit, and Gateway payments cannot
 * touch this.
 *
 * One chain failing must not blank the rest — an RPC hiccup on a chain the user
 * has never used should not make the chain they are paying on look unfunded.
 */
export async function walletUsdcByChain(
  address: string,
  chains: SupportedChainName[],
): Promise<Map<SupportedChainName, number>> {
  const results = await Promise.allSettled(
    chains.map(async (chain) => {
      const config = CHAIN_CONFIGS[chain]
      if (!config?.usdc) return [chain, 0] as const
      const client = createPublicClient({
        chain: config.chain,
        transport: transportFor(chain),
      })
      const raw = await client.readContract({
        address: config.usdc,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address as `0x${string}`],
      })
      return [chain, Number(fromAtomicUsdc(raw))] as const
    }),
  )

  const byChain = new Map<SupportedChainName, number>()
  for (const result of results) {
    if (result.status === 'fulfilled') byChain.set(result.value[0], result.value[1])
  }
  return byChain
}

const GATEWAY_API_MAINNET = 'https://gateway-api.circle.com/v1'
const GATEWAY_API_TESTNET = 'https://gateway-api-testnet.circle.com/v1'

export interface UnifiedBalance {
  /** Total spendable across every queried domain, as a decimal USDC string. */
  totalUsdc: string
  /** Per-chain breakdown, so the wallet can show where the funds actually sit. */
  byChain: { chain: SupportedChainName; usdc: string }[]
}

/**
 * The Gateway balance across every domain at once.
 *
 * `GatewayClient.getBalances()` cannot answer this. It posts a single source —
 * `[{ depositor, domain: this.chainConfig.domain }]` — and reads `balances[0]`,
 * so it only ever reports the deposit sitting on the chain the client happens
 * to be pointed at. That is the wrong number for a product built on Gateway:
 * the whole point is that a deposit on Base is spendable on Polygon, so a
 * "Polygon balance" of zero next to a working Polygon payment is not a
 * discrepancy to explain, it is the SDK reading one row of several.
 *
 * The underlying API takes a list. This asks it the question the SDK does not.
 */
export async function unifiedGatewayBalance(
  address: string,
  chains: SupportedChainName[],
  { timeoutMs = 12_000 }: { timeoutMs?: number } = {},
): Promise<UnifiedBalance> {
  const queried = chains.filter((chain) => CHAIN_CONFIGS[chain])
  if (queried.length === 0) return { totalUsdc: '0', byChain: [] }

  // Testnet and mainnet are separate deployments with separate ledgers, so a
  // single call cannot span both. Callers pass one side or the other.
  const isTestnet = queried.every((chain) => CHAIN_CONFIGS[chain].chain.testnet === true)
  const base = isTestnet ? GATEWAY_API_TESTNET : GATEWAY_API_MAINNET

  const byDomain = new Map<number, SupportedChainName>()
  for (const chain of queried) byDomain.set(CHAIN_CONFIGS[chain].domain, chain)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${base}/balances`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        token: 'USDC',
        sources: [...byDomain.keys()].map((domain) => ({ depositor: address, domain })),
      }),
    })

    const payload = (await response.json()) as {
      balances?: { domain: number; balance: string }[]
      message?: string
    }
    if (!response.ok) {
      throw new Error(payload.message ?? `Gateway balance request failed (${response.status})`)
    }

    // Summed in atomic units. Adding decimal strings as floats is how a balance
    // acquires a rounding error, and this figure gates spending.
    let totalAtomic = 0n
    const byChain: { chain: SupportedChainName; usdc: string }[] = []
    for (const entry of payload.balances ?? []) {
      const chain = byDomain.get(entry.domain)
      if (!chain) continue
      totalAtomic += toAtomicUsdc(entry.balance)
      byChain.push({ chain, usdc: entry.balance })
    }

    return { totalUsdc: fromAtomicUsdc(totalAtomic), byChain }
  } finally {
    clearTimeout(timer)
  }
}

/** Parse a decimal USDC string to 6-decimal atomic units, without floats. */
export function toAtomicUsdc(value: string): bigint {
  const [whole = '0', fraction = ''] = value.trim().split('.')
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6))
}

export function fromAtomicUsdc(atomic: bigint): string {
  const whole = atomic / 1_000_000n
  const fraction = (atomic % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

/**
 * One mainnet number: plain wallet USDC on every chain, plus the Gateway ledger
 * across every domain.
 *
 * Summed in atomic units, never in floats. Adding "0.1" and "0.2" as numbers
 * yields 0.30000000000000004, and a balance that renders a cent off is a
 * balance nobody trusts.
 *
 * The invariant this exists to hold: moving funds between the two pots must not
 * change the total. A Gateway deposit takes X off the wallet side and puts X on
 * the Gateway side, so a user watching this figure sees it sit still while the
 * agent works, which is the whole point of showing one number.
 *
 * A failed Gateway read nulls `spendable` but not `walletAcrossChains`: half a
 * picture is still worth showing, a wrong total is not.
 */
export function spendableTotalUsdc(
  walletByChain: Map<string, string | number> | null,
  gatewaySpendableUsdc: string | null,
): { walletAcrossChains: string; spendable: string | null } | null {
  if (!walletByChain) return null
  let walletAtomic = 0n
  for (const amount of walletByChain.values()) walletAtomic += toAtomicUsdc(String(amount))
  return {
    walletAcrossChains: fromAtomicUsdc(walletAtomic),
    spendable:
      gatewaySpendableUsdc === null
        ? null
        : fromAtomicUsdc(walletAtomic + toAtomicUsdc(gatewaySpendableUsdc)),
  }
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
