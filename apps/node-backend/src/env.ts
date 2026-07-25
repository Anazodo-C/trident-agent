import { config as loadDotenv } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// The monorepo keeps a single .env at the root, but the backend runs from
// apps/node-backend, so dotenv's cwd default would miss it. Load the local file
// first (it wins), then fall back to the root one.
const here = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: resolve(here, '../.env') })
loadDotenv({ path: resolve(here, '../../../.env') })

/**
 * Central env access. Values are read by name only — the .env file itself is
 * never read, written, or logged by application code.
 */
function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback
}

function required(name: string, devFallback?: string): string {
  const v = process.env[name]
  if (v && v.length > 0) return v
  if (devFallback !== undefined && process.env['NODE_ENV'] !== 'production') {
    return devFallback
  }
  throw new Error(`Missing required environment variable: ${name}`)
}

export const NODE_ENV = optional('NODE_ENV', 'development')
export const IS_PROD = NODE_ENV === 'production'
export const PORT = Number(optional('PORT', '3001'))
export const FRONTEND_URL = optional('FRONTEND_URL', 'http://localhost:5173')

/** Dev fallback keeps local runs frictionless; production must set a real secret. */
export const JWT_SECRET = required('JWT_SECRET', 'dev-only-insecure-secret-do-not-use-in-prod')

export const GOOGLE_CLIENT_ID = optional('GOOGLE_CLIENT_ID')
export const GOOGLE_CLIENT_SECRET = optional('GOOGLE_CLIENT_SECRET')
export const GOOGLE_REDIRECT_URI = optional(
  'GOOGLE_REDIRECT_URI',
  `http://localhost:${PORT}/auth/google/callback`,
)
export const GOOGLE_ENABLED = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET)

export const ANTHROPIC_API_KEY = optional('ANTHROPIC_API_KEY')
export const ANTHROPIC_ENABLED = Boolean(ANTHROPIC_API_KEY)

export const DB_PATH = optional('DB_PATH', './trident.db')
