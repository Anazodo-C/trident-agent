import { Attribution } from 'ox/erc8021'
import { BUILDER_CODE } from '../env.ts'

/**
 * ERC-8021 transaction attribution, so Base can credit what this app does.
 *
 * A Builder Code is appended to the calldata of transactions we submit. It is a
 * suffix and nothing more: contracts execute normally and ignore it, and only
 * offchain indexers read it back out. That is what makes it safe to attach to a
 * transaction that moves real USDC — the instruction being executed does not
 * change, only the bytes trailing it.
 *
 * What this cannot cover, and it is the larger half: the x402 payments
 * themselves. Both rails only ever sign; the seller's facilitator broadcasts.
 * There is no transaction of ours to append to, and no field in @x402/core,
 * @x402/evm or @circle-fin/x402-batching that would carry a code to whoever
 * does broadcast. So the Dashboard sees Trident's funding and settlement
 * movements, not its per-call payments.
 */

/**
 * The suffix, or null when no code is configured.
 *
 * Built once. Null is a first-class state, not a failure: without a code every
 * transaction is byte-for-byte what it was before this existed, which is what
 * makes the whole feature safe to ship ahead of the code itself.
 */
export const BUILDER_DATA_SUFFIX: `0x${string}` | null = buildSuffix()

function buildSuffix(): `0x${string}` | null {
  const code = BUILDER_CODE.trim()
  if (!code) return null
  try {
    /*
     * Schema 0, the canonical registry: a bare code resolved against Base's own
     * registry, which is what a Builder Code is. Schema 2 exists for CBOR
     * payloads carrying wallet and service codes alongside the app's, and we
     * have only the one identity to declare.
     */
    return Attribution.toDataSuffix({ codes: [code] })
  } catch (err) {
    /*
     * A malformed code must not stop the process from starting. Attribution is
     * analytics; refusing to boot over it would trade a payments outage for a
     * missing dashboard row.
     */
    console.error('[trident] BUILDER_CODE is not a usable attribution code:', String(err))
    return null
  }
}

/** Spread into a viem client's options; empty when no code is configured. */
export function dataSuffixOption(): { dataSuffix?: `0x${string}` } {
  return BUILDER_DATA_SUFFIX ? { dataSuffix: BUILDER_DATA_SUFFIX } : {}
}
