import type {
  DepositInfo,
  ExecutionPlan,
  KeyMaterial,
  Service,
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
  // as `null` — callers dereference these objects, so a silent null becomes a
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
          'The frontend has no backend URL configured — set VITE_API_BASE_URL and rebuild.',
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

  services: (q = '', category = '', probe = false) => {
    const params = new URLSearchParams()
    if (q) params.set('q', q)
    if (category) params.set('category', category)
    if (probe) params.set('probe', '1')
    const qs = params.toString()
    return request<{ services: Service[]; categories: string[]; probed: boolean }>(
      `/api/services${qs ? `?${qs}` : ''}`,
    )
  },

  plan: (goal: string, budgetUsdc?: number) =>
    request<{ taskId: string; plan: ExecutionPlan }>('/api/agent/plan', {
      method: 'POST',
      body: JSON.stringify(budgetUsdc !== undefined ? { goal, budgetUsdc } : { goal }),
    }),

  stop: (taskId: string) =>
    request<{ ok: boolean; note: string }>('/api/agent/stop', {
      method: 'POST',
      body: JSON.stringify({ taskId }),
    }),

  tasks: () => request<{ tasks: TaskSummary[] }>('/api/tasks'),

  task: (id: string) =>
    request<{ task: TaskSummary; steps: TaskStepDetail[] }>(`/api/tasks/${id}`),

  balance: (agentPrivateKey?: string) =>
    agentPrivateKey
      ? request<WalletBalance>('/api/wallet/balance', {
          method: 'POST',
          body: JSON.stringify({ agentPrivateKey }),
        })
      : request<WalletBalance>('/api/wallet/balance'),

  depositInfo: () => request<DepositInfo>('/api/wallet/deposit-address'),

  gatewayDeposit: (amount: string, agentPrivateKey: string) =>
    request<{ success: boolean; depositTxHash: string; newGatewayBalance: string }>(
      '/api/wallet/gateway/deposit',
      { method: 'POST', body: JSON.stringify({ amount, agentPrivateKey }) },
    ),

  gatewayWithdraw: (amount: string, agentPrivateKey: string) =>
    request<{ success: boolean; mintTxHash: string; newGatewayBalance: string }>(
      '/api/wallet/gateway/withdraw',
      { method: 'POST', body: JSON.stringify({ amount, agentPrivateKey }) },
    ),

  withdrawCrypto: (toAddress: string, amount: string, agentPrivateKey: string) =>
    request<{ txHash: string; explorerBase: string | null }>('/api/wallet/withdraw/crypto', {
      method: 'POST',
      body: JSON.stringify({ toAddress, amount, agentPrivateKey }),
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
