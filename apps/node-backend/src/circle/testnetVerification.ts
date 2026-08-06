import { createPublicClient, createWalletClient, erc20Abi, http, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { SupportedChainName } from '@circle-fin/x402-batching/client'
import { chainConfig, rpcUrlFor, safeErrorMessage } from './gatewayService.ts'
import { isValidPrivateKey } from '../auth/keySetup.ts'
import { optional } from '../env.ts'

/**
 * Verification payment for free public APIs.
 *
 * Free APIs are ordinary HTTP endpoints — they do not implement x402, so there
 * is nobody to pay and `GatewayClient.pay()` has nothing to negotiate with.
 * Rather than letting them bypass the payment path entirely, every free call is
 * metered by a real Arc Testnet USDC transfer first.
 *
 * That keeps one execution model: a step only runs after value moves on chain,
 * every call leaves a verifiable receipt, and a wallet with no testnet funds
 * cannot call anything. It exercises the whole pipeline on faucet money before
 * a user ever enables mainnet.
 */

/** 1 atomic unit of USDC — the smallest representable amount at 6 decimals. */
export const VERIFICATION_AMOUNT_USDC = 0.000001
const USDC_DECIMALS = 6

/** Free APIs are always metered on Arc Testnet, never on a mainnet chain. */
export const VERIFICATION_CHAIN: SupportedChainName = 'arcTestnet'

/**
 * Where the metering payment goes. Defaults to the agent's own address, so the
 * transfer is a real on-chain transaction that proves funds and produces a
 * receipt without taking anything from the user. Set a treasury address to
 * charge for free-API access instead.
 */
const SINK_ADDRESS = optional('VERIFICATION_SINK_ADDRESS')

export interface VerificationReceipt {
  txHash: string
  amountUsdc: number
  chain: SupportedChainName
  to: string
}

/**
 * Move one atomic unit of USDC on Arc Testnet and return the receipt.
 *
 * Throws when the wallet cannot pay — which is the point: it is the gate that
 * stops an unfunded wallet from calling free APIs.
 */
export async function payVerification(
  agentPrivateKey: string,
): Promise<VerificationReceipt> {
  if (!isValidPrivateKey(agentPrivateKey)) {
    throw new Error('agentPrivateKey must be a 0x-prefixed 32-byte hex string')
  }

  const config = chainConfig(VERIFICATION_CHAIN)
  const account = privateKeyToAccount(agentPrivateKey)
  const to = (SINK_ADDRESS || account.address) as `0x${string}`

  const transport = http(rpcUrlFor(VERIFICATION_CHAIN))
  const publicClient = createPublicClient({ chain: config.chain, transport })
  const walletClient = createWalletClient({ account, chain: config.chain, transport })

  try {
    const value = parseUnits(String(VERIFICATION_AMOUNT_USDC), USDC_DECIMALS)
    // Simulate first so an unfunded wallet fails before a transaction is signed.
    const { request } = await publicClient.simulateContract({
      account,
      address: config.usdc,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [to, value],
    })
    const txHash = await walletClient.writeContract(request)

    return {
      txHash,
      amountUsdc: VERIFICATION_AMOUNT_USDC,
      chain: VERIFICATION_CHAIN,
      to,
    }
  } catch (err) {
    throw new Error(`Testnet verification payment failed: ${safeErrorMessage(err)}`)
  }
}

export interface FreeApiResult {
  data: unknown
  status: number
}

/**
 * Call a free API over plain HTTP. Only reached after the verification payment
 * has settled, so an unpaid call is not possible.
 */
export async function callFreeApi(
  url: string,
  options: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number } = {},
): Promise<FreeApiResult> {
  const { method = 'GET', body, timeoutMs = 20_000 } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'TridentAgent/1.0',
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      ...(method === 'POST' && body !== undefined ? { body: JSON.stringify(body) } : {}),
    })

    const text = await res.text()
    if (!res.ok) {
      throw new Error(`Service returned ${res.status}: ${text.slice(0, 160)}`)
    }

    let data: unknown = text
    try {
      data = JSON.parse(text)
    } catch {
      // Some free endpoints return plain text; keep it rather than failing.
    }
    return { data, status: res.status }
  } finally {
    clearTimeout(timer)
  }
}
