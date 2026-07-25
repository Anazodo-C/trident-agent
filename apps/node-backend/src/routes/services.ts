import { Router } from 'express'
import { asyncRoute } from '../http.ts'
import { requireAuth } from '../auth/jwt.ts'
import { CATEGORIES, probeAll, searchServices } from '../circle/marketplaceService.ts'

const router = Router()

router.get(
  '/',
  requireAuth,
  asyncRoute(async (req, res) => {
    const q = typeof req.query['q'] === 'string' ? req.query['q'] : ''
    const category = typeof req.query['category'] === 'string' ? req.query['category'] : undefined
    const services = searchServices(q, category)

    // Opt-in: the live handshake adds seconds, so the grid loads without it.
    if (req.query['probe'] === '1') {
      res.json({ services: await probeAll(services), categories: CATEGORIES, probed: true })
      return
    }
    res.json({ services, categories: CATEGORIES, probed: false })
  }),
)

export default router
