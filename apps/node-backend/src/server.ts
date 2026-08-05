import express, { type NextFunction, type Request, type Response } from 'express'
import cors from 'cors'
import { ALLOWED_ORIGINS, IS_PROD, PORT, isOriginAllowed } from './env.ts'
import { messageOf, statusOf } from './http.ts'
import { scrubSecrets } from './circle/gatewayService.ts'
import { STORAGE_PERSISTENT } from './db.ts'
import authRoutes from './routes/auth.ts'
import serviceRoutes from './routes/services.ts'
import agentRoutes from './routes/agent.ts'
import walletRoutes, { userRoutes } from './routes/wallet.ts'
import taskRoutes from './routes/tasks.ts'

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
})

// SSE runs can outlive a default timeout; disable it and manage lifetime in the runner.
server.requestTimeout = 0
server.headersTimeout = 0

export default app
