import { randomUUID } from 'node:crypto'
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets'
import { CHAIN_CONFIGS, type SupportedChainName } from '@circle-fin/x402-batching/client'
import { httpError } from '../http.ts'
import {
  CIRCLE_API_KEY,
  CIRCLE_API_KEY_MAINNET,
  CIRCLE_ENTITY_SECRET,
  CIRCLE_ENTITY_SECRET_MAINNET,
  CIRCLE_MAINNET_ENABLED,
  CIRCLE_TESTNET_ENABLED,
  CIRCLE_WALLET_SET_ID,
  CIRCLE_WALLET_SET_ID_MAINNET,
} from '../env.ts'
import { encodeFunctionData, parseAbiItem } from 'viem'
import { safeErrorMessage } from './gatewayService.ts'
import { BUILDER_DATA_SUFFIX } from './attribution.ts'
import { ensureGas } from './gasSponsor.ts'

/**
 * The only place the Circle SDK is touched.
 *
 * Everything else in this codebase used to take an `agentPrivateKey` and build
 * a viem signer from it, which meant the user's plaintext key crossed the
 * network on every operation that moved money. Here a wallet is an id, signing
 * is a call, and the key material never exists on our side at all.
 *
 * The trade is deliberate and worth naming: this removes the interception risk
 * entirely and replaces it with a concentration risk. See CIRCLE_ENTITY_SECRET
 * in env.ts.
 */

/**
 * Our chain keys to Circle's blockchain identifiers.
 *
 * Deliberately explicit rather than derived. A wrong entry here sends real USDC
 * to the right address on the wrong network, and a lookup that silently fell
 * back to a default is exactly how that happens: CHAIN_LABELS in
 * gatewayService.ts once did precisely that and routed a mainnet Gateway
 * deposit to a testnet.
 *
 * Absent by necessity, not oversight: hyperEvm, sei, sonic and worldChain (and
 * their testnets) have no Circle wallet support. Base and Polygon between them
 * settle every service in the catalog, so this constrains the shelved
 * multi-chain expansion rather than the product.
 */
const CIRCLE_CHAINS: Partial<Record<SupportedChainName, string>> = {
  arcTestnet: 'ARC-TESTNET',
  baseSepolia: 'BASE-SEPOLIA',
  sepolia: 'ETH-SEPOLIA',
  arbitrumSepolia: 'ARB-SEPOLIA',
  avalancheFuji: 'AVAX-FUJI',
  optimismSepolia: 'OP-SEPOLIA',
  polygonAmoy: 'MATIC-AMOY',
  unichainSepolia: 'UNI-SEPOLIA',
  arc: 'ARC',
  base: 'BASE',
  ethereum: 'ETH',
  arbitrum: 'ARB',
  avalanche: 'AVAX',
  optimism: 'OP',
  polygon: 'MATIC',
  unichain: 'UNI',
}

/** Every chain a Circle wallet can act on, for provisioning and for gating. */
export const CIRCLE_SUPPORTED_CHAINS = Object.keys(CIRCLE_CHAINS) as SupportedChainName[]

export function circleChainFor(chain: SupportedChainName): string {
  const mapped = CIRCLE_CHAINS[chain]
  if (!mapped) {
    throw httpError(
      400,
      `${chain} is not a network Circle wallets can sign for, so the agent cannot ` +
        'transact there. Nothing was charged.',
    )
  }
  return mapped
}

export function isCircleChain(chain: SupportedChainName): boolean {
  return chain in CIRCLE_CHAINS
}

/* ------------------------------------------------------------------ client */

type CircleClient = ReturnType<typeof initiateDeveloperControlledWalletsClient>

/**
 * Which Circle account space a chain belongs to.
 *
 * Not a preference. Sandbox and production are separate account spaces, and a
 * key for one is rejected by the other, so this is a property of the chain
 * rather than a setting.
 */
