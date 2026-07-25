import express, { type NextFunction, type Request, type Response } from 'express'
import cors from 'cors'
import { FRONTEND_URL, IS_PROD, PORT } from './env.ts'
import { messageOf, statusOf } from './http.ts'
import { scrubSecrets } from './circle/gatewayService.ts'
import authRoutes from './routes/auth.ts'
import serviceRoutes from './routes/services.ts'
import agentRoutes from './routes/agent.ts'
import walletRoutes, { userRoutes } from './routes/wallet.ts'
import taskRoutes from './routes/tasks.ts'

const app = express()

app.set('trust proxy', 1)
app.use(
  cors({
    origin: IS_PROD ? [FRONTEND_URL] : true,
    credentials: true,
  }),
)
app.use(express.json({ limit: '1mb' }))

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'trident-backend', version: '1.0.0' })
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
})

// SSE runs can outlive a default timeout; disable it and manage lifetime in the runner.
server.requestTimeout = 0
server.headersTimeout = 0

export default app
