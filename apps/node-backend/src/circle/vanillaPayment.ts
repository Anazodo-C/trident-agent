import { randomBytes } from 'node:crypto'
import type { SupportedChainName } from '@circle-fin/x402-batching/client'
import { chainConfig, fromAtomicUsdc, safeErrorMessage } from './gatewayService.ts'
import { signTypedDataFor, type AgentWallet } from './circleWallets.ts'

/**
 * The second payment rail: plain x402, settled from the wallet's own USDC.
 *
 * Circle's marketplace lists 955 resources and only 689 can be paid through
 * Gateway. The other 233 advertise `supportsVanillax402` with no batching
 * marker, so the agent could see them and never buy from them. They are not a
 * lesser tier — AgentMail, Allium, Messari and StableTravel are all here — they
 * simply settle differently.
 *
 * What differs is only where the money sits and who submits the transaction.
 * A Gateway payment draws from the depositor's ledger inside the GatewayWallet
 * contract on the invoice's chain. A vanilla payment draws from the plain ERC-20
 * balance of the EOA. Both are gasless for us, because in both cases we only
 * sign and the seller's facilitator submits.
 *
 * Structurally the two are closer than they look: both sign the same EIP-3009
 * `TransferWithAuthorization`, and the only real difference is the EIP-712
 * domain, which each seller publishes in its `extra` block — Gateway names
 * `GatewayWalletBatched` and its own contract, vanilla names the USDC token
 * (`USD Coin` / `2`) and the asset address.
 *
 * Not built on `x402-fetch`. That package is the reference client, but 1.2.0 is
 * the newest release and it validates networks against x402 v1 names — it
 * rejects `eip155:8453` outright. Every seller in this catalog speaks v2 with
 * CAIP-2 identifiers, so the library cannot talk to any of them.
 */

/**
 * Whether the plain rail can pay on this chain.
 *
 * Broader than it once was. An earlier draft delegated to `x402-fetch`, whose
 * closed network list would have limited us to Base, Polygon and Avalanche;
 * signing the authorisation here instead means any EVM chain with a USDC
 * contract works, because EIP-3009 is the token's own interface.
 *
 * Solana listings never reach this — `chainForNetwork` does not map them, and
 * they would need an SVM signer this wallet is not.
 */
export function vanillaSupportsChain(chain: SupportedChainName): boolean {
  try {
    return Boolean(chainConfig(chain).usdc)
  } catch {
    return false
  }
}

/** EIP-3009, as USDC and GatewayWalletBatched both implement it. */
const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

/**
 * How long a signed authorisation stays usable.
 *
 * One hour. Sellers advertise `maxTimeoutSeconds` but at least one publishes an
 * absolute unix timestamp there rather than a duration, and taking that
 * literally would sign an authorisation valid for decades. A vanilla payment is
 * submitted by the facilitator straight away, so it does not need a long
 * window, and a short one bounds what a leaked signature could still do.
 */
const VALIDITY_WINDOW_SECONDS = 3600

/** Clock skew allowance, so a freshly signed authorisation is never "not yet valid". */
const BACKDATE_SECONDS = 600

interface AcceptsEntry {
  scheme?: string
  network?: string
  amount?: string
  asset?: string
  payTo?: string
  maxTimeoutSeconds?: number
  extra?: Record<string, unknown>
}

/** True when this option settles through Gateway rather than the plain rail. */
function isGatewayOption(accept: AcceptsEntry): boolean {
  return accept.extra?.['name'] === 'GatewayWalletBatched'
}

export interface VanillaPayResult {
  data: unknown
  /** Exactly what the seller charged, as a decimal USDC string. Never rounded. */
  amountUsdc: string
  /** Settlement transaction, when the facilitator reports one. */
  txHash: string | null
  network: string
}

/**
 * Pay an x402 resource from the wallet's ERC-20 USDC balance.
 *
 * `maxAtomic` is the ceiling the caller has already approved. It is checked
 * against the seller's live price before anything is signed, because these
 * prices are quoted per request and can move between planning and calling.
 */
