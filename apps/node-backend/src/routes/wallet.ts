import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import { createPublicClient, createWalletClient, http, erc20Abi, parseUnits, isAddress, formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import db from '../db.ts'
import { asyncRoute, httpError } from '../http.ts'
import { currentUser, requireAuth } from '../auth/jwt.ts'
import { findUserById } from '../auth/users.ts'
import { publicUser } from './auth.ts'
import {
  chainConfig,
  gatewayClientFor,
  resolveChain,
  rpcUrlFor,
  safeErrorMessage,
} from '../circle/gatewayService.ts'
import { bridge, bridgeChainOptions, estimateBridge } from '../circle/bridgeService.ts'
import { isValidPrivateKey } from '../auth/keySetup.ts'

const router = Router()

const USDC_DECIMALS = 6
const AmountString = z
  .string()
  .regex(/^\d+(\.\d{1,6})?$/, 'amount must be a decimal string with at most 6 dp')
  .refine((v) => Number(v) > 0, 'amount must be greater than zero')

const KeyString = z.string().refine(isValidPrivateKey, 'agentPrivateKey must be 0x + 64 hex chars')

/** Confirm the supplied key actually controls this account's agent wallet. */
function assertKeyMatchesUser(userId: string, key: `0x${string}`): string {
  const row = findUserById(userId)
  if (!row?.eoa_address) throw httpError(409, 'No agent wallet has been set up for this account')
  const derived = privateKeyToAccount(key).address
  if (derived.toLowerCase() !== row.eoa_address.toLowerCase()) {
    throw httpError(403, 'This key does not match your agent wallet')
  }
  return row.eoa_address
}

/**
 * GET returns the keyless view (on-chain wallet USDC + gas).
 * POST accepts `{ agentPrivateKey }` and additionally resolves the Gateway
 * balance — a browser cannot attach a body to a GET, so the key-bearing variant
 * has to be its own method.
 */
router.all(
  '/balance',
  requireAuth,
  asyncRoute(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
      throw httpError(405, 'Use GET or POST for /wallet/balance')
    }
    const user = currentUser(req)
    const row = findUserById(user.id)
    if (!row?.eoa_address) throw httpError(409, 'No agent wallet has been set up for this account')

    const chain = resolveChain(row.default_chain)
    const config = chainConfig(chain)
    const address = row.eoa_address as `0x${string}`

    const publicClient = createPublicClient({
      chain: config.chain,
      transport: http(rpcUrlFor(chain)),
    })

    // Wallet USDC + native gas are readable from the address alone — no key needed.
    const [usdcRaw, nativeRaw] = await Promise.all([
      publicClient
        .readContract({
          address: config.usdc,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [address],
        })
        .catch(() => 0n),
      publicClient.getBalance({ address }).catch(() => 0n),
    ])

    const walletUsdc = formatUnitsFixed(usdcRaw, USDC_DECIMALS)

    // Gateway balance requires the SDK client, which requires the key.
    let gatewayUsdc: string | null = null
    let gatewayAvailableUsdc: string | null = null
    let gatewayWarning: string | null = null
    const keyResult = z.object({ agentPrivateKey: KeyString }).safeParse(req.body ?? {})

    if (keyResult.success) {
      assertKeyMatchesUser(user.id, keyResult.data.agentPrivateKey as `0x${string}`)
      try {
        const client = gatewayClientFor(keyResult.data.agentPrivateKey, chain)
        const balances = await client.getBalances()
        gatewayUsdc = balances.gateway.formattedTotal
        gatewayAvailableUsdc = balances.gateway.formattedAvailable
      } catch (err) {
        // A Gateway API hiccup shouldn't blank out the on-chain balances.
        // This goes in the body, not a header: SDK messages contain newlines,
        // which make res.setHeader throw ERR_INVALID_CHAR and kill the response.
        gatewayWarning = safeErrorMessage(err).replace(/\s+/g, ' ').slice(0, 300)
      }
    }

    res.json({
      eoaAddress: row.eoa_address,
      chain: row.default_chain,
      chainId: config.chain.id,
      usdcAddress: config.usdc,
      walletUsdc,
      gatewayUsdc,
      gatewayAvailableUsdc,
      gatewayWarning,
      native: formatEther(nativeRaw),
      nativeSymbol: config.chain.nativeCurrency.symbol,
      explorerBase: config.chain.blockExplorers?.default.url ?? null,
    })
  }),
)

