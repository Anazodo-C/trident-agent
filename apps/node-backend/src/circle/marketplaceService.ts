/**
 * Service catalog for the agent planner.
 *
 * Circle's marketplace (https://agents.circle.com/services) has no public JSON
 * API — the page is a client-rendered Next.js app and `/api/*` returns 404 for
 * every discovery path. So the catalog is maintained here.
 *
 * IMPORTANT: entries carry a `verification` status. Nothing in this file is
 * treated as callable just because it is listed. `probeService()` performs a
 * live x402 handshake, and `GET /api/services?probe=1` surfaces the result so
 * the UI can warn before a user authorises spending against a dead endpoint.
 */

export type Verification = 'verified-x402' | 'unverified' | 'unreachable'

export interface Service {
  id: string
  name: string
  description: string
  category: string
  baseUrl: string
  endpoints: string[]
  priceRangeUsdc: string
  provider: '1P' | '3P'
  tags: string[]
  /** Live-probe status as of the last `probe=1` call; static default otherwise. */
  verification: Verification
  /** Shown in the UI next to unverified services. */
  note?: string
}

const UNVERIFIED_NOTE =
  'Listing not yet confirmed as a live x402 endpoint. Probe before spending.'

export const SERVICE_CATALOG: Service[] = [
  {
    id: 'x402-demo',
    name: 'x402 Reference Endpoint',
    description:
      'Circle/Coinbase x402 reference resource. Confirmed live 402 handshake — use this to verify your agent wallet can pay before trying paid services.',
    category: 'DEMO',
    baseUrl: 'https://x402.org',
    endpoints: ['/protected'],
    priceRangeUsdc: '$0.01',
    provider: '1P',
    tags: ['demo', 'test', 'x402', 'verify'],
    verification: 'verified-x402',
  },
  {
    id: 'exa-search',
    name: 'Exa Web Search',
    description: 'Real-time neural web search and full content retrieval.',
    category: 'WEB_SEARCH_RESEARCH',
    baseUrl: 'https://api.exa.ai',
    endpoints: ['/search', '/contents'],
    priceRangeUsdc: '$0.01–$0.05',
    provider: '3P',
    tags: ['search', 'research', 'web', 'content'],
    verification: 'unverified',
    note: UNVERIFIED_NOTE,
  },
  {
    id: 'stable-enrich',
    name: 'StableEnrich',
    description: 'Company and person enrichment — funding, revenue, team, social.',
    category: 'FINANCIAL_ANALYSIS',
    baseUrl: 'https://stableenrich.dev',
    endpoints: ['/enrich/company', '/enrich/person'],
    priceRangeUsdc: '$0.05–$0.20',
    provider: '3P',
    tags: ['enrichment', 'company', 'bd', 'research'],
    verification: 'unverified',
    note: UNVERIFIED_NOTE,
  },
  {
    id: 'stable-domains',
    name: 'StableDomains',
    description: 'Domain availability and pricing across TLDs.',
    category: 'DEVELOPER_TOOLS',
    baseUrl: 'https://stabledomains.dev',
    endpoints: ['/check', '/suggestions'],
    priceRangeUsdc: '$0.10–$0.50',
    provider: '3P',
    tags: ['domains', 'dns', 'startup', 'naming'],
    verification: 'unverified',
    note: UNVERIFIED_NOTE,
  },
  {
    id: 'goldsky',
    name: 'Goldsky Subgraph',
    description: 'Onchain data via GraphQL — token prices, DEX trades, wallet history.',
    category: 'BLOCKCHAIN_DATA',
    baseUrl: 'https://api.goldsky.com',
    endpoints: ['/subgraphs/query'],
    priceRangeUsdc: '$0.01–$0.10',
    provider: '3P',
    tags: ['blockchain', 'defi', 'onchain', 'data'],
    verification: 'unverified',
    note: UNVERIFIED_NOTE,
  },
  {
    id: 'bland-voice',
    name: 'Bland.ai Voice Calls',
    description: 'AI-powered phone calls — briefings, interviews, outreach.',
    category: 'COMMUNICATION',
    baseUrl: 'https://api.bland.ai',
    endpoints: ['/v1/calls'],
    priceRangeUsdc: '$1.00–$10.00',
    provider: '3P',
    tags: ['voice', 'phone', 'ai call', 'outreach'],
    verification: 'unverified',
    note: UNVERIFIED_NOTE,
  },
  // 'x-data' (x402.x.com) from the original spec is intentionally absent:
  // the domain does not resolve, so it can never be a callable service.
]

export const CATEGORIES = [...new Set(SERVICE_CATALOG.map((s) => s.category))].sort()

export function searchServices(query = '', category?: string): Service[] {
  let results = SERVICE_CATALOG
  if (category) results = results.filter((s) => s.category === category)
  if (query) {
    const q = query.toLowerCase()
    results = results.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some((t) => t.includes(q)),
    )
  }
  return results
}

/**
 * Exact full-URL match, NOT a prefix test.
 *
 * A `startsWith(baseUrl)` check would accept `https://x402.org.evil.com/drain`
 * for a catalog entry whose baseUrl is `https://x402.org` — a lookalike host
 * would then receive a signed payment.
 */
export function findServiceByEndpoint(endpointUrl: string): Service | undefined {
  return SERVICE_CATALOG.find((s) =>
    s.endpoints.some((path) => `${s.baseUrl}${path}` === endpointUrl),
  )
}

/** True when the endpoint is an exact catalogued URL — the runner's allowlist. */
export function isCataloguedEndpoint(endpointUrl: string): boolean {
  return findServiceByEndpoint(endpointUrl) !== undefined
}

/**
 * Live x402 handshake: an unauthenticated request should answer 402 and carry
 * payment requirements. Anything else means the endpoint is not payable.
 */
export async function probeEndpoint(url: string, timeoutMs = 8000): Promise<Verification> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal })
    if (res.status !== 402) return 'unverified'
    const hasRequirements =
      res.headers.has('payment-required') || res.headers.has('www-authenticate')
    if (hasRequirements) return 'verified-x402'
    // Some servers put the requirements in the body instead of a header.
    const body = await res.text()
    return body.includes('accepts') || body.includes('x402Version')
      ? 'verified-x402'
      : 'unverified'
  } catch {
    return 'unreachable'
  } finally {
    clearTimeout(timer)
  }
}

/** Probe every endpoint of a service; best status wins. */
export async function probeService(service: Service): Promise<Verification> {
  const results = await Promise.all(
    service.endpoints.map((path) => probeEndpoint(`${service.baseUrl}${path}`)),
  )
  if (results.includes('verified-x402')) return 'verified-x402'
  if (results.every((r) => r === 'unreachable')) return 'unreachable'
  return 'unverified'
}

export async function probeAll(services: Service[]): Promise<Service[]> {
  return Promise.all(
    services.map(async (s) => ({ ...s, verification: await probeService(s) })),
  )
}