export async function payVanilla(
  url: string,
  wallet: AgentWallet,
  chain: SupportedChainName,
  init: { method: 'GET' | 'POST'; body?: unknown },
  maxAtomic: bigint,
): Promise<VanillaPayResult> {
  const chainId = chainConfig(chain).chain.id
  const expectedNetwork = `eip155:${chainId}`

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  }
  const body = init.body !== undefined ? JSON.stringify(init.body) : undefined

  const unpaid = await fetch(url, { method: init.method, headers, ...(body ? { body } : {}) })

  // Already free, or already served. Nothing to pay.
  if (unpaid.status !== 402) {
    if (unpaid.ok) {
      return { data: await unpaid.json(), amountUsdc: '0', txHash: null, network: expectedNetwork }
    }
    const detail = await unpaid.text().catch(() => '')
    throw new Error(
      `Request failed with status ${unpaid.status}${detail ? ` — endpoint said: ${detail.slice(0, 300)}` : ''}`,
    )
  }

  const challengeHeader = unpaid.headers.get('payment-required')
  if (!challengeHeader) throw new Error('Missing PAYMENT-REQUIRED header in 402 response')

  const challenge = JSON.parse(Buffer.from(challengeHeader, 'base64').toString('utf-8')) as {
    x402Version?: number
    resource?: string
    accepts?: AcceptsEntry[]
  }

  const accepted = (challenge.accepts ?? []).find(
    (a) => a.network === expectedNetwork && a.scheme === 'exact' && !isGatewayOption(a),
  )
  if (!accepted?.amount || !accepted.payTo || !accepted.asset) {
    throw new Error(
      `This service does not offer plain x402 settlement on ${chain}. Nothing was charged.`,
    )
  }

  const amount = BigInt(accepted.amount)
  if (amount > maxAtomic) {
    throw new Error(
      `This call costs ${fromAtomicUsdc(amount)} USDC, above the ${fromAtomicUsdc(maxAtomic)} ` +
        `approved for it. Nothing was charged.`,
    )
  }

  /*
   * The signing domain comes from the seller, not from us.
   *
   * For USDC this is `{ name: "USD Coin", version: "2" }` against the token
   * contract itself — the same EIP-712 domain the token declares, which is what
   * makes the signature spendable by the facilitator.
   */
  const now = Math.floor(Date.now() / 1000)
  const authorization = {
    from: wallet.address,
    to: accepted.payTo as `0x${string}`,
    value: amount,
    validAfter: BigInt(now - BACKDATE_SECONDS),
    validBefore: BigInt(now + VALIDITY_WINDOW_SECONDS),
    nonce: `0x${randomBytes(32).toString('hex')}` as `0x${string}`,
  }

  /*
   * Circle signs this, not a key we hold. The payload is byte-for-byte what
   * viem used to sign, because the seller's facilitator verifies the signature
   * against the token's own EIP-712 domain and neither knows nor cares who
   * produced it. That is what made this migration possible without touching the
   * x402 protocol at all.
   */
  const signature = await signTypedDataFor(wallet, {
    domain: {
      name: String(accepted.extra?.['name'] ?? 'USD Coin'),
      version: String(accepted.extra?.['version'] ?? '2'),
      chainId,
      verifyingContract: String(accepted.extra?.['verifyingContract'] ?? accepted.asset),
    },
    types: AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: authorization,
  })

  // Same envelope the Gateway client sends, and the same header the v2 server
  // side reads: base64 JSON carrying the signed authorisation, the resource it
  // pays for, and which of the offered options was taken.
  const paymentHeader = Buffer.from(
    JSON.stringify({
      x402Version: challenge.x402Version ?? 2,
      payload: {
        authorization: {
          ...authorization,
          value: authorization.value.toString(),
          validAfter: authorization.validAfter.toString(),
          validBefore: authorization.validBefore.toString(),
        },
        signature,
      },
      resource: challenge.resource ?? url,
      accepted,
    }),
  ).toString('base64')

  let paid: Response
  try {
    paid = await fetch(url, {
      method: init.method,
      headers: { ...headers, 'Payment-Signature': paymentHeader },
      ...(body ? { body } : {}),
    })
  } catch (err) {
    throw new Error(`Payment failed: ${safeErrorMessage(err)}`)
  }

  if (!paid.ok) {
    const detail = await paid.text().catch(() => '')
    throw new Error(
      `Payment failed with status ${paid.status}${detail ? ` — endpoint said: ${detail.slice(0, 300)}` : ''}`,
    )
  }

  /*
   * What was actually charged, read back from the settlement rather than the
   * catalog. A seller that omits the receipt still served a paid request, so a
   * missing header reports the quoted amount rather than failing the call.
   */
  let amountUsdc = fromAtomicUsdc(amount)
  let txHash: string | null = null
  const receipt = paid.headers.get('payment-response')
  if (receipt) {
    try {
      const decoded = JSON.parse(Buffer.from(receipt, 'base64').toString('utf-8')) as {
        transaction?: string
        amount?: string
      }
      txHash = decoded.transaction ?? null
      if (decoded.amount) amountUsdc = fromAtomicUsdc(BigInt(decoded.amount))
    } catch {
      /* a malformed receipt is not a reason to discard a paid-for result */
    }
  }

  return { data: await paid.json(), amountUsdc, txHash, network: expectedNetwork }
}
