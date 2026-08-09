import db, { type ServiceRow } from '../db.ts'
import { rowToService, type Service } from './registryService.ts'
import type { SupportedChainName } from '@circle-fin/x402-batching/client'

/**
 * Candidate retrieval for the planner.
 *
 * The registry holds ~14k services, which cannot go in a prompt. So the goal is
 * matched against the local mirror first and only a shortlist reaches the
 * model. Ranking is deliberately biased toward services that are curated or
 * demonstrably used, because the planner is spending the user's money — but
 * nothing is excluded on those grounds, so an obscure service can still win if
 * it is the only real match.
 */

const DEFAULT_LIMIT = 40

/** Words that carry no retrieval signal in a goal sentence. */
const STOPWORDS = new Set([
  'a','an','and','are','as','at','be','but','by','can','could','do','does','find','for','from',
  'get','give','has','have','how','i','if','in','into','is','it','its','me','my','of','on','or',
  'out','please','should','so','some','tell','that','the','their','them','then','there','these',
  'they','this','to','up','use','using','want','was','we','what','when','where','which','who',
  'why','will','with','would','you','your','about','need','make','show','list','all','top','best',
])

export function extractTerms(goal: string): string[] {
  const words = goal
    .toLowerCase()
    .replace(/[^a-z0-9\s.-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))

  // Preserve order but drop duplicates; earlier words tend to be the subject.
  return [...new Set(words)].slice(0, 12)
}

export interface CandidateOptions {
  /** Chains the user can actually settle on right now. */
  chains: SupportedChainName[]
  limit?: number
}

/**
 * Score a service against the goal's terms.
 *
 * Name and tag hits outrank description hits: a service called "Domains" is a
 * better answer to a domain question than one that merely mentions domains in
 * prose. Usage and curation act as tie-breakers, not gates.
 */
function scoreOf(service: Service, terms: string[]): number {
  const name = service.serviceName.toLowerCase()
  const host = service.host.toLowerCase()
  const description = service.description.toLowerCase()
  const tags = service.tags.map((t) => t.toLowerCase())

  let score = 0
  for (const term of terms) {
    if (name.includes(term)) score += 10
    if (tags.some((t) => t.includes(term))) score += 8
    if (host.includes(term)) score += 4
    if (description.includes(term)) score += 3
  }
  if (score === 0) return 0

  if (service.curated) score += 12
  // Usage is a strong quality signal but must not swamp relevance, so it is
  // compressed logarithmically.
  score += Math.min(10, Math.log10(service.calls30d + 1) * 3)
  if (service.trust === 'untested') score -= 2

  return score
}

export interface CandidateSet {
  services: Service[]
  /** True when nothing matched and we fell back to generally-good services. */
  fallback: boolean
  termsUsed: string[]
}

export function selectCandidates(goal: string, options: CandidateOptions): CandidateSet {
  const { chains, limit = DEFAULT_LIMIT } = options
  const terms = extractTerms(goal)

  if (chains.length === 0) return { services: [], fallback: false, termsUsed: terms }

  const chainClauses = chains.map((c, i) => `networks_json LIKE @c${i}`).join(' OR ')
  const chainParams = Object.fromEntries(chains.map((c, i) => [`c${i}`, `%"chainKey":"${c}"%`]))

  // Pull a generous pool matching any term, then rank in memory. SQL LIKE is
  // cheap at this table size and avoids depending on an FTS build.
  let pool: ServiceRow[] = []
  if (terms.length > 0) {
    const termClauses = terms
      .map(
        (_, i) =>
          `(service_name LIKE @t${i} OR tags LIKE @t${i} OR description LIKE @t${i} OR host LIKE @t${i})`,
      )
      .join(' OR ')
    const termParams = Object.fromEntries(terms.map((t, i) => [`t${i}`, `%${t}%`]))

    pool = db
      .prepare(
        `SELECT * FROM services
         WHERE (${chainClauses}) AND (${termClauses})
         ORDER BY curated DESC, calls_30d DESC
         LIMIT 400`,
      )
      .all({ ...chainParams, ...termParams }) as ServiceRow[]
  }

  const scored = pool
    .map((row) => {
      const service = rowToService(row)
      return { service, score: scoreOf(service, terms) }
    })
    .filter((s) => s.score > 0 && isPayable(s.service, chains))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.service)

  if (scored.length > 0) {
    return { services: scored, fallback: false, termsUsed: terms }
  }

  // Nothing matched — hand the model the most credible services available so it
  // can still reason about whether any of them fit, rather than nothing at all.
  const fallbackRows = db
    .prepare(
      `SELECT * FROM services
       WHERE ${chainClauses}
       ORDER BY curated DESC, calls_30d DESC
       LIMIT @limit`,
    )
    .all({ ...chainParams, limit }) as ServiceRow[]

  return {
    services: fallbackRows.map(rowToService).filter((s) => isPayable(s, chains)),
    fallback: true,
    termsUsed: terms,
  }
}

/**
 * Can the agent actually pay this service?
 *
 * The chain filter above is necessary but nowhere near sufficient. Gateway
 * settles only `batch-settlement` authorisations, and of the 13,824 services
 * advertising Base mainnet, 51 offer one. Handing the planner the other 13,773
 * means it proposes a plan, the user approves it, and the run dies on "No
 * Gateway batching option available for network eip155:8453" — after they have
 * already said yes.
 *
 * Free services are exempt: they are metered by a direct Arc Testnet transfer
 * and carry the `verification` scheme, never touching Gateway.
 */
function isPayable(service: Service, chains: SupportedChainName[]): boolean {
  if (service.source === 'free') return true
  return service.networks.some((n) => chains.includes(n.chainKey) && n.gatewayBatchable === true)
}