export type CircleEnv = 'testnet' | 'mainnet'

export function circleEnvFor(chain: SupportedChainName): CircleEnv {
  return CHAIN_CONFIGS[chain]?.chain.testnet === true ? 'testnet' : 'mainnet'
}

const clients: Partial<Record<CircleEnv, CircleClient>> = {}

/** Which wallet set new wallets go into, per environment. */
export function walletSetFor(env: CircleEnv): string {
  return env === 'mainnet' ? CIRCLE_WALLET_SET_ID_MAINNET : CIRCLE_WALLET_SET_ID
}

/** The secret that authorises signing in this environment. */
export function entitySecretFor(env: CircleEnv): string {
  return env === 'mainnet' ? CIRCLE_ENTITY_SECRET_MAINNET : CIRCLE_ENTITY_SECRET
}

export function circleEnabled(env: CircleEnv): boolean {
  return env === 'mainnet' ? CIRCLE_MAINNET_ENABLED : CIRCLE_TESTNET_ENABLED
}

/**
 * Built on first use, not at import.
 *
 * Tests, the status prober and anything that never touches a wallet must be
 * able to import this module without credentials present. Constructing at
 * import time would make an unconfigured environment fail at boot rather than
 * at the one call that actually needs Circle.
 *
 * Named per environment so a missing mainnet key says so, rather than failing
 * later with a rejected sandbox key and an error about the wrong thing.
 */
export function circleClient(env: CircleEnv): CircleClient {
  if (!circleEnabled(env)) {
    const suffix = env === 'mainnet' ? '_MAINNET' : ''
    throw httpError(
      503,
      `${env} wallet operations are not configured: CIRCLE_API_KEY${suffix}, ` +
        `CIRCLE_WALLET_SET_ID${suffix} and an entity secret must all be set, and that secret ` +
        `must be registered in Circle's ${env} environment.`,
    )
  }
  const existing = clients[env]
  if (existing) return existing

  const built = initiateDeveloperControlledWalletsClient({
    apiKey: env === 'mainnet' ? CIRCLE_API_KEY_MAINNET : CIRCLE_API_KEY,
    entitySecret: entitySecretFor(env),
  })
  clients[env] = built
  return built
}

/**
 * Every mutating Circle call needs its own key for exactly-once execution.
 *
 * Reusing one across calls is not a style question: it makes the second call a
 * no-op that returns the first call's result, so a second payment would report
 * success having never happened.
 */
function idempotencyKey(): string {
  return randomUUID()
}

/* ------------------------------------------------------- transaction states */

/**
 * Circle's terminal states, and what each one means for a user.
 *
 * The SDK's own `waitForState` rejects on any terminal failure, but the
 * rejection does not carry which state caused it, and these are not
 * interchangeable: DENIED is compliance refusing a payment the product already
 * promised, STUCK is an underpriced fee that is still recoverable, FAILED is a
 * revert. Collapsing them into "transaction failed" would tell a user nothing
 * about whether to retry, wait, or give up. So we poll and classify ourselves.
 */
export type TransactionState =
  | 'INITIATED'
  | 'PENDING_RISK_SCREENING'
  | 'WAITING'
  | 'QUEUED'
  | 'CLEARED'
  | 'SENT'
  | 'STUCK'
  | 'CONFIRMED'
  | 'COMPLETE'
  | 'FAILED'
  | 'DENIED'
  | 'CANCELLED'

export interface StateVerdict {
  /** Stop polling. */
  done: boolean
  /** Only ever true for COMPLETE. */
  ok: boolean
  /** Whether the caller should raise the fee and resubmit rather than retry as-is. */
  retryWithHigherFee: boolean
  /** User-facing, already specific to the state. Empty when still in flight. */
  message: string
}

