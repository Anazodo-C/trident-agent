import type {
  BudgetGuidance,
  ChatMessage,
  PlanCosting,
  ShowcaseCard,
  StatusSnapshot,
  DepositInfo,
  ExecutionPlan,
  KeyMaterial,
  RegistrySync,
  Service,
  Stats,
  StepAnnotation,
  StepUpgrade,
  TaskStepDetail,
  TaskSummary,
  User,
  WalletBalance,
} from './types.ts'

/**
 * Backend origin.
 *
 * Empty in development, where Vite proxies /api and /auth to localhost:3001.
 * In production the backend is a separate deployment (Railway), so
 * VITE_API_BASE_URL must be set at build time or every request 404s.
 */
export const API_BASE = (import.meta.env['VITE_API_BASE_URL'] ?? '').replace(/\/$/, '')

/** Absolute URL for a backend path. */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Set by authStore so request() doesn't need the token threaded through every call. */
let authToken: string | null = null
export function setAuthToken(token: string | null): void {
  authToken = token
}
export function getAuthToken(): string | null {
  return authToken
}

async function request<T>(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<T> {
  const { token, ...rest } = init
  const headers = new Headers(rest.headers)
  headers.set('Content-Type', 'application/json')
  const bearer = token ?? authToken
  if (bearer) headers.set('Authorization', `Bearer ${bearer}`)

  const res = await fetch(apiUrl(path), { ...rest, headers })
  const text = await res.text()
  const body: unknown = text ? safeJson(text) : null

  if (!res.ok) {
    const message =
      (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : null) ?? `Request failed (${res.status})`
    throw new ApiError(message, res.status)
  }

  // A 2xx that isn't JSON is not a valid response, and must not be handed back
  // as `null`: callers dereference these objects, so a silent null becomes a
  // render crash far from the cause.
  //
  // The common case: API_BASE is empty in a deployed build, so the request goes
  // to the frontend's own origin and the SPA rewrite answers 200 text/html.
  if (text && body === null) {
    const contentType = res.headers.get('content-type') ?? 'unknown'
    throw new ApiError(
      API_BASE
        ? `Expected JSON from ${path} but received ${contentType}.`
        : `Expected JSON from ${path} but received ${contentType}. ` +
          'The frontend has no backend URL configured. Set VITE_API_BASE_URL and rebuild.',
      res.status,
    )
  }
  return body as T
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export const api = {
  authProviders: () => request<{ google: boolean; siwe: boolean }>('/auth/providers'),

  me: (token?: string) =>
    request<{ user: User }>('/auth/me', token ? { token } : {}),

  siweNonce: () => request<{ nonce: string }>('/auth/siwe/nonce'),

  siweVerify: (message: string, signature: string) =>
    request<
      | { needsSetup: true; setupToken: string }
      | { needsSetup: false; token: string; user: User }
    >('/auth/siwe/verify', {
      method: 'POST',
      body: JSON.stringify({ message, signature }),
    }),

  setupPassphrase: (passphrase: string, setupToken: string) =>
    request<{ token: string; user: User }>('/auth/setup-passphrase', {
      method: 'POST',
      body: JSON.stringify({ passphrase }),
      token: setupToken,
    }),

  keyMaterial: () => request<KeyMaterial>('/auth/key-material'),

  /** Store a re-encrypted key at a higher iteration count. Ciphertext only. */
  rotateKdf: (payload: {
    encryptedKey: string
    salt: string
    iv: string
    iterations: number
    signature: string
  }) =>
    request<{ ok: boolean; iterations: number }>('/auth/rotate-kdf', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  services: (opts: {
    q?: string
    curated?: boolean
    source?: 'free' | 'x402'
    limit?: number
    offset?: number
  } = {}) => {
    const params = new URLSearchParams()
    if (opts.q) params.set('q', opts.q)
    if (opts.curated) params.set('curated', '1')
    if (opts.source) params.set('source', opts.source)
    if (opts.limit) params.set('limit', String(opts.limit))
    if (opts.offset) params.set('offset', String(opts.offset))
    const qs = params.toString()
    return request<{
      services: Service[]
      counts: { free: number; x402: number }
      total: number
      limit: number
      offset: number
      categories: string[]
      mainnetEnabled: boolean
      sync: RegistrySync
    }>(`/api/services${qs ? `?${qs}` : ''}`)
  },

  stats: (scope: 'me' | 'global' = 'global', days = 30) =>
    request<Stats>(`/api/stats?scope=${scope}&days=${days}`),

  syncRegistry: () => request<RegistrySync>('/api/services/sync', { method: 'POST' }),

  plan: (goal: string, budgetUsdc?: number) =>
    request<{
      taskId: string
      plan: ExecutionPlan
      annotations: Record<number, StepAnnotation>
      /** Path values the goal never supplied, per step index, the card asks for these. */
      needsInput: Record<number, string[]>
      upgrades: StepUpgrade[]
      costing: PlanCosting
      affordable: boolean
      budgetGuidance: BudgetGuidance | null
      candidatesConsidered: number
      usedFallback: boolean
      mainnetEnabled: boolean
    }>('/api/agent/plan', {
      method: 'POST',
      body: JSON.stringify(budgetUsdc !== undefined ? { goal, budgetUsdc } : { goal }),
    }),

  setMainnet: (enabled: boolean, chain: 'BASE' | 'ARC' = 'BASE') =>
    request<{ ok: boolean; mainnetEnabled: boolean; mainnetChain: string; user: User }>(
      '/api/wallet/user/mainnet',
      { method: 'PATCH', body: JSON.stringify({ enabled, chain }) },
    ),

  stop: (taskId: string) =>
    request<{ ok: boolean; note: string }>('/api/agent/stop', {
      method: 'POST',
      body: JSON.stringify({ taskId }),
    }),

  tasks: () => request<{ tasks: TaskSummary[] }>('/api/tasks'),

  /** Public, the landing page calls this before anyone has signed in. */
  showcase: () => request<{ cards: ShowcaseCard[] }>('/api/showcase'),

  /** Public reachability data. No auth, the status page is read by anyone. */
  status: () => request<StatusSnapshot>('/api/status'),

  chat: (taskId: string, message: string) =>
    request<{
      userMessage: ChatMessage
      agentMessage: ChatMessage
      needsRun: boolean
      suggestedGoal?: string
    }>('/api/agent/chat', { method: 'POST', body: JSON.stringify({ taskId, message }) }),

  chatHistory: (taskId: string) =>
    request<{ messages: ChatMessage[] }>(`/api/agent/chat/${taskId}`),

  task: (id: string) =>
    request<{ task: TaskSummary; steps: TaskStepDetail[] }>(`/api/tasks/${id}`),

  // `chain` is optional everywhere and defaults to testnet server-side. It is
  // validated against the account's policy, so asking for mainnet without
  // opting in is a 403 rather than a silent testnet operation.
  balance: (agentPrivateKey?: string, chain?: string) =>
    agentPrivateKey
      ? request<WalletBalance>('/api/wallet/balance', {
          method: 'POST',
          body: JSON.stringify({ agentPrivateKey, ...(chain ? { chain } : {}) }),
        })
      : request<WalletBalance>(
          `/api/wallet/balance${chain ? `?chain=${encodeURIComponent(chain)}` : ''}`,
        ),

  depositInfo: (chain?: string) =>
    request<DepositInfo>(
      `/api/wallet/deposit-address${chain ? `?chain=${encodeURIComponent(chain)}` : ''}`,
    ),

  gatewayDeposit: (amount: string, agentPrivateKey: string, chain?: string) =>
    request<{ success: boolean; depositTxHash: string; newGatewayBalance: string }>(
      '/api/wallet/gateway/deposit',
      { method: 'POST', body: JSON.stringify({ amount, agentPrivateKey, ...(chain ? { chain } : {}) }) },
    ),

  gatewayWithdraw: (amount: string, agentPrivateKey: string, chain?: string) =>
    request<{ success: boolean; mintTxHash: string; newGatewayBalance: string }>(
      '/api/wallet/gateway/withdraw',
      { method: 'POST', body: JSON.stringify({ amount, agentPrivateKey, ...(chain ? { chain } : {}) }) },
    ),

  withdrawCrypto: (toAddress: string, amount: string, agentPrivateKey: string, chain?: string) =>
    request<{ txHash: string; explorerBase: string | null }>('/api/wallet/withdraw/crypto', {
      method: 'POST',
      body: JSON.stringify({ toAddress, amount, agentPrivateKey, ...(chain ? { chain } : {}) }),
    }),

  bridge: (payload: {
    fromChain: string
    toChain: string
    amount: string
    agentPrivateKey: string
  }) =>
    request<{ state: string; txHash: string | null; estimatedArrivalSeconds: number }>(
      '/api/wallet/bridge',
      { method: 'POST', body: JSON.stringify(payload) },
    ),

  setSpendingCap: (cap: number) =>
    request<{ ok: boolean; newCap: number; user: User }>('/api/wallet/user/spending-cap', {
      method: 'PATCH',
      body: JSON.stringify({ cap }),
    }),
}
