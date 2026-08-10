import type { SupportedChainName } from '@circle-fin/x402-batching/client'

/**
 * Trident's own deployed contracts, per chain.
 *
 * These addresses are load-bearing and must not be regenerated. Every user's
 * receiver address is derived from `receiverFactory`, so a redeployment moves
 * every one of them — and USDC already in flight to an old address would land
 * at a contract the new factory cannot sweep, recoverable only by the user
 * calling `rescue()` on the old receiver.
 *
 * Deployed 2026-08-10 from 0x3315ebaab06d6266e92f6063b9360ae10d24F0a0 and
 * verified by reading each contract back: token, gateway and messenger all
 * match the chain they sit on.
 *
 * The two addresses being identical across chains is a coincidence of the
 * deployer having the same nonce on both — a CREATE address depends on the
 * deployer and nonce, not on the bytecode or constructor arguments. Do not rely
 * on it. The next chain will almost certainly differ, which is why this is a
 * map rather than a pair of constants.
 */
export interface ChainDeployment {
  /** Derives each user's {TridentGatewayReceiver}. Never redeploy. */
  receiverFactory: `0x${string}`
  /** {TridentCctpRouter}, the CCTP burn entry point. Safe to redeploy. */
  cctpRouter: `0x${string}`
  /** CCTP domain, which matches Gateway's numbering. */
  domain: number
}

export const DEPLOYMENTS: Partial<Record<SupportedChainName, ChainDeployment>> = {
  base: {
    receiverFactory: '0x7922c3D703671E833b3707EA22406ab7bFc04454',
    cctpRouter: '0xEc8106E86DB58166d42Ceb32f148b9CF980bd6e0',
    domain: 6,
  },
  polygon: {
    receiverFactory: '0x7922c3D703671E833b3707EA22406ab7bFc04454',
    cctpRouter: '0xEc8106E86DB58166d42Ceb32f148b9CF980bd6e0',
    domain: 7,
  },
}

/**
 * Circle's TokenMessengerV2. The same proxy address on every chain checked so
 * far, both resolving to implementation 0x555e2725…3ec8.
 *
 * Taken from chain state, not from Circle's address list, which names a
 * contract carrying neither CCTP selector — building against it would have
 * reverted every burn.
 */
export const TOKEN_MESSENGER_V2 = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d' as const

/** True when cross-chain settlement can be routed to this chain. */
export function canBridgeTo(chain: SupportedChainName): boolean {
  return DEPLOYMENTS[chain] !== undefined
}