export function classifyTransactionState(state: string): StateVerdict {
  switch (state) {
    case 'COMPLETE':
      return { done: true, ok: true, retryWithHigherFee: false, message: '' }

    /*
     * CONFIRMED is in a block but not final. Treating it as success is
     * tempting and wrong: a reorg can still take it, and the whole reason we
     * stopped trusting viem's receipt is that a resolved promise is not proof
     * a transaction succeeded.
     */
    case 'FAILED':
      return {
        done: true,
        ok: false,
        retryWithHigherFee: false,
        message: 'The transaction was submitted but reverted on chain. Nothing was charged.',
      }
    case 'DENIED':
      return {
        done: true,
        ok: false,
        retryWithHigherFee: false,
        message:
          'Circle declined this transaction on a compliance check, so it was never submitted. ' +
          'Nothing was charged. This is not something retrying will change.',
      }
    case 'CANCELLED':
      return {
        done: true,
        ok: false,
        retryWithHigherFee: false,
        message: 'The transaction was cancelled before it reached the network. Nothing was charged.',
      }
    case 'STUCK':
      return {
        done: true,
        ok: false,
        retryWithHigherFee: true,
        message:
          'The network fee offered was below what the chain is currently taking, so the ' +
          'transaction did not get in. Retrying at a higher fee should work.',
      }
    default:
      return { done: false, ok: false, retryWithHigherFee: false, message: '' }
  }
}

/* --------------------------------------------------------------- operations */

export interface ProvisionedWallet {
  walletId: string
  address: string
}

/**
 * Create this user's wallet.
 *
 * EOA rather than SCA: x402 settlement verifies a plain EIP-712 signature, and
 * an ERC-4337 account would need every facilitator in the catalog to support
 * ERC-1271 contract signatures, which is not an assumption 909 sellers will
 * honour. EOA also covers more chains.
 *
 * One call per user. Every EVM wallet in a set shares an address, so the result
 * is the same one-address-everywhere shape the old EOA had.
 */
export async function provisionWallet(
  env: CircleEnv,
  chains: SupportedChainName[],
): Promise<ProvisionedWallet> {
  // Only chains belonging to this environment: a sandbox wallet cannot be
  // created on Base, and asking would fail the whole call rather than part.
  const blockchains = [
    ...new Set(
      chains
        .filter((c) => isCircleChain(c) && circleEnvFor(c) === env)
        .map(circleChainFor),
    ),
  ]
  if (blockchains.length === 0) {
    throw httpError(400, `No requested network belongs to Circle's ${env} environment.`)
  }

  try {
    const response = await circleClient(env).createWallets({
      accountType: 'EOA',
      blockchains: blockchains as never[],
      count: 1,
      walletSetId: walletSetFor(env),
      idempotencyKey: idempotencyKey(),
    })

    const wallet = response.data?.wallets?.[0]
    if (!wallet?.id || !wallet.address) {
      throw new Error('Circle returned no wallet')
    }
    return { walletId: wallet.id, address: wallet.address }
  } catch (err) {
    throw httpError(502, `Could not create a wallet: ${safeErrorMessage(err)}`)
  }
}

export interface TypedDataRequest {
  /*
   * chainId and verifyingContract are optional because not every domain has
   * them. An EIP-3009 authorisation is bound to a token on a chain and carries
   * both; a Gateway BurnIntent is domain-separated by name and version alone.
   * Requiring all four would make the withdrawal path unrepresentable, and
   * inventing values to satisfy the type would change the domain separator and
   * produce a signature nothing will accept.
   */
  domain: { name: string; version: string; chainId?: number; verifyingContract?: string }
  /*
   * Readonly, because the EIP-712 type definitions callers pass are `as const`
   * tuples. They describe a fixed standard, so freezing them is correct, and a
   * mutable signature would force every call site to copy the array purely to
   * satisfy the compiler.
   */
  types: Readonly<Record<string, readonly { readonly name: string; readonly type: string }[]>>
  primaryType: string
  message: Readonly<Record<string, unknown>>
}

