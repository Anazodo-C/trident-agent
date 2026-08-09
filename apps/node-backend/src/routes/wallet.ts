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
  chainLabel,
  gatewayClientFor,
  resolveChain,
  rpcUrlFor,
  strictChain,
  safeErrorMessage,
} from '../circle/gatewayService.ts'
import { bridge, bridgeChainOptions, estimateBridge } from '../circle/bridgeService.ts'
import { isValidPrivateKey } from '../auth/keySetup.ts'
import { policyFor } from '../circle/chainPolicy.ts'
import type { SupportedChainName } from '@circle-fin/x402-batching/client'
import type { UserRow } from '../db.ts'

const router = Router()

/**
 * Which chain a wallet operation acts on.
 *
 * Was `users.default_chain`, which is set once at signup and never changes —
 * so enabling mainnet moved where the runner *pays* (it asks the chain policy)
 * without moving where deposits *land*. Real USDC would have gone into the Arc
 * Testnet Gateway while every mainnet call failed for want of balance.
 *
 * Now the caller says which chain it means, and the answer is checked against
 * the same policy the runner uses. Omitting it keeps the safe default: testnet.
 */
function walletChain(row: UserRow, requested?: string | null): SupportedChainName {
  const policy = policyFor(row)
  if (!requested) return policy.testnet

  const chain = strictChain(requested)
  if (!policy.allowed.includes(chain)) {
    throw httpError(
      403,
      policy.mainnetEnabled
        ? `${requested} is not a chain this account can use.`
        : `${requested} is a mainnet chain. Enable mainnet spending in Wallet first.`,
    )
  }
  return chain
}

/** The chains this account may operate on, for the UI to enumerate. */
function walletChains(row: UserRow): SupportedChainName[] {
  return policyFor(row).allowed
}

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

    // ?chain= on GET, or { chain } in the POST body.
    const requestedChain =
      (typeof req.query['chain'] === 'string' ? req.query['chain'] : null) ??
      (typeof (req.body as { chain?: unknown } | undefined)?.chain === 'string'
        ? ((req.body as { chain: string }).chain)
        : null)
    const chain = walletChain(row, requestedChain)
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
      // The chain this balance is FOR — not the stored default, which is set
      // once at signup and would misreport every explicit request.
      chain,
      chainId: config.chain.id,
      isTestnet: config.chain.testnet === true,
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
  /** Omit for testnet. Validated against the account's chain policy. */
  chain: z.string().optional(),
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
    const client = gatewayClientFor(key, walletChain(row, parsed.data.chain))

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
    const client = gatewayClientFor(key, walletChain(row, parsed.data.chain))

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
  chain: z.string().optional(),
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
    const chain = walletChain(row, parsed.data.chain)
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
  const requested = typeof req.query['chain'] === 'string' ? req.query['chain'] : null
  const chain = walletChain(row, requested)
  res.json({
    address: row.eoa_address,
    chain,
    chainId: chainConfig(chain).chain.id,
    /**
     * One key, one address, every EVM chain — but the deposit has to land on
     * the chain the agent will actually spend from, so the caller needs to
     * know which ones this account can use.
     */
    availableChains: walletChains(row).map((c) => ({
      chain: c,
      // Both forms: the bridge options and default_chain speak labels, the
      // balance and Gateway routes speak SDK keys.
      label: chainLabel(c),
      chainId: chainConfig(c).chain.id,
      isTestnet: chainConfig(c).chain.testnet === true,
    })),
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

const MainnetBody = z.object({
  enabled: z.boolean(),
  chain: z.enum(['BASE', 'ARC']).optional(),
})

/**
 * Mainnet spending is opt-in and off by default.
 *
 * Until this is on, the agent can only settle with testnet funds, so an
 * approved plan can never cost real money. Turning it on is the moment
 * autonomous execution starts spending actual USDC, so it is a deliberate,
 * separate action rather than a side effect of funding a wallet.
 */
router.patch('/user/mainnet', requireAuth, (req, res) => {
  const user = currentUser(req)
  const parsed = MainnetBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'enabled must be a boolean' })
    return
  }
  db.prepare('UPDATE users SET mainnet_enabled = ?, mainnet_chain = ? WHERE id = ?').run(
    parsed.data.enabled ? 1 : 0,
    parsed.data.chain ?? 'BASE',
    user.id,
  )
  const row = findUserById(user.id)!
  res.json({
    ok: true,
    mainnetEnabled: row.mainnet_enabled === 1,
    mainnetChain: row.mainnet_chain,
    user: publicUser(row),
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
