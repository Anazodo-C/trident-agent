import express, { type NextFunction, type Request, type Response } from 'express'
import cors from 'cors'
import {
  ALLOWED_ORIGINS,
  ANTHROPIC_ENABLED,
  ANTHROPIC_HOST,
  ANTHROPIC_KEY_MISDIRECTED,
  ANTHROPIC_MODEL,
  IS_PROD,
  PORT,
  isOriginAllowed,
} from './env.ts'
import { messageOf, statusOf } from './http.ts'
import { scrubSecrets } from './circle/gatewayService.ts'
import { STORAGE_PERSISTENT } from './db.ts'
import {
  catalogNeedsRebuild,
  syncFreeApis,
  syncRegistry,
  syncStatus,
} from './circle/registryService.ts'
import authRoutes from './routes/auth.ts'
import serviceRoutes from './routes/services.ts'
import agentRoutes from './routes/agent.ts'
import walletRoutes, { userRoutes } from './routes/wallet.ts'
import taskRoutes from './routes/tasks.ts'
import statsRoutes from './routes/stats.ts'
import showcaseRoutes from './routes/showcase.ts'
import statusRoutes from './routes/status.ts'
import { startProber } from './circle/statusProber.ts'

const app = express()

app.set('trust proxy', 1)
app.use(
  cors({
    // Production is restricted to the configured origins; dev reflects any.
    // A request with no Origin header (curl, health checks, server-to-server)
    // is not subject to CORS and must not be rejected here.
    origin: IS_PROD
      ? (origin, callback) => callback(null, !origin || isOriginAllowed(origin))
      : true,
    credentials: true,
  }),
)
app.use(express.json({ limit: '1mb' }))

app.get('/health', (_req, res) => {
  // storagePersistent reports whether the SQLite file is on a mounted volume.
  // A boolean only — no paths — so the mount can be confirmed without shell
  // access, and a misconfigured deploy is visible before anyone signs up.
  res.json({
    ok: true,
    service: 'trident-backend',
    version: '1.0.0',
    storagePersistent: STORAGE_PERSISTENT,
  })
})

app.use('/auth', authRoutes)
app.use('/api/services', serviceRoutes)
app.use('/api/agent', agentRoutes)
app.use('/api/wallet', walletRoutes)
app.use('/api/user', userRoutes)
app.use('/api/tasks', taskRoutes)
app.use('/api/stats', statsRoutes)
// Public: read by anonymous visitors on the landing page, before any sign-in.
app.use('/api/showcase', showcaseRoutes)
// Public: the status subdomain, which must answer without an account.
app.use('/api/status', statusRoutes)

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' })
})

app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  const status = statusOf(err)
  if (status >= 500) {
    // scrubSecrets guarantees an EOA key can never reach the logs via an SDK error.
    console.error('[trident] unhandled error:', scrubSecrets(String(err)))
  }
  if (res.headersSent) {
    // An SSE stream is already open — emit a terminal event instead of a status code.
    if (!res.writableEnded) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: messageOf(err) })}\n\n`)
      res.end()
    }
    next(err)
    return
  }
  res.status(status).json({ error: messageOf(err) })
})

const server = app.listen(PORT, () => {
  console.log(`[trident] backend listening on :${PORT} (${IS_PROD ? 'production' : 'development'})`)
  if (IS_PROD) {
    // A browser on an unlisted origin is blocked outright, and the failure
    // surfaces in the frontend as "cannot reach backend" — so state the
    // allowlist at boot rather than leaving it to be inferred.
    console.log(`[trident] CORS allows: ${ALLOWED_ORIGINS.join(', ')}`)
  }

  // Which model endpoint is actually in use. Worth one line at boot: a stale
  // gateway URL changes nothing visible until an answer is wrong or a key is
  // somewhere it should not be.
  if (ANTHROPIC_ENABLED) {
    console.log(`[trident] model ${ANTHROPIC_MODEL} via ${ANTHROPIC_HOST}`)
    if (ANTHROPIC_KEY_MISDIRECTED) {
      console.warn(
        [
          '',
          '  ┌─────────────────────────────────────────────────────────────────┐',
          '  │  WARNING: an Anthropic key is being sent to a third party.      │',
          '  └─────────────────────────────────────────────────────────────────┘',
          '  ANTHROPIC_API_KEY starts with sk-ant- (issued by Anthropic) but',
          `  requests are being sent to ${ANTHROPIC_HOST}, so every prompt and`,
          '  the key itself go there instead of api.anthropic.com.',
          '  Unset ANTHROPIC_BASE_URL to talk to Anthropic directly.',
          '',
        ].join('\n'),
      )
    }
  } else {
    console.warn('[trident] ANTHROPIC_API_KEY is not set — planning is disabled')
  }
})

// SSE runs can outlive a default timeout; disable it and manage lifetime in the runner.
server.requestTimeout = 0
server.headersTimeout = 0

/**
 * Keep the service registry fresh so newly published x402 services appear
 * without a redeploy. Synced on boot when empty or stale, then on a timer.
 * Failures are logged and retried on the next tick — a stale catalog is far
 * better than a backend that will not start.
 */
const REGISTRY_REFRESH_MS = 6 * 60 * 60 * 1000
const REGISTRY_STALE_SECONDS = 12 * 60 * 60

function refreshRegistry(force = false): void {
  // Free APIs are local static data, so they are written every boot rather than
  // waiting on the remote refresh below — otherwise a deploy that changes the
  // list leaves production without it until the 6-hour timer fires.
  try {
    const count = syncFreeApis()
    console.log(`[trident] free API catalog: ${count} services`)
  } catch (err) {
    console.error('[trident] free API catalog failed:', String(err))
  }

  const status = syncStatus()
  const age = status.completedAt ? Math.floor(Date.now() / 1000) - status.completedAt : Infinity
  /*
   * Age is the weakest of the three gates and cannot be the only one.
   *
   * A catalog is equally stale when it came from another provider, and when
   * this build reads fields the rows were never written with — editing the code
   * does not make the data any older. That second case went unnoticed for a
   * day: input_schema landed one commit after the source switch, so every
   * deploy found a catalog under twelve hours old from an unchanged source and
   * skipped the sync. The 6-hour forced refresh would have caught it, except
   * each deploy restarts the process and resets that timer, and we were
   * deploying far more often than that.
   */
  if (!force && !catalogNeedsRebuild() && status.serviceCount > 0 && age < REGISTRY_STALE_SECONDS) {
    return
  }
  syncRegistry().catch(() => undefined)
}

setTimeout(() => refreshRegistry(), 2_000).unref()
setInterval(() => refreshRegistry(true), REGISTRY_REFRESH_MS).unref()

/*
 * Reachability probing starts after the first registry sync has had time to
 * land. Starting it alongside would have it walking whatever the catalog looked
 * like before the sync, and on a cold boot that is an empty table.
 */
setTimeout(() => startProber(), 30_000).unref()

export default app