/**
 * A provisioned wallet, as the rest of the app refers to it.
 *
 * Carries its environment because a sandbox wallet id means nothing to the
 * production client and vice versa. Passing one to the wrong client is the
 * mistake this field exists to make impossible to express.
 */
export interface AgentWallet {
  walletId: string
  address: `0x${string}`
  env: CircleEnv
}

/**
 * JSON that survives a uint256.
 *
 * An EIP-3009 authorisation carries `value`, `validAfter` and `validBefore` as
 * bigints, because that is what viem wanted and what the amounts genuinely are.
 * `JSON.stringify` throws outright on a bigint rather than coercing it, so
 * sending typed data to Circle without this fails on every payment above zero.
 * Stringifying is also what the wire format wants: JSON numbers cannot hold a
 * uint256 without losing precision.
 */
export function jsonWithBigints(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v))
}

/**
 * The wallet for a user row, or a refusal that says what to do about it.
 *
 * A row with no Circle wallet is either a user who predates this change and has
 * not migrated, or one whose provisioning failed. Both need to be told
 * something actionable rather than met with a null dereference somewhere deeper
 * in a payment.
 */
export interface WalletColumns {
  circle_wallet_id: string | null
  circle_wallet_address: string | null
  circle_wallet_id_testnet: string | null
  circle_wallet_address_testnet: string | null
}

/**
 * The address for an environment, or null when this account has no wallet there.
 *
 * The nullable half of `walletForRow`, for the one caller that must not refuse:
 * the deposit panel asks for every environment at once so the network toggle
 * cannot race, and a missing mainnet wallet is an ordinary state for an account
 * that has not opted in, not an error.
 */
export function walletAddressFor(row: WalletColumns, env: CircleEnv): `0x${string}` | null {
  const id = env === 'mainnet' ? row.circle_wallet_id : row.circle_wallet_id_testnet
  const address = env === 'mainnet' ? row.circle_wallet_address : row.circle_wallet_address_testnet
  // Both, or neither. An address without its wallet id cannot be signed for,
  // so showing it would invite a deposit nothing can spend.
  return id && address ? (address as `0x${string}`) : null
}

export function walletForRow(row: WalletColumns, env: CircleEnv): AgentWallet {
  const id = env === 'mainnet' ? row.circle_wallet_id : row.circle_wallet_id_testnet
  const address = walletAddressFor(row, env)

  if (!id || !address) {
    throw httpError(
      409,
      `This account has no ${env} agent wallet yet. Finish setting one up in Wallet before ` +
        'the agent can pay for anything there.',
    )
  }
  return { walletId: id, address, env }
}

/** The same lookup keyed by chain, which is how most callers know it. */
export function walletForChain(row: WalletColumns, chain: SupportedChainName): AgentWallet {
  return walletForRow(row, circleEnvFor(chain))
}

/** And the nullable form, keyed by chain. */
export function walletAddressForChain(
  row: WalletColumns,
  chain: SupportedChainName,
): `0x${string}` | null {
  return walletAddressFor(row, circleEnvFor(chain))
}

/**
 * The signature an x402 payment is made of.
 *
 * Both rails reduce to this: an EIP-3009 TransferWithAuthorization signed for a
 * specific amount, recipient, nonce and validity window. That is the whole
 * reason this migration is possible without touching the payment protocol at
 * all, and why `BatchEvmSigner` in the batching SDK only ever asked for
 * `{ address, signTypedData }`.
 */
export async function signTypedDataFor(
  wallet: AgentWallet,
  typedData: TypedDataRequest,
): Promise<`0x${string}`> {
  try {
    const response = await circleClient(wallet.env).signTypedData({
      walletId: wallet.walletId,
      data: jsonWithBigints(typedData),
    })
    const signature = response.data?.signature
    if (!signature) throw new Error('Circle returned no signature')
    return signature as `0x${string}`
  } catch (err) {
    throw httpError(502, `Could not sign the payment: ${safeErrorMessage(err)}`)
  }
}

