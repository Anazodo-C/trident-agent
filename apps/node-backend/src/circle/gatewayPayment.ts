import { BatchEvmScheme, type PayResult } from '@circle-fin/x402-batching/client'
import type { SupportedChainName } from '@circle-fin/x402-batching/client'
import { chainConfig, fromAtomicUsdc, safeErrorMessage } from './gatewayService.ts'
import { signTypedDataFor, type AgentWallet } from './circleWallets.ts'

/**
 * The Gateway rail, signed by Circle instead of by a key we hold.
 *
 * `GatewayClient` does this already and does it well, but its constructor takes
 * `privateKey: Hex` and builds a viem wallet client internally, with no way to
 * inject a signer. That single field is the reason this file exists: everything
 * else about the rail is unchanged.
 *
 * `pay()` returns the same `PayResult` the runner already destructures, so the
 * retry and method-recovery machinery around the call site keeps working
 * untouched. This is deliberately a drop-in, not an improvement.
 */

interface AcceptsEntry {
  scheme?: string
  network?: string
  amount?: string
  asset?: string
  payTo?: string
  maxTimeoutSeconds?: number
  extra?: Record<string, unknown>
}

/**
 * Whether this option is one the batch scheme can actually sign.
 *
 * All four conditions, exactly as the SDK tests them. An earlier version here
 * checked only the name, which would accept an option missing `version` or
 * `verifyingContract` and then hand it to the scheme, producing either a throw
 * deep in payload construction or a signature no facilitator honours. The
 * marker names the rail; the other two are what the signature is built from.
 */
function isPayableGatewayOption(accept: AcceptsEntry, expectedNetwork: string): boolean {
  const extra = accept.extra
  return (
    accept.network === expectedNetwork &&
    extra?.['name'] === 'GatewayWalletBatched' &&
    extra['version'] === '1' &&
    typeof extra['verifyingContract'] === 'string'
  )
}

export interface SupportsOutcome {
  supported: boolean
  requirements?: Record<string, unknown>
  error?: string
}

export class GatewayBatchPayer {
  readonly chain: SupportedChainName
  readonly address: `0x${string}`
  private readonly scheme: BatchEvmScheme

  constructor(wallet: AgentWallet, chain: SupportedChainName) {
    this.chain = chain
    this.address = wallet.address

    /*
     * The whole adapter. `BatchEvmSigner` only ever wanted an address and the
     * ability to produce an EIP-712 signature, which is why moving off a held
     * private key needed no change to the payment protocol at all.
     */
    this.scheme = new BatchEvmScheme({
      address: wallet.address,
      signTypedData: (params) => signTypedDataFor(wallet, params),
    })
  }

  /**
   * The unpaid probe: can this URL be settled through Gateway at all?
   *
   * The error strings are reproduced verbatim from the SDK, not paraphrased,
   * because the runner distinguishes a real "no" from an inconclusive one by
   * testing them against /gateway|batching/i. "Resource does not require
   * payment" matches neither and is treated as inconclusive, which is correct:
   * a POST endpoint probed without a body answers something other than 402 and
   * that says nothing about Gateway. Rewording either string would silently
   * turn a working endpoint into a blocked one, or the reverse.
   */
  async supports(url: string): Promise<SupportsOutcome> {
    try {
      const response = await fetch(url)
      if (response.status !== 402) {
        return { supported: false, error: 'Resource does not require payment (not 402)' }
      }
      const header = response.headers.get('PAYMENT-REQUIRED')
      if (!header) {
        return { supported: false, error: 'Missing PAYMENT-REQUIRED header in 402 response' }
      }
      const data = JSON.parse(Buffer.from(header, 'base64').toString('utf-8')) as {
        accepts?: AcceptsEntry[]
      }
      if (!data.accepts || data.accepts.length === 0) {
        return { supported: false, error: 'No payment options in 402 response' }
      }
      const config = chainConfig(this.chain)
      const expectedNetwork = `eip155:${config.chain.id}`
      const option = data.accepts.find((a) => isPayableGatewayOption(a, expectedNetwork))
      if (!option) {
        return {
          supported: false,
          error:
            `No Gateway batching option available for network ${expectedNetwork} ` +
            `(${config.chain.name})`,
        }
      }
      return { supported: true, requirements: option as Record<string, unknown> }
    } catch (err) {
      return { supported: false, error: safeErrorMessage(err) }
    }
  }

