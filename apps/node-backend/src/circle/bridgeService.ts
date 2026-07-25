import { BridgeKit } from '@circle-fin/bridge-kit'
import { createViemAdapterFromPrivateKey } from '@circle-fin/adapter-viem-v2'
import { httpError } from '../http.ts'
import { isValidPrivateKey } from '../auth/keySetup.ts'
import { safeErrorMessage } from './gatewayService.ts'

/**
 * NOTE: the build prompt assumed `createBridgeClient({ privateKey, sourceChain })`
 * with a `.transfer()` method. That API does not exist in @circle-fin/bridge-kit
 * (verified against v1.12.1). The real surface is `new BridgeKit()` plus
 * `kit.bridge({ from, to, amount })` with an adapter from
 * @circle-fin/adapter-viem-v2, which is what this module implements.
 */

/** Chain labels the deposit UI may offer, mapped to BridgeKit chain identifiers. */
export const BRIDGE_CHAINS = {
  'ARC-TESTNET': 'Arc_Testnet',
  'BASE-SEPOLIA': 'Base_Sepolia',
  'ETHEREUM-SEPOLIA': 'Ethereum_Sepolia',
  'ARBITRUM-SEPOLIA': 'Arbitrum_Sepolia',
  'AVALANCHE-FUJI': 'Avalanche_Fuji',
  'OPTIMISM-SEPOLIA': 'Optimism_Sepolia',
  'POLYGON-AMOY': 'Polygon_Amoy_Testnet',
  'UNICHAIN-SEPOLIA': 'Unichain_Sepolia',
  'MONAD-TESTNET': 'Monad_Testnet',
  'LINEA-SEPOLIA': 'Linea_Sepolia',
} as const

export type BridgeChainLabel = keyof typeof BRIDGE_CHAINS
/** Literal union BridgeKit accepts, e.g. 'Arc_Testnet'. */
export type BridgeChainId = (typeof BRIDGE_CHAINS)[BridgeChainLabel]

export function isBridgeChainLabel(value: string): value is BridgeChainLabel {
  return Object.hasOwn(BRIDGE_CHAINS, value)
}

export function bridgeChainOptions(): { label: BridgeChainLabel; chain: string }[] {
  return (Object.keys(BRIDGE_CHAINS) as BridgeChainLabel[]).map((label) => ({
    label,
    chain: BRIDGE_CHAINS[label],
  }))
}

function resolve(label: string): BridgeChainId {
  if (!isBridgeChainLabel(label)) {
    throw httpError(
      400,
      `Unsupported bridge chain '${label}'. Supported: ${Object.keys(BRIDGE_CHAINS).join(', ')}`,
    )
  }
  return BRIDGE_CHAINS[label]
}

export interface BridgeOutcome {
  state: 'pending' | 'success' | 'error'
  txHash: string | null
  steps: { name: string; state: string; txHash?: string; explorerUrl?: string }[]
  estimatedArrivalSeconds: number
}

/** CCTP fast transfers usually settle well inside this; used only for UI copy. */
const ESTIMATED_ARRIVAL_SECONDS = 120

export async function bridge(params: {
  fromChain: string
  toChain: string
  amount: string
  fromPrivateKey: string
  toAddress?: string
}): Promise<BridgeOutcome> {
  const { fromChain, toChain, amount, fromPrivateKey, toAddress } = params

  if (!isValidPrivateKey(fromPrivateKey)) {
    throw httpError(400, 'agentPrivateKey must be a 0x-prefixed 32-byte hex string')
  }
  if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) {
    throw httpError(400, 'amount must be a positive decimal string, e.g. "10.5"')
  }

  const from = resolve(fromChain)
  const to = resolve(toChain)
  if (from === to) throw httpError(400, 'Source and destination chains must differ')

  const adapter = createViemAdapterFromPrivateKey({ privateKey: fromPrivateKey })
  const kit = new BridgeKit()

  try {
    const result = await kit.bridge({
      from: { adapter, chain: from },
      to: toAddress
        ? { adapter, chain: to, recipientAddress: toAddress }
        : { adapter, chain: to },
      amount,
    })

    const steps = result.steps.map((s) => ({
      name: s.name,
      state: s.state,
      ...(s.txHash ? { txHash: s.txHash } : {}),
      ...(s.explorerUrl ? { explorerUrl: s.explorerUrl } : {}),
    }))

    // The burn on the source chain is what the user needs to track.
    const burn = result.steps.find((s) => /burn/i.test(s.name) && s.txHash)
    const anyHash = result.steps.find((s) => s.txHash)

    return {
      state: result.state,
      txHash: burn?.txHash ?? anyHash?.txHash ?? null,
      steps,
      estimatedArrivalSeconds: ESTIMATED_ARRIVAL_SECONDS,
    }
  } catch (err) {
    throw httpError(502, `Bridge failed: ${safeErrorMessage(err)}`)
  }
}

export async function estimateBridge(params: {
  fromChain: string
  toChain: string
  amount: string
  fromPrivateKey: string
}): Promise<{ fees: unknown[]; gasFees: unknown[] }> {
  if (!isValidPrivateKey(params.fromPrivateKey)) {
    throw httpError(400, 'agentPrivateKey must be a 0x-prefixed 32-byte hex string')
  }
  const adapter = createViemAdapterFromPrivateKey({ privateKey: params.fromPrivateKey })
  const kit = new BridgeKit()
  try {
    const estimate = await kit.estimate({
      from: { adapter, chain: resolve(params.fromChain) },
      to: { adapter, chain: resolve(params.toChain) },
      amount: params.amount,
    })
    return { fees: estimate.fees ?? [], gasFees: estimate.gasFees ?? [] }
  } catch (err) {
    throw httpError(502, `Bridge estimate failed: ${safeErrorMessage(err)}`)
  }
}