export interface ContractCall {
  wallet: AgentWallet
  /**
   * The chain this executes on.
   *
   * Added because the call could not previously say which network it acted on,
   * which meant nothing here could check the wallet had gas for it. Circle
   * infers the chain from the wallet, so this is not sent to Circle; it is for
   * the checks that happen first.
   */
  chain: SupportedChainName
  contractAddress: string
  /** e.g. `approve(address,uint256)`. Preferred over raw calldata, per Circle. */
  abiFunctionSignature: string
  abiParameters: unknown[]
  /** Native value to send, as a decimal string. Omit for a pure token call. */
  amount?: string
}

/**
 * The call encoded as raw calldata, with the Builder Code appended.
 *
 * Circle normally builds the calldata itself from the signature and parameters,
 * which is the safer arrangement and the one used everywhere until now: fewer
 * places to get ABI encoding wrong, and the encoding it produces is the one its
 * own estimate is based on. But an ERC-8021 attribution suffix is bytes trailing
 * the calldata, and there is no way to ask for one through the ABI form, so a
 * tagged call has to be encoded here and handed over whole.
 *
 * Returns null when no Builder Code is configured, and the caller then keeps the
 * ABI form untouched. That is deliberate: with attribution off, not one byte of
 * any transaction changes, so this whole path cannot affect a wallet that has
 * not opted into it.
 */
function attributedCallData(call: ContractCall): `0x${string}` | null {
  if (!BUILDER_DATA_SUFFIX) return null
  try {
    return `${encodeCall(call.abiFunctionSignature, call.abiParameters)}${BUILDER_DATA_SUFFIX.slice(2)}`
  } catch (err) {
    /*
     * Fall back to the ABI form rather than failing the transaction. An
     * encoding this module could not produce is a bug in the attribution path,
     * and the payment it is attached to is not the place to surface it: Circle
     * will encode the same call correctly, and the only thing lost is a
     * dashboard row.
     */
    console.error(
      '[trident] could not encode calldata for attribution, sending untagged:',
      JSON.stringify({ signature: call.abiFunctionSignature, error: String(err) }),
    )
    return null
  }
}

/**
 * ABI-encode a call from the signature string Circle takes.
 *
 * The signature is the same string already passed to Circle, so the selector
 * cannot drift between the tagged and untagged paths — both are derived from
 * one source. Parameters arrive as the strings and numbers Circle's JSON API
 * wants; viem wants the native types, so integers are widened to bigint here
 * and everything else passes through as written.
 *
 * Exported for the test that pins the output against known selectors, because
 * this is the one place in the attribution work that rewrites what a
 * transaction actually says.
 */
export function encodeCall(signature: string, params: unknown[]): `0x${string}` {
  const item = parseAbiItem(`function ${signature}`)
  const inputs = (item as { inputs?: readonly { type: string }[] }).inputs ?? []
  const args = inputs.map((input, i) => {
    const value = params[i]
    // uint8 through uint256 and their signed counterparts. Everything else —
    // address, bytes, bytes32, string, bool — is already the shape viem wants.
    if (/^u?int\d*$/.test(input.type)) return BigInt(String(value))
    return value
  })
  /*
   * Cast because the signature is a runtime string, so viem cannot infer the
   * argument tuple from it the way it does for a literal ABI. The types it
   * would infer are the whole reason the coercion above exists; the check that
   * this is right is the test pinning the output against known selectors.
   */
  return encodeFunctionData({ abi: [item], args } as unknown as Parameters<
    typeof encodeFunctionData
  >[0])
}

