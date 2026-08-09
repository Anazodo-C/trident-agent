import { Router } from 'express'
import { asyncRoute, httpError } from '../http.ts'
import { currentUser, requireAuth } from '../auth/jwt.ts'
import { findUserById } from '../auth/users.ts'
import {
  categories,
  searchServices,
  syncRegistry,
  syncStatus,
  type ServiceSource,
} from '../circle/registryService.ts'
import { chooseChain, policyFor, unpayableReason } from '../circle/chainPolicy.ts'

const router = Router()

const MAX_LIMIT = 60

router.get(
  '/',
  requireAuth,
  asyncRoute(async (req, res) => {
    const user = currentUser(req)
    const fresh = findUserById(user.id)
    if (!fresh) throw httpError(401, 'User no longer exists')
    const policy = policyFor(fresh)

    const query = typeof req.query['q'] === 'string' ? req.query['q'] : ''
    const curatedOnly = req.query['curated'] === '1'
    // 'free'  → public APIs, metered by an Arc Testnet verification payment.
    // 'x402'  → paid services, mostly mainnet.
    // absent  → both. x402 entries are always listed even when this wallet
    //           cannot settle them; they are marked blocked rather than hidden.
    const sourceParam = req.query['source']
    const source =
      sourceParam === 'free' || sourceParam === 'x402' ? (sourceParam as ServiceSource) : undefined
    const limit = Math.min(Number(req.query['limit'] ?? 24) || 24, MAX_LIMIT)
    const offset = Math.max(Number(req.query['offset'] ?? 0) || 0, 0)

    const result = searchServices({
      query,
      curatedOnly,
      ...(source ? { source } : {}),
      limit,
      offset,
    })

    const services = result.services.map((s) => {
      const choice = chooseChain(s.networks, policy, { gatewayOnly: s.source === 'x402' })
      return {
        ...s,
        payable: choice !== null,
        payChain: choice?.chain ?? null,
        payPriceUsdc: choice?.priceUsdc ?? s.priceUsdc,
        payIsTestnet: choice?.isTestnet ?? false,
        blockedReason: choice ? null : unpayableReason(s.networks, policy),
      }
    })

    // Counts for the filter chips, so each tab can show its own size.
    const counts = {
      free: searchServices({ query, curatedOnly, source: 'free', limit: 1 }).total,
      x402: searchServices({ query, curatedOnly, source: 'x402', limit: 1 }).total,
    }

    res.json({
      services,
      counts,
      total: result.total,
      limit,
      offset,
      categories: offset === 0 ? categories() : [],
      mainnetEnabled: policy.mainnetEnabled,
      sync: syncStatus(),
    })
  }),
)

router.get('/sync', requireAuth, (_req, res) => {
  res.json(syncStatus())
})

/**
 * Manual refresh. The registry also syncs on boot and on a timer; this exists
 * so a user who knows a service was just published does not have to wait.
 */
router.post(
  '/sync',
  requireAuth,
  asyncRoute(async (_req, res) => {
    const result = await syncRegistry()
    res.json({ ok: true, ...result, ...syncStatus() })
  }),
)

export default router
