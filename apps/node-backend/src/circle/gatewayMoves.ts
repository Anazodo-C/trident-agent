import { randomBytes } from 'node:crypto'
import { maxUint256, pad, zeroAddress } from 'viem'
import type { SupportedChainName } from '@circle-fin/x402-batching/client'
import { chainConfig, safeErrorMessage, toAtomicUsdc, fromAtomicUsdc } from './gatewayService.ts'
import { executeContract, signTypedDataFor, type AgentWallet } from './circleWallets.ts'
import { httpError } from '../http.ts'

/**
 * Moving USDC into and out of the Gateway ledger, without a private key.
 *
 * `GatewayClient` already does both, but its constructor demands
 * `privateKey: Hex` and there is no way to inject a signer, so these two
 * operations are reproduced here against a Circle wallet instead.
 *
 * Reproduced, not reinvented: every step below mirrors the SDK's own sequence,
 * read from its source rather than inferred from the docs, because the parts
 * that are easy to get subtly wrong (the EIP-712 domain, the bytes32 padding,
 * the order of approve and deposit) are the parts that lose money silently.
 */

const GATEWAY_API_MAINNET = 'https://gateway-api.circle.com/v1'
const GATEWAY_API_TESTNET = 'https://gateway-api-testnet.circle.com/v1'

/** Matches the SDK's default ceiling on what Circle may take for a transfer. */
const DEFAULT_MAX_FEE_USDC = '2.01'

export function gatewayApiBase(chain: SupportedChainName): string {
  return chainConfig(chain).chain.testnet === true ? GATEWAY_API_TESTNET : GATEWAY_API_MAINNET
}

/* ------------------------------------------------------------------ deposit */

export interface DepositOutcome {
  approvalTxHash: string | null
  depositTxHash: string
  amountUsdc: string
}

/**
 * Wallet USDC into the Gateway ledger on the same chain.
 *
 * Two transactions, in this order and no other: the token must be allowed to
 * move before the Gateway wallet pulls it. An approve that silently did nothing
 * followed by a deposit produces "transfer amount exceeds allowance", an error
 * that points at the wrong thing entirely, which is why `executeContract`
 * estimates first and waits for each to actually land.
 */
export async function depositToGateway(
  wallet: AgentWallet,
  chain: SupportedChainName,
  amountUsdc: string,
): Promise<DepositOutcome> {
  const config = chainConfig(chain)
  const atomic = toAtomicUsdc(amountUsdc)
  if (atomic <= 0n) throw httpError(400, 'Deposit amount must be greater than zero.')

  /*
   * Approve exactly what this deposit needs, not an unbounded allowance. The
   * Gateway wallet consumes it immediately, so nothing is left standing.
   */
  const approval = await executeContract({
    wallet,
    contractAddress: config.usdc,
    abiFunctionSignature: 'approve(address,uint256)',
    abiParameters: [config.gatewayWallet, atomic.toString()],
  })

  const deposit = await executeContract({
    wallet,
    contractAddress: config.gatewayWallet,
    abiFunctionSignature: 'deposit(address,uint256)',
    abiParameters: [config.usdc, atomic.toString()],
  })

  return {
    approvalTxHash: approval.txHash,
    depositTxHash: deposit.txHash,
    amountUsdc: fromAtomicUsdc(atomic),
  }
}

/* ----------------------------------------------------------------- withdraw */

/**
 * The EIP-712 shape of a Gateway burn intent.
 *
 * Copied field for field from the SDK. The order matters: EIP-712 hashes the
 * struct in declaration order, so a reordered field list yields a different
 * digest and a signature Circle will reject.
 */
export const BURN_INTENT_TYPES = {
  /*
   * Declared explicitly, and deliberately only name and version. viem infers
   * this block from the domain object; Circle receives raw JSON and infers
   * nothing, so leaving it out changes the domain separator. A BurnIntent is
   * not bound to a chain or a contract, unlike an EIP-3009 authorisation.
   */
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
  ],
  TransferSpec: [
    { name: 'version', type: 'uint32' },
    { name: 'sourceDomain', type: 'uint32' },
    { name: 'destinationDomain', type: 'uint32' },
    { name: 'sourceContract', type: 'bytes32' },
    { name: 'destinationContract', type: 'bytes32' },
    { name: 'sourceToken', type: 'bytes32' },
    { name: 'destinationToken', type: 'bytes32' },
    { name: 'sourceDepositor', type: 'bytes32' },
    { name: 'destinationRecipient', type: 'bytes32' },
    { name: 'sourceSigner', type: 'bytes32' },
    { name: 'destinationCaller', type: 'bytes32' },
    { name: 'value', type: 'uint256' },
    { name: 'salt', type: 'bytes32' },
    { name: 'hookData', type: 'bytes' },
  ],
  BurnIntent: [
    { name: 'maxBlockHeight', type: 'uint256' },
    { name: 'maxFee', type: 'uint256' },
    { name: 'spec', type: 'TransferSpec' },
  ],
} as const

/** Addresses travel as left-padded bytes32, lowercased, exactly as the SDK does. */
function toBytes32(address: string): string {
  return pad(address.toLowerCase() as `0x${string}`, { size: 32 })
}