/**
 * Pre-flight, replacing the `simulateContract` call this used to make.
 *
 * viem let us simulate and refuse to send a call that would revert. Circle's
 * equivalent is a fee estimate, which fails for a call that cannot succeed, so
 * it serves the same purpose: find out before spending gas, not after. Worth
 * keeping even though it costs a round trip, because the failure it catches
 * (an approve that silently did nothing, then a burn reverting with a
 * misleading allowance error) is one we have actually hit.
 */
export async function estimateContractCall(call: ContractCall): Promise<void> {
  try {
    // Note the shape difference from createContractExecutionTransaction below,
    // which takes walletId at the top level. Estimating nests it under source.
    /*
     * Estimated against the same bytes that will be submitted. Estimating the
     * ABI form and then sending calldata would be estimating a different
     * transaction, and the suffix costs real gas (16 per non-zero byte).
     */
    const callData = attributedCallData(call)
    await circleClient(call.wallet.env).estimateContractExecutionFee({
      source: { walletId: call.wallet.walletId },
      contractAddress: call.contractAddress,
      ...(callData
        ? { callData }
        : {
            abiFunctionSignature: call.abiFunctionSignature,
            abiParameters: call.abiParameters as unknown[],
          }),
      ...(call.amount ? { amount: call.amount } : {}),
    } as never)
  } catch (err) {
    throw refusalFor(err)
  }
}

/**
 * What Circle refused, said as something the user can act on.
 *
 * Circle answers a call it cannot run with a sentence about the wallet's asset
 * amount, which is accurate and tells nobody what to do. These two cases are
 * the ones that actually happen, and they need different actions: one is a
 * shortfall in the token being moved, the other in the gas to move it, and a
 * user who tops up the wrong one is no better off.
 *
 * Anything unrecognised keeps Circle's own words rather than being flattened
 * into a guess. A wrong diagnosis is worse than an unfamiliar one.
 */
export function refusalFor(err: unknown): Error {
  const message = safeErrorMessage(err)

  /*
   * Logged, because nothing else does.
   *
   * These become 400s, and the error handler only logs 5xx, so a user hitting a
   * payment refusal left no server-side trace at all — the last one had to be
   * reconstructed from chain state and Circle's transaction list. Circle's own
   * words are the only account of why a payment did not happen.
   */
  console.warn('[trident] circle refused a transaction:', message.replace(/\s+/g, ' ').slice(0, 300))

  /*
   * "…insufficient token when estimating fee" is Circle's phrasing for a wallet
   * that cannot pay the gas, not one short of the token being moved. It was
   * read the other way until a user with 0.87 USDC and a fresh gas grant was
   * told to go and deposit more USDC. The clause is what disambiguates it:
   * the complaint is about the fee.
   */
  if (/insufficient/i.test(message) && /estimating fee|gas|native/i.test(message)) {
    return insufficientFunds(
      'The agent wallet does not hold enough native currency to pay the gas for this ' +
        'transaction. Send a small amount of it to the wallet address shown in Deposit, ' +
        'on the same network. Nothing was charged.',
    )
  }

  if (/insufficient/i.test(message)) {
    return insufficientFunds(
      'The agent wallet does not hold enough USDC for this transaction and its fee. Top it ' +
        'up from Deposit, checking the network matches, and try again. Nothing was charged.',
    )
  }

  return httpError(400, `This transaction would not succeed: ${message}`)
}

/**
 * A shortfall, carried as a flag rather than left to be read back out of prose.
 *
 * The runner decides whether to abandon a run on this, and it used to decide by
 * matching /insufficient|balance/ against the message. Rewording the message
 * for the user's benefit silently broke that match, and a run whose only step
 * had failed for want of funds went on to finish as "done". Whether a wallet
 * was short of money is a fact about the failure, not a property of the English
 * used to describe it, so it travels as one.
 */
export function insufficientFunds(message: string): Error {
  return httpError(400, message, { reason: INSUFFICIENT_FUNDS })
}

export const INSUFFICIENT_FUNDS = 'insufficient-funds'

