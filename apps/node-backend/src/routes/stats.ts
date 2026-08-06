import { Router } from 'express'
import { currentUser, requireAuth } from '../auth/jwt.ts'
import { buildStats } from '../analytics/statsService.ts'

const router = Router()

/**
 * Usage statistics.
 *
 * Defaults to the requesting user's own activity. `scope=global` returns
 * platform-wide figures — deliberately readable by any signed-in user, since it
 * exposes only counts and totals, never another user's goals, wallets or
 * results.
 */
router.get('/', requireAuth, (req, res) => {
  const user = currentUser(req)
  const global = req.query['scope'] === 'global'
  const days = Math.min(Math.max(Number(req.query['days'] ?? 30) || 30, 1), 365)

  res.json({
    scope: global ? 'global' : 'me',
    days,
    ...buildStats(global ? null : user.id, days),
  })
})

export default router
