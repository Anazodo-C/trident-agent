import { Router } from 'express'
import { asyncRoute, httpError } from '../http.ts'
import { currentUser, requireAuth } from '../auth/jwt.ts'
import { findUserById } from '../auth/users.ts'
import {
  categories,
  searchServices,
  syncRegistry,
  syncStatus,
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
    // Default view is what this wallet can actually pay for; `all=1` shows the
    // whole registry so nothing is hidden, just marked unpayable.
    const showAll = req.query['all'] === '1'
    const limit = Math.min(Number(req.query['limit'] ?? 24) || 24, MAX_LIMIT)
    const offset = Math.max(Number(req.query['offset'] ?? 0) || 0, 0)

    const result = searchServices({
      query,
      curatedOnly,
      ...(showAll ? {} : { chains: policy.allowed }),
      limit,
      offset,
    })

    const services = result.services.map((s) => {
      const choice = chooseChain(s.networks, policy)
      return {
        ...s,
        payable: choice !== null,
        payChain: choice?.chain ?? null,
        payPriceUsdc: choice?.priceUsdc ?? s.priceUsdc,
        payIsTestnet: choice?.isTestnet ?? false,
        blockedReason: choice ? null : unpayableReason(s.networks, policy),
      }
    })

    res.json({
      services,
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