/** Whether this failure, or the one it wraps, was a shortfall. */
export function isInsufficientFunds(err: unknown): boolean {
  const details = (err as { details?: Record<string, unknown> } | undefined)?.details
  if (details?.['reason'] === INSUFFICIENT_FUNDS) return true
  // Set by whoever re-threw, when the original could not be carried through.
  return (err as { insufficientFunds?: boolean } | undefined)?.insufficientFunds === true
}

/**
 * Submit a contract call and wait for it to actually land.
 *
 * Returns the on-chain hash. Anything short of COMPLETE throws with a message
 * specific to why, because "it failed" and "compliance refused it" and "your
 * fee was too low" call for three different things from the user.
 */
export async function executeContract(
  call: ContractCall,
  opts: { skipEstimate?: boolean } = {},
): Promise<{ txHash: string; txId: string }> {
  /*
   * Gas before anything else, and before the estimate: an unfunded wallet fails
   * the estimate, so topping up afterwards would be too late. Silent and free
   * when the wallet already has some, which is nearly every call.
   *
   * Every user transaction goes through this function, so this is the one place
   * it has to be. Putting it at the call sites would mean a new on-chain
   * operation could be added without it and nobody would notice until a user
   * with no gas hit that path.
   */
  await ensureGas(call.wallet.address, call.chain)

  if (!opts.skipEstimate) await estimateContractCall(call)

  let txId: string
  try {
    // The same bytes the estimate above was taken against.
    const callData = attributedCallData(call)
    const response = await circleClient(call.wallet.env).createContractExecutionTransaction({
      walletId: call.wallet.walletId,
      contractAddress: call.contractAddress,
      ...(callData
        ? { callData }
        : {
            abiFunctionSignature: call.abiFunctionSignature,
            abiParameters: call.abiParameters as unknown[],
          }),
      ...(call.amount ? { amount: call.amount } : {}),
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
      idempotencyKey: idempotencyKey(),
    } as never)

    const id = response.data?.id
    if (!id) throw new Error('Circle returned no transaction id')
    txId = id
  } catch (err) {
    // Same treatment as the estimate above: a submission can be refused for the
    // same reasons, and the user needs the same instruction either way.
    throw refusalFor(err)
  }

  return { txHash: await awaitTerminal(call.wallet.env, txId), txId }
}

/** How long to wait for a transaction before giving up, and how often to look. */
const POLL_INTERVAL_MS = 2_000
const POLL_TIMEOUT_MS = 180_000

/**
 * Poll to a terminal state and return the transaction hash.
 *
 * Deliberately not the SDK's `waitForState`. That helper rejects on any
 * terminal failure without saying which one, and the difference between them is
 * the entire content of what we owe the user when their payment does not go
 * through.
 */
export async function awaitTerminal(env: CircleEnv, txId: string): Promise<string> {
  const deadline = Date.now() + POLL_TIMEOUT_MS

  for (;;) {
    let state: string
    let txHash: string | undefined
    try {
      const response = await circleClient(env).getTransaction({ id: txId })
      state = response.data?.transaction?.state ?? 'INITIATED'
      txHash = response.data?.transaction?.txHash
    } catch (err) {
      throw httpError(502, `Lost track of the transaction: ${safeErrorMessage(err)}`)
    }

    const verdict = classifyTransactionState(state)
    if (verdict.done) {
      if (verdict.ok) {
        if (!txHash) throw httpError(502, 'The transaction completed without a hash.')
        return txHash
      }
      throw httpError(502, verdict.message)
    }

    if (Date.now() > deadline) {
      /*
       * Not a failure. The transaction may still be working, and saying it
       * failed would invite a retry that double-spends. Say what is true: we
       * stopped watching.
       */
      throw httpError(
        504,
        `The transaction is taking longer than expected and is still in progress (${state}). ` +
          'It has not been cancelled. Check the wallet before retrying, or it may be sent twice.',
      )
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}