function formatUnitsFixed(value: bigint, decimals: number): string {
  const negative = value < 0n
  const abs = negative ? -value : value
  const base = 10n ** BigInt(decimals)
  const whole = abs / base
  const frac = (abs % base).toString().padStart(decimals, '0')
  return `${negative ? '-' : ''}${whole}.${frac}`
}

const GatewayAmountBody = z.object({
  amount: AmountString,
  agentPrivateKey: KeyString,
})

router.post(
  '/gateway/deposit',
  requireAuth,
  asyncRoute(async (req, res) => {
    const user = currentUser(req)
    const parsed = GatewayAmountBody.safeParse(req.body)
    if (!parsed.success) throw httpError(400, parsed.error.issues[0]?.message ?? 'Invalid body')

    const key = parsed.data.agentPrivateKey as `0x${string}`
    assertKeyMatchesUser(user.id, key)

    const row = findUserById(user.id)!
    const client = gatewayClientFor(key, resolveChain(row.default_chain))

    try {
      const result = await client.deposit(parsed.data.amount)
      const balances = await client.getBalances()
      res.json({
        success: true,
        depositTxHash: result.depositTxHash,
        approvalTxHash: result.approvalTxHash ?? null,
        amount: result.formattedAmount,
        newGatewayBalance: balances.gateway.formattedTotal,
      })
    } catch (err) {
      throw httpError(502, `Gateway deposit failed: ${safeErrorMessage(err)}`)
    }
  }),
)

router.post(
  '/gateway/withdraw',
  requireAuth,
  asyncRoute(async (req, res) => {
    const user = currentUser(req)
    const parsed = GatewayAmountBody.safeParse(req.body)
    if (!parsed.success) throw httpError(400, parsed.error.issues[0]?.message ?? 'Invalid body')

    const key = parsed.data.agentPrivateKey as `0x${string}`
    assertKeyMatchesUser(user.id, key)

    const row = findUserById(user.id)!
    const client = gatewayClientFor(key, resolveChain(row.default_chain))

    try {
      // Same-chain withdrawal is instant; no 7-day trustless path involved.
      const result = await client.withdraw(parsed.data.amount)
      const balances = await client.getBalances()
      res.json({
        success: true,
        mintTxHash: result.mintTxHash,
        amount: result.formattedAmount,
        newGatewayBalance: balances.gateway.formattedTotal,
        newWalletUsdc: balances.wallet.formatted,
      })
    } catch (err) {
      throw httpError(502, `Gateway withdrawal failed: ${safeErrorMessage(err)}`)
    }
  }),
)

const CryptoWithdrawBody = z.object({
  toAddress: z.string().refine(isAddress, 'toAddress must be a valid EVM address'),
  amount: AmountString,
  agentPrivateKey: KeyString,
})

router.post(
  '/withdraw/crypto',
  requireAuth,
  asyncRoute(async (req, res) => {
    const user = currentUser(req)
    const parsed = CryptoWithdrawBody.safeParse(req.body)
    if (!parsed.success) throw httpError(400, parsed.error.issues[0]?.message ?? 'Invalid body')

    const key = parsed.data.agentPrivateKey as `0x${string}`
    assertKeyMatchesUser(user.id, key)

    const row = findUserById(user.id)!
    const chain = resolveChain(row.default_chain)
    const config = chainConfig(chain)
    const account = privateKeyToAccount(key)

    const walletClient = createWalletClient({
      account,
      chain: config.chain,
      transport: http(rpcUrlFor(chain)),
    })
    const publicClient = createPublicClient({
      chain: config.chain,
      transport: http(rpcUrlFor(chain)),
    })

    try {
      const value = parseUnits(parsed.data.amount, USDC_DECIMALS)
      const { request } = await publicClient.simulateContract({
        account,
        address: config.usdc,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [parsed.data.toAddress as `0x${string}`, value],
      })
      const txHash = await walletClient.writeContract(request)
      res.json({ txHash, explorerBase: config.chain.blockExplorers?.default.url ?? null })
    } catch (err) {
      throw httpError(502, `Withdrawal failed: ${safeErrorMessage(err)}`)
    }
  }),
)

