import {
  createPublicClient,
  createWalletClient,
  parseAbi,
  erc20Abi,
  toFunctionSignature,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { SupportedChainName } from '@circle-fin/x402-batching/client'
import { chainConfig, safeErrorMessage,
  transportFor,
} from './gatewayService.ts'
import { DEPLOYMENTS } from './deployments.ts'
import { KEEPER_PRIVATE_KEY } from '../env.ts'
import { executeContract, type AgentWallet } from './circleWallets.ts'

/**
 * Moves a user's USDC to the chain a seller wants paying on, and lands it in
 * their Gateway balance there.
 *
 * The gap this closes: an x402 Gateway payment is signed against the
 * GatewayWallet on the invoice's chain and can only draw that chain's ledger, so
 * a wallet funded on Base cannot pay a Polygon invoice however much it holds.
 *
 * Four steps, and who pays for each matters:
 *
 *   1. burn      the user signs, on a chain they already have gas on
 *   2. attest    Circle, off-chain, free
 *   3. mint      the keeper signs on the destination
 *   4. sweep     the keeper signs on the destination
 *
 * Steps 3 and 4 are the keeper's because the user has no native token on a
 * chain they have never used — which is the entire problem. The keeper can do
 * this without being trusted: the mint goes to a receiver contract derived from
 * the user, and that contract can only ever credit that user's Gateway ledger
 * or refund them. See TridentGatewayReceiver.
 *
 * Deliberately not relying on Circle's forwarding relayer. It would submit the
 * mint for us, but only if `hookData` carries a magic-byte prefix that is not
 * published in any package shipped to us. Getting it wrong burns funds that no
 * relayer then moves. Since the keeper already needs gas on the destination for
 * the sweep, it may as well submit the mint too — one fewer unknown, and the
 * flow no longer depends on a third party's queue.
 */

const ROUTER_ABI = parseAbi([
  'function bridge(uint32 destinationDomain, bytes32 mintRecipient, uint256 amount, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)',
])

const FACTORY_ABI = parseAbi([
  'function receiverOf(address depositor) view returns (address)',
  'function sweep(address depositor) returns (uint256)',
])

const MESSAGE_TRANSMITTER_ABI = parseAbi([
  'function receiveMessage(bytes message, bytes attestation)',
])

/** Circle's MessageTransmitterV2. Verified on-chain: impl carries 0x57ecfd28. */
const MESSAGE_TRANSMITTER_V2 = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64' as const

const ATTESTATION_API = 'https://iris-api.circle.com/v2/messages'

/**
 * Ask CCTP to settle fast rather than wait for hard finality.
 *
 * 1000 is Circle's "confirmed" threshold: seconds to low minutes instead of the
 * ~13 minutes hard finality takes on most chains. It costs a slightly higher
 * relay fee, which is the right trade when someone is waiting on an API call.
 */
const FAST_FINALITY_THRESHOLD = 1000

/**
 * The most of a transfer CCTP may take as a fee, in basis points.
 *
 * Applied to the amount rather than fixed, because the fee scales and a flat
 * cap would either block small transfers or wave through a bad quote on large
 * ones. The mint arrives net of whatever is actually charged.
 */
const MAX_FEE_BPS = 100n

/** How long to wait for Circle to attest before giving up. */
const ATTESTATION_TIMEOUT_MS = 5 * 60_000
const ATTESTATION_POLL_MS = 4_000

/**
 * A failure moving the user's funds, as opposed to a failure of the endpoint.
 *
 * The distinction decides what the runner does next. An endpoint that rejects a
 * call may have a working sibling, so failover is right. A bridge that reverts
 * means we never contacted the endpoint at all — substituting then blames a
 * seller for our bug and, worse, buys something else. That is exactly what
 * happened: a bridge revert sent a request for candlestick data to an events
 * endpoint, and charged for it.
 */
export class BridgeError extends Error {
  override readonly name = 'BridgeError'
}

export interface BridgeProgress {
  stage: 'burning' | 'attesting' | 'minting' | 'sweeping' | 'done'
  detail?: string
}

export interface BridgeResult {
  burnTxHash: string
  mintTxHash: string
  sweepTxHash: string
  /** Credited to the Gateway ledger, net of CCTP's fee. Atomic units. */
  creditedAtomic: bigint
}

export function keeperAccount() {
  if (!KEEPER_PRIVATE_KEY) {
    throw new BridgeError(
      'Cross-chain settlement is not configured: KEEPER_PRIVATE_KEY is unset, so nothing can ' +
        'complete the transfer on the destination chain.',
    )
  }
  return privateKeyToAccount(KEEPER_PRIVATE_KEY as `0x${string}`)
}

function clientsFor(chain: SupportedChainName) {
  const config = chainConfig(chain)
  const transport = transportFor(chain)
  return {
    config,
    publicClient: createPublicClient({ chain: config.chain, transport }),
    transport,
  }
}

/**
 * The address a user's cross-chain USDC should be sent to on `chain`.
 *
 * Read from the deployed factory rather than recomputed here. The derivation is
 * a CREATE2 hash over the factory, the token and the user, and duplicating it
 * in TypeScript means two places that must agree forever — a mismatch would
 * send real money to an address nothing can sweep.
 */
export async function receiverAddressFor(
  user: string,
  chain: SupportedChainName,
): Promise<`0x${string}`> {
  const deployment = DEPLOYMENTS[chain]
  if (!deployment) throw new BridgeError(`No Trident receiver deployed on ${chain}.`)

  const { publicClient } = clientsFor(chain)
  return publicClient.readContract({
    address: deployment.receiverFactory,
    abi: FACTORY_ABI,
    functionName: 'receiverOf',
    args: [user as `0x${string}`],
  })
}

/**
 * Move `amount` of the user's USDC from `fromChain` into their Gateway balance
 * on `toChain`.
 *
 * @param onProgress Called as each stage begins. This takes minutes end to end
 *        and the caller is holding a stream open, so silence is not an option.
 */
export async function bridgeToGatewayBalance(
  wallet: AgentWallet,
  fromChain: SupportedChainName,
  toChain: SupportedChainName,
  amountAtomic: bigint,
  onProgress: (progress: BridgeProgress) => void = () => {},
): Promise<BridgeResult> {
  const source = DEPLOYMENTS[fromChain]
  const destination = DEPLOYMENTS[toChain]
  if (!source) throw new BridgeError(`Cross-chain settlement is not available from ${fromChain}.`)
  if (!destination) throw new BridgeError(`Cross-chain settlement is not available to ${toChain}.`)

  const keeper = keeperAccount()
  const src = clientsFor(fromChain)
  const dst = clientsFor(toChain)

  const mintRecipient = await receiverAddressFor(wallet.address, toChain)

  /* ------------------------------------------------------------- 1. burn */
  onProgress({ stage: 'burning', detail: `${fromChain} → ${toChain}` })

  /*
   * The user's half is signed by Circle now, so there is no wallet client for
   * them here. The reads below still go through our own public client: an
   * allowance is public state and needs no signer.
   */

  // Approve only what this transfer needs. The router consumes it in the same
  // transaction, so no standing allowance is left behind.
  const allowance = await src.publicClient.readContract({
    address: src.config.usdc,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [wallet.address, source.cctpRouter],
  })
  if (allowance < amountAtomic) {
    /*
     * `executeContract` estimates first and then polls to a terminal state, so
     * the two hazards this code was built around are both still covered: it
     * refuses a call that would revert, and it treats anything short of
     * COMPLETE as a failure. A mined-but-reverted approve used to pass silently
     * here and surface later as "ERC20: transfer amount exceeds allowance", an
     * error that points at the wrong thing entirely.
     */
    await executeContract({
      wallet,
      contractAddress: src.config.usdc,
      abiFunctionSignature: 'approve(address,uint256)',
      abiParameters: [source.cctpRouter, amountAtomic.toString()],
    })

    /*
     * Then confirm the allowance is actually readable before spending against
     * it. A mined approve is not immediately visible on every node, and the
     * first live attempt reverted on exactly that race: the approve had landed,
     * but the burn was simulated against a node that had not caught up.
     */
    const confirmed = await src.publicClient.readContract({
      address: src.config.usdc,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [wallet.address, source.cctpRouter],
    })
    if (confirmed < amountAtomic) {
      throw new BridgeError(
        'The USDC approval for the bridge has not propagated yet. Nothing was charged, retry ' +
          'in a moment.',
      )
    }
  }

  const maxFee = (amountAtomic * MAX_FEE_BPS) / 10_000n
  const { txHash: burnTxHash } = await executeContract({
    wallet,
    contractAddress: source.cctpRouter,
    /*
     * Derived from the ABI, never hand-written. Circle takes a signature
     * string rather than an ABI, and a typo in one would compute a different
     * function selector: the call would either revert or, far worse, land on
     * some other function that happened to match.
     */
    abiFunctionSignature: toFunctionSignature(ROUTER_ABI[0]),
    abiParameters: [
      destination.domain,
      // Left-pad the address into the bytes32 CCTP expects.
      `0x${mintRecipient.slice(2).toLowerCase().padStart(64, '0')}`,
      amountAtomic.toString(),
      // A fee of zero would be rejected by the contract's own guard on tiny
      // amounts, so keep at least one atomic unit of headroom.
      (maxFee > 0n ? maxFee : 1n).toString(),
      FAST_FINALITY_THRESHOLD,
      // No forwarding marker: the keeper submits the mint itself.
      '0x',
    ],
  })

  /* -------------------------------------------------------- 2. attestation */
  onProgress({ stage: 'attesting', detail: 'waiting for Circle' })
  const { message, attestation } = await waitForAttestation(source.domain, burnTxHash)

  /* ------------------------------------------------------------- 3. mint */
  onProgress({ stage: 'minting', detail: toChain })
  const keeperWallet = createWalletClient({
    account: keeper,
    chain: dst.config.chain,
    transport: dst.transport,
  })

  const mintTxHash = await keeperWallet.writeContract({
    address: MESSAGE_TRANSMITTER_V2,
    abi: MESSAGE_TRANSMITTER_ABI,
    functionName: 'receiveMessage',
    args: [message, attestation],
  })
  await dst.publicClient.waitForTransactionReceipt({ hash: mintTxHash })

  /* ------------------------------------------------------------ 4. sweep */
  onProgress({ stage: 'sweeping', detail: toChain })

  // Measured rather than assumed: what arrived is the burn minus CCTP's fee,
  // and the ledger credit must reflect what actually landed.
  const arrived = await dst.publicClient.readContract({
    address: dst.config.usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [mintRecipient],
  })

  const sweepTxHash = await keeperWallet.writeContract({
    address: destination.receiverFactory,
    abi: FACTORY_ABI,
    functionName: 'sweep',
    args: [wallet.address],
  })
  await dst.publicClient.waitForTransactionReceipt({ hash: sweepTxHash })

  onProgress({ stage: 'done' })
  return { burnTxHash, mintTxHash, sweepTxHash, creditedAtomic: arrived }
}

/**
 * Poll Circle until the burn is attested.
 *
 * The attestation is what authorises the mint, and it does not exist until
 * Circle has seen the burn reach the requested finality. There is no callback,
 * so polling is the only option.
 */
async function waitForAttestation(
  sourceDomain: number,
  burnTxHash: string,
): Promise<{ message: `0x${string}`; attestation: `0x${string}` }> {
  const deadline = Date.now() + ATTESTATION_TIMEOUT_MS

  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `${ATTESTATION_API}/${sourceDomain}?transactionHash=${burnTxHash}`,
      )
      if (response.ok) {
        const body = (await response.json()) as {
          messages?: { status?: string; message?: string; attestation?: string }[]
        }
        const entry = body.messages?.[0]
        if (entry?.status === 'complete' && entry.message && entry.attestation) {
          return {
            message: entry.message as `0x${string}`,
            attestation: entry.attestation as `0x${string}`,
          }
        }
      }
    } catch {
      // A transient failure here is not fatal; the burn is already on chain and
      // the attestation will still be there on the next poll.
    }
    await new Promise((resolve) => setTimeout(resolve, ATTESTATION_POLL_MS))
  }

  throw new BridgeError(
    `Circle did not attest the transfer within ${ATTESTATION_TIMEOUT_MS / 60_000} minutes. ` +
      `The USDC is burned and recoverable — the mint can still be submitted later with burn ` +
      `transaction ${burnTxHash}. Nothing was paid to the seller.`,
  )
}

/** A one-line summary for the failure log, without leaking the key. */
export function describeBridgeFailure(err: unknown): string {
  return safeErrorMessage(err)
}
