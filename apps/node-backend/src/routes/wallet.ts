import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import { createPublicClient, http, erc20Abi, parseUnits, isAddress, formatEther } from 'viem'
import db from '../db.ts'
import { asyncRoute, httpError } from '../http.ts'
import { currentUser, requireAuth } from '../auth/jwt.ts'
import { findUserById } from '../auth/users.ts'
import { publicUser } from './auth.ts'
import {
  chainConfig,
  chainLabel,
  readOnlyGatewayClient,
  rpcUrlFor,
  strictChain,
  safeErrorMessage,
  unifiedGatewayBalance,
  walletUsdcByChain,
  spendableTotalUsdc,
} from '../circle/gatewayService.ts'
import { GATEWAY_MAINNET_CHAINS, policyFor } from '../circle/chainPolicy.ts'
import { canBridgeTo } from '../circle/deployments.ts'
import { executeContract, walletForChain } from '../circle/circleWallets.ts'
import { depositToGateway, withdrawFromGateway } from '../circle/gatewayMoves.ts'
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

/**
 * The chains a user actually funds, for the UI to enumerate.
 *
 * Deliberately NOT `policy.allowed`. That is the set the agent may *settle* on,
 * which since mainnet opt-in became every Gateway domain — eleven of them — and
 * the wallet page rendered a chip and a balance card, with its own RPC call, for
 * each. Twelve networks to manage, for a product whose whole point is that the
 * user does not think about chains.
 *
 * Settling and funding are different questions. The agent picks the settlement
 * chain per invoice and bridges when the money is elsewhere; none of that needs
 * a user-facing list. What a user genuinely chooses between is the testnet and
 * the mainnet chains we can both deposit to and bridge from, which is exactly
 * what DEPLOYMENTS records.
 */
function walletChains(row: UserRow): SupportedChainName[] {
  const policy = policyFor(row)
  if (!policy.mainnetEnabled) return [policy.testnet]

  const fundable = GATEWAY_MAINNET_CHAINS.filter((chain) => canBridgeTo(chain))
  // The funding chain leads, so the UI's default mainnet selection is the one
  // deposits and withdrawals actually land on.
  const ordered = policy.fundingChain
    ? [policy.fundingChain, ...fundable.filter((c) => c !== policy.fundingChain)]
    : fundable
  return [policy.testnet, ...ordered]
}

const USDC_DECIMALS = 6
const AmountString = z
  .string()
  .regex(/^\d+(\.\d{1,6})?$/, 'amount must be a decimal string with at most 6 dp')
  .refine((v) => Number(v) > 0, 'amount must be greater than zero')