/**
 * The burn intent itself, built exactly as the SDK builds it.
 *
 * Exported and pure so a test can diff it field by field against
 * `GatewayClient.createBurnIntent`. That check is the only thing standing
 * between a transcription slip here and a signature Circle silently rejects, or
 * worse, one it accepts for the wrong destination.
 */
export function buildBurnIntent(args: {
  fromChain: SupportedChainName
  toChain: SupportedChainName
  depositor: string
  recipient: string
  value: bigint
  maxFee: bigint
  /** Injectable only so a test can compare against a fixed intent. */
  salt?: `0x${string}`
}) {
  const from = chainConfig(args.fromChain)
  const to = chainConfig(args.toChain)
  return {
    maxBlockHeight: maxUint256,
    maxFee: args.maxFee,
    spec: {
      version: 1,
      sourceDomain: from.domain,
      destinationDomain: to.domain,
      sourceContract: toBytes32(from.gatewayWallet),
      destinationContract: toBytes32(to.gatewayMinter),
      sourceToken: toBytes32(from.usdc),
      destinationToken: toBytes32(to.usdc),
      sourceDepositor: toBytes32(args.depositor),
      destinationRecipient: toBytes32(args.recipient),
      sourceSigner: toBytes32(args.depositor),
      /*
       * Zero means anyone may submit the mint. The attestation is bound to the
       * recipient, so an open caller cannot redirect the funds, and naming a
       * specific caller would strand the withdrawal if that account had no gas
       * on the destination.
       */
      destinationCaller: toBytes32(zeroAddress),
      value: args.value,
      salt: args.salt ?? (`0x${randomBytes(32).toString('hex')}` as `0x${string}`),
      hookData: '0x',
    },
  }
}

/**
 * Hand a signed burn intent to Circle and get back the attestation that
 * authorises the mint.
 *
 * Separate from `withdrawFromGateway` because migration needs the same
 * exchange with a signature produced elsewhere: the old wallet's Gateway
 * balance can only be released by the old key, which lives in the browser and
 * must stay there.
 */
export async function submitBurnIntent(
  apiBase: string,
  burnIntent: unknown,
  signature: string,
): Promise<{ attestation: string; signature: string }> {
  try {
    const response = await fetch(`${apiBase}/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The same bigint-safe serialisation the SDK uses. A uint256 cannot go
      // through plain JSON.stringify, which throws rather than coercing.
      body: JSON.stringify([{ burnIntent, signature }], (_key, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      ),
    })
    const result = (await response.json()) as {
      success?: boolean
      error?: string
      message?: string
      attestation?: string
      signature?: string
    }
    if (result.success === false || result.error || !result.attestation || !result.signature) {
      throw new Error(result.message ?? result.error ?? 'Gateway API rejected the transfer')
    }
    return { attestation: result.attestation, signature: result.signature }
  } catch (err) {
    throw httpError(502, `Gateway could not authorise the transfer: ${safeErrorMessage(err)}`)
  }
}

export interface WithdrawOutcome {
  mintTxHash: string
  amountUsdc: string
  sourceChain: SupportedChainName
  destinationChain: SupportedChainName
  recipient: string
}

/**
 * Gateway ledger back out to a plain wallet balance.
 *
 * Three steps, only the last of which is a transaction: sign a burn intent,
 * hand it to Circle's API for an attestation, then mint on the destination.
 * The mint costs gas on the destination chain, which matters when the
 * destination is one the user has never funded.
 */
export async function withdrawFromGateway(
  wallet: AgentWallet,
  fromChain: SupportedChainName,
  opts: {
    amountUsdc: string
    toChain?: SupportedChainName
    recipient?: string
    maxFeeUsdc?: string
  },
): Promise<WithdrawOutcome> {
  const toChain = opts.toChain ?? fromChain
  const to = chainConfig(toChain)
  const value = toAtomicUsdc(opts.amountUsdc)
  if (value <= 0n) throw httpError(400, 'Withdrawal amount must be greater than zero.')

  const recipient = opts.recipient ?? wallet.address
  const maxFee = toAtomicUsdc(opts.maxFeeUsdc ?? DEFAULT_MAX_FEE_USDC)

  const burnIntent = buildBurnIntent({
    fromChain,
    toChain,
    depositor: wallet.address,
    recipient,
    value,
    maxFee,
  })

  const signature = await signTypedDataFor(wallet, {
    domain: { name: 'GatewayWallet', version: '1' },
    types: BURN_INTENT_TYPES,
    primaryType: 'BurnIntent',
    message: burnIntent,
  })

  const { attestation, signature: attestationSignature } = await submitBurnIntent(
    gatewayApiBase(fromChain),
    burnIntent,
    signature,
  )

  /*
   * The only on-chain step, and it lands on the destination rather than the
   * source. Until this succeeds the funds are attested but not minted, so a
   * failure here is recoverable by resubmitting the same attestation and must
   * not be reported as money lost.
   */
  const mint = await executeContract({
    wallet,
    contractAddress: to.gatewayMinter,
    abiFunctionSignature: 'gatewayMint(bytes,bytes)',
    abiParameters: [attestation, attestationSignature],
  })

  return {
    mintTxHash: mint.txHash,
    amountUsdc: fromAtomicUsdc(value),
    sourceChain: fromChain,
    destinationChain: toChain,
    recipient,
  }
}
