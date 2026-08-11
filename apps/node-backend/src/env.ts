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
export function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback
}

/** Every variable this service reads. Used only to report presence, never values. */
const KNOWN_VARS = [
  'JWT_SECRET',
  'ANTHROPIC_API_KEY',
  'FRONTEND_URL',
  'DB_PATH',
  'PORT',
  'NODE_ENV',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
] as const

/**
 * "Missing X" alone can't distinguish a typo from variables attached to the
 * wrong service or environment, which is a slow thing to debug on a platform.
 * So report which of the known names the process actually received.
 *
 * Names only — a value is never printed, and this says nothing about any
 * variable outside KNOWN_VARS.
 */
function diagnostics(): string {
  const set = KNOWN_VARS.filter((n) => (process.env[n] ?? '') !== '')
  const missing = KNOWN_VARS.filter((n) => (process.env[n] ?? '') === '')
  return [
    `  received (names only): ${set.length > 0 ? set.join(', ') : '(none)'}`,
    `  not set:               ${missing.length > 0 ? missing.join(', ') : '(none)'}`,
    `  total env vars visible to the process: ${Object.keys(process.env).length}`,
    '  If the name you set is absent above, it is attached to a different',
    '  service or environment, or spelled differently.',
  ].join('\n')
}

function required(name: string, devFallback?: string): string {
  const v = process.env[name]
  if (v && v.length > 0) return v
  if (devFallback !== undefined && process.env['NODE_ENV'] !== 'production') {
    return devFallback
  }
  throw new Error(`Missing required environment variable: ${name}\n${diagnostics()}`)
}

export const NODE_ENV = optional('NODE_ENV', 'development')
export const IS_PROD = NODE_ENV === 'production'
export const PORT = Number(optional('PORT', '3001'))
/**
 * Canonical frontend origin. OAuth callbacks redirect here, so it must be the
 * one address users should end up on — a custom domain in production, not a
 * per-deployment preview URL.
 */
export const FRONTEND_URL = optional('FRONTEND_URL', 'http://localhost:5173')

/**
 * Extra origins allowed through CORS, comma-separated. FRONTEND_URL is always
 * allowed and need not be repeated.
 *
 * One origin is not enough in practice: the app is reachable at its custom
 * domain and at Vercel deployment URLs, and Vercel mints a fresh preview URL
 * for every deployment. Pinning a single origin means CORS breaks on each
 * deploy.
 *
 * An entry may start with `*` to match by suffix, e.g. `*-trident8.vercel.app`
 * covers every preview for that team. Keep such patterns narrow — a bare
 * `*.vercel.app` would let any site hosted on Vercel call this API.
 */
export const ALLOWED_ORIGINS: string[] = Array.from(
  new Set(
    [FRONTEND_URL, ...optional('ALLOWED_ORIGINS').split(',')]
      .map((o) => o.trim().replace(/\/$/, ''))
      .filter((o) => o.length > 0),
  ),
)

export function isOriginAllowed(origin: string): boolean {
  const candidate = origin.replace(/\/$/, '')
  return ALLOWED_ORIGINS.some((allowed) =>
    allowed.startsWith('*') ? candidate.endsWith(allowed.slice(1)) : allowed === candidate,
  )
}

/** Dev fallback keeps local runs frictionless; production must set a real secret. */
export const JWT_SECRET = required('JWT_SECRET', 'dev-only-insecure-secret-do-not-use-in-prod')

export const GOOGLE_CLIENT_ID = optional('GOOGLE_CLIENT_ID')
export const GOOGLE_CLIENT_SECRET = optional('GOOGLE_CLIENT_SECRET')

/**
 * Must exactly match an Authorized redirect URI on the Google OAuth client.
 *
 * The localhost fallback is for local development only. Using it in production
 * silently sends users to a redirect_uri that can never match a registered one,
 * and Google's redirect_uri_mismatch error does not say why — so a deployment
 * with Google enabled and this unset is a hard failure, not a default.
 */
const googleRedirectUriRaw = optional('GOOGLE_REDIRECT_URI')
export const GOOGLE_ENABLED = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET)