/**
 * Balances for this account, on the requested chain.
 *
 * GET and POST both work and both do the same thing now. They used to differ
 * because the Gateway balance needed a private key in a body and a browser
 * cannot attach one to a GET. Reading a Gateway balance never actually required
 * the key, only the address, so the distinction is gone; both methods are kept
 * so existing callers do not break.
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
    /*
     * The Circle wallet once there is one, the old EOA until then.
     *
     * A user part way through migration still holds funds at the old address,
     * and showing them a zero balance because we read only the new one would
     * look exactly like their money had vanished.
     */
    const address = (row.circle_wallet_address ?? row.eoa_address) as `0x${string}`

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

    /*
     * Read the Gateway balance without the user's key.
     *
     * getBalances() takes the address to query, so the client's own signer is
     * irrelevant for a read. This used to demand an unlocked wallet, which
     * meant someone could not see their own Gateway balance without typing
     * their passphrase — and a balance sitting at "locked" is indistinguishable
     * from a balance sitting at zero, which is exactly the wrong thing to be
     * ambiguous about while waiting on a deposit.
     */
    let gatewayUsdc: string | null = null
    let gatewayAvailableUsdc: string | null = null
    let gatewayWarning: string | null = null
    /*
     * The Gateway ledger summed across every mainnet domain.
     *
     * Not the same as what is deposited on this chain, and no longer the same
     * as what is spendable either: the agent moves funds to whichever chain an
     * invoice names, so both pots on every chain are reachable. See
     * spendableUsdc below, which is the figure the user should be shown.
     */
    let gatewaySpendableUsdc: string | null = null
    /*
     * One number for the whole of mainnet: every chain, both pots.
     *
     * This is what the agent can spend, because the funding ladder reaches all
     * of it. Splitting it into per-chain, per-pot figures asks the user to
     * understand a routing problem the product exists to hide, and each part on
     * its own understates what they can afford.
     */
    let walletAcrossChainsUsdc: string | null = null
    let spendableUsdc: string | null = null

    {
      try {
        const balances = await readOnlyGatewayClient(chain).getBalances(address)
        gatewayUsdc = balances.gateway.formattedTotal
        gatewayAvailableUsdc = balances.gateway.formattedAvailable

        // Mainnet and testnet ledgers are separate; ask about the side this
        // chain is on. A failure here must not take the per-chain figure down
        // with it, so it is caught separately.
        const peers = config.chain.testnet === true ? [chain] : GATEWAY_MAINNET_CHAINS
        gatewaySpendableUsdc = await unifiedGatewayBalance(address, peers)
          .then((unified) => unified.totalUsdc)
          .catch(() => null)

        /*
         * The wallet side of the same question, then the two added together.
         *
         * Summed in atomic units. Adding the decimal strings as floats is how a
         * balance acquires a rounding error, and this figure is what the user
         * reads before deciding whether they can afford a run.
         */
        const walletByChain = await walletUsdcByChain(address, peers).catch(() => null)
        const totals = spendableTotalUsdc(walletByChain, gatewaySpendableUsdc)
        if (totals) {
          walletAcrossChainsUsdc = totals.walletAcrossChains
          spendableUsdc = totals.spendable
        }
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
      gatewaySpendableUsdc,
      walletAcrossChainsUsdc,
      spendableUsdc,
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

    const row = findUserById(user.id)!
    const chain = walletChain(row, parsed.data.chain)
    const wallet = walletForChain(row, chain)

    try {
      const result = await depositToGateway(wallet, chain, parsed.data.amount)
      const balances = await readOnlyGatewayClient(chain).getBalances(wallet.address)
      res.json({
        success: true,
        depositTxHash: result.depositTxHash,
        approvalTxHash: result.approvalTxHash,
        amount: result.amountUsdc,
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

    const row = findUserById(user.id)!
    const chain = walletChain(row, parsed.data.chain)
    const wallet = walletForChain(row, chain)

    try {
      // Same-chain withdrawal is instant; no 7-day trustless path involved.
      const result = await withdrawFromGateway(wallet, chain, { amountUsdc: parsed.data.amount })
      const balances = await readOnlyGatewayClient(chain).getBalances(wallet.address)
      res.json({
        success: true,
        mintTxHash: result.mintTxHash,
        amount: result.amountUsdc,
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
  chain: z.string().optional(),
})

router.post(
  '/withdraw/crypto',
  requireAuth,
  asyncRoute(async (req, res) => {
    const user = currentUser(req)
    const parsed = CryptoWithdrawBody.safeParse(req.body)
    if (!parsed.success) throw httpError(400, parsed.error.issues[0]?.message ?? 'Invalid body')

    const row = findUserById(user.id)!
    const chain = walletChain(row, parsed.data.chain)
    const wallet = walletForChain(row, chain)
    const config = chainConfig(chain)

    try {
      const value = parseUnits(parsed.data.amount, USDC_DECIMALS)
      /*
       * `executeContract` estimates before it submits, which is what
       * `simulateContract` was doing here: refuse a transfer that cannot
       * succeed rather than spend gas discovering it.
       */
      const { txHash } = await executeContract({
        wallet,
        contractAddress: config.usdc,
        abiFunctionSignature: 'transfer(address,uint256)',
        abiParameters: [parsed.data.toAddress, value.toString()],
      })
      res.json({ txHash, explorerBase: config.chain.blockExplorers?.default.url ?? null })
    } catch (err) {
      throw httpError(502, `Withdrawal failed: ${safeErrorMessage(err)}`)
    }
  }),
)

/*
 * The manual bridge routes are gone.
 *
 * They went through BridgeKit, whose `bridge()` takes a `fromPrivateKey` and
 * accepts only testnet chain labels, so on mainnet they could return nothing
 * but a 400. Their only caller was the deposit panel's manual move, which was
 * removed once that was established. Keeping a key-accepting endpoint alive for
 * a flow that cannot work is the exact surface this change exists to close.
 *
 * Cross-chain movement now happens through TridentCctpRouter, which the agent
 * drives itself at payment time.
 */


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
    /**
     * ASSUMPTION #6 resolved: Circle exposes no public API for minting a fiat
     * onramp URL against an arbitrary destination address. On testnet the
     * faucet is the supported way to fund an address.
     */
    /*
     * Named for what it is. This was `fiatOnramp`, which promised a card-to-
     * USDC flow the product does not have — Circle exposes no public API for
     * minting an onramp URL against an arbitrary address, and adding one needs
     * Liquidity Services and a separate key. What we actually offer is the
     * faucet, so the field says faucet.
     */
    faucet: {
      testnetFaucetUrl: 'https://faucet.circle.com',
      note: 'Fund this wallet from the Circle faucet on testnet, or send USDC to the address above from any wallet. Card payments are not supported yet.',
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