  /**
   * Run the full 402 flow: ask, read the challenge, sign the Gateway option,
   * ask again with the signature.
   */
  async pay<T = unknown>(
    url: string,
    options?: { method: 'POST'; body: Record<string, unknown> },
  ): Promise<PayResult<T>> {
    const method = options?.method ?? 'GET'
    const body = options?.body !== undefined ? JSON.stringify(options.body) : undefined
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    }

    const unpaid = await fetch(url, { method, headers, ...(body ? { body } : {}) })

    // Free, or already served. Nothing to sign.
    if (unpaid.status !== 402) {
      if (unpaid.ok) {
        return {
          data: (await unpaid.json()) as T,
          amount: 0n,
          formattedAmount: '0',
          transaction: '',
          status: unpaid.status,
        }
      }
      const detail = await unpaid.text().catch(() => '')
      throw new Error(
        `Request failed with status ${unpaid.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
      )
    }

    const challengeHeader = unpaid.headers.get('payment-required')
    if (!challengeHeader) throw new Error('Missing PAYMENT-REQUIRED header in 402 response')

    const challenge = JSON.parse(Buffer.from(challengeHeader, 'base64').toString('utf-8')) as {
      x402Version?: number
      resource?: string
      accepts?: AcceptsEntry[]
    }

    const expectedNetwork = `eip155:${chainConfig(this.chain).chain.id}`
    const accepted = (challenge.accepts ?? []).find((a) =>
      isPayableGatewayOption(a, expectedNetwork),
    )
    if (!accepted?.amount || !accepted.payTo || !accepted.asset) {
      throw new Error(
        `This service does not offer Gateway batch settlement on ${this.chain}. Nothing was charged.`,
      )
    }

    const x402Version = challenge.x402Version ?? 2
    const payload = await this.scheme.createPaymentPayload(x402Version, {
      scheme: 'exact',
      network: accepted.network ?? expectedNetwork,
      asset: accepted.asset,
      amount: accepted.amount,
      payTo: accepted.payTo,
      maxTimeoutSeconds: accepted.maxTimeoutSeconds ?? 60,
      ...(accepted.extra ? { extra: accepted.extra } : {}),
    })

    const paymentHeader = Buffer.from(
      JSON.stringify({ ...payload, resource: challenge.resource ?? url, accepted }),
    ).toString('base64')

    const paid = await fetch(url, {
      method,
      headers: { ...headers, 'Payment-Signature': paymentHeader },
      ...(body ? { body } : {}),
    })

    if (!paid.ok) {
      const detail = await paid.text().catch(() => '')
      throw new Error(
        `Payment failed with status ${paid.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
      )
    }

    /*
     * What was actually charged, read from the settlement receipt rather than
     * the catalog. A seller that omits the header still served a paid request,
     * so fall back to the quoted amount rather than failing a call that worked.
     */
    const quoted = BigInt(accepted.amount)
    let amount = quoted
    let transaction = ''
    const receipt = paid.headers.get('payment-response')
    if (receipt) {
      try {
        const decoded = JSON.parse(Buffer.from(receipt, 'base64').toString('utf-8')) as {
          transaction?: string
          amount?: string
        }
        if (decoded.transaction) transaction = decoded.transaction
        if (decoded.amount) amount = BigInt(decoded.amount)
      } catch {
        // A malformed receipt is the seller's bug, not a reason to fail a
        // request that was served. Keep the quoted amount.
      }
    }

    return {
      data: (await paid.json()) as T,
      amount,
      formattedAmount: fromAtomicUsdc(amount),
      transaction,
      status: paid.status,
    }
  }
}

/** Surface SDK errors through the same scrubber the rest of the module uses. */
export function payErrorMessage(err: unknown): string {
  return safeErrorMessage(err)
}