if (GOOGLE_ENABLED && IS_PROD && !googleRedirectUriRaw) {
  throw new Error(
    'GOOGLE_REDIRECT_URI must be set when Google sign-in is enabled in production.\n' +
      '  It must exactly match an Authorized redirect URI on the OAuth client,\n' +
      '  and points at this backend, e.g. https://<backend-host>/auth/google/callback',
  )
}

export const GOOGLE_REDIRECT_URI =
  googleRedirectUriRaw || `http://localhost:${PORT}/auth/google/callback`

export const ANTHROPIC_API_KEY = optional('ANTHROPIC_API_KEY')
export const ANTHROPIC_ENABLED = Boolean(ANTHROPIC_API_KEY)

/**
 * Where to send Messages API calls.
 *
 * Empty means Anthropic directly. Set it to use an Anthropic-compatible
 * gateway (AgentRouter, OpenRouter, a self-hosted proxy) — those issue their
 * own keys, which api.anthropic.com rejects, so the key and the base URL have
 * to travel together.
 *
 * The SDK appends /v1/messages, so this is the origin: https://agentrouter.org
 */
export const ANTHROPIC_BASE_URL = optional('ANTHROPIC_BASE_URL').replace(/\/+$/, '')

/** Overridable because gateways do not always expose Anthropic's model ids. */
export const ANTHROPIC_MODEL = optional('ANTHROPIC_MODEL', 'claude-haiku-4-5-20251001')

function anthropicHost(url: string): string {
  if (!url) return 'api.anthropic.com'
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return url.toLowerCase()
  }
}

/** Where Messages API calls actually land, for the boot log. */
export const ANTHROPIC_HOST = anthropicHost(ANTHROPIC_BASE_URL)

/**
 * An Anthropic-issued key (sk-ant-) aimed at a third-party gateway is almost
 * always a leftover base URL from a previous setup — and it is the kind of
 * mistake that is invisible in behaviour but sends every prompt, and the key
 * itself, somewhere it was not meant to go. Say so at boot.
 *
 * The test is the host, not whether the variable is set: pointing explicitly at
 * api.anthropic.com is direct, and warning about it would be crying wolf in the
 * logs every boot.
 */
export const ANTHROPIC_KEY_MISDIRECTED =
  ANTHROPIC_HOST !== 'api.anthropic.com' && ANTHROPIC_API_KEY.startsWith('sk-ant-')

/**
 * Whether to run continuous reachability probes over the catalog.
 *
 * On in production, off in development by default. The prober makes real
 * outbound requests to third-party providers around the clock; having every
 * developer's laptop add its own stream of them to the sellers the agent
 * depends on is the wrong default. Set STATUS_PROBER=on to run it locally,
 * or =off to silence it in production.
 */
export const STATUS_PROBER_ENABLED =
  optional('STATUS_PROBER', IS_PROD ? 'on' : 'off').toLowerCase() === 'on'

export const DB_PATH = optional('DB_PATH', './trident.db')

/**
 * Key for SQLCipher whole-file encryption of the database.
 *
 * The database holds every user's encrypted wallet key alongside its salt and
 * IV, which is a complete offline cracking target if the file ever escapes.
 * Encrypting the file means a stolen volume snapshot or a leaked backup is
 * useless without this value.
 *
 * It defends against the file leaking. It does NOT defend against anyone who
 * can read this environment — they can read the key and the database with it.
 * Keep it in the platform's secret store and out of the repo.
 */
export const DB_ENCRYPTION_KEY = optional('DB_ENCRYPTION_KEY')

/**
 * Signs the destination half of a cross-chain settlement.
 *
 * A user paying a seller on a chain they have never used has no native token
 * there, so they cannot submit the CCTP mint or credit their own Gateway
 * ledger. This key does both on their behalf and pays that gas.
 *
 * It is not a custody key and must never hold user funds. The mint is directed
 * at a receiver contract derived from the user, which can only credit that
 * user's Gateway balance or refund them — so this key moves other people's
 * money along a path it cannot redirect. It needs a small native balance on
 * every chain settlement may land on, and nothing else.
 *
 * Unset simply disables cross-chain settlement; single-chain payments are
 * unaffected.
 */
export const KEEPER_PRIVATE_KEY = optional('KEEPER_PRIVATE_KEY')