const BridgeBody = z.object({
  fromChain: z.string().min(1),
  toChain: z.string().min(1),
  amount: AmountString,
  agentPrivateKey: KeyString,
  toAddress: z.string().refine(isAddress, 'toAddress must be a valid EVM address').optional(),
})

router.post(
  '/bridge',
  requireAuth,
  asyncRoute(async (req, res) => {
    const user = currentUser(req)
    const parsed = BridgeBody.safeParse(req.body)
    if (!parsed.success) throw httpError(400, parsed.error.issues[0]?.message ?? 'Invalid body')

    const key = parsed.data.agentPrivateKey as `0x${string}`
    assertKeyMatchesUser(user.id, key)

    const result = await bridge({
      fromChain: parsed.data.fromChain,
      toChain: parsed.data.toChain,
      amount: parsed.data.amount,
      fromPrivateKey: key,
      ...(parsed.data.toAddress ? { toAddress: parsed.data.toAddress } : {}),
    })
    res.json(result)
  }),
)

router.post(
  '/bridge/estimate',
  requireAuth,
  asyncRoute(async (req, res) => {
    const user = currentUser(req)
    const parsed = BridgeBody.omit({ toAddress: true }).safeParse(req.body)
    if (!parsed.success) throw httpError(400, parsed.error.issues[0]?.message ?? 'Invalid body')

    const key = parsed.data.agentPrivateKey as `0x${string}`
    assertKeyMatchesUser(user.id, key)

    res.json(
      await estimateBridge({
        fromChain: parsed.data.fromChain,
        toChain: parsed.data.toChain,
        amount: parsed.data.amount,
        fromPrivateKey: key,
      }),
    )
  }),
)

router.get('/deposit-address', requireAuth, (req, res) => {
  const row = findUserById(currentUser(req).id)
  if (!row?.eoa_address) {
    res.status(409).json({ error: 'No agent wallet has been set up for this account' })
    return
  }
  const chain = resolveChain(row.default_chain)
  res.json({
    address: row.eoa_address,
    chain: row.default_chain,
    chainId: chainConfig(chain).chain.id,
    bridgeChains: bridgeChainOptions(),
    /**
     * ASSUMPTION #6 resolved: Circle exposes no public API for minting a fiat
     * onramp URL against an arbitrary destination address. On testnet the
     * faucet is the supported way to fund an address.
     */
    fiatOnramp: {
      available: false,
      testnetFaucetUrl: 'https://faucet.circle.com',
      note: 'Fiat onramp requires Circle Liquidity Services with a separate API key. On testnet, use the Circle faucet or transfer USDC from another wallet.',
    },
  })
})

const CapBody = z.object({ cap: z.number().positive().max(100_000) })

const setSpendingCap: RequestHandler = (req, res) => {
  const user = currentUser(req)
  const parsed = CapBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'cap must be a positive number' })
    return
  }
  db.prepare('UPDATE users SET spending_cap_usdc = ? WHERE id = ?').run(parsed.data.cap, user.id)
  res.json({ ok: true, newCap: parsed.data.cap, user: publicUser(findUserById(user.id)!) })
}

router.patch('/user/spending-cap', requireAuth, setSpendingCap)

/** Mounted at /api/user so the spec'd PATCH /api/user/spending-cap also resolves. */
export const userRoutes = Router()
userRoutes.patch('/spending-cap', requireAuth, setSpendingCap)

export default router
