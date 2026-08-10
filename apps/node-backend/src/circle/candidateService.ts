import db, { type ServiceRow } from '../db.ts'
import { rowToService, type Service } from './registryService.ts'
import type { SupportedChainName } from '@circle-fin/x402-batching/client'
import { vanillaSupportsChain } from './vanillaPayment.ts'

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
         WHERE (${chainClauses}) AND (${termClauses}) AND ${reachableClause()}
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
    .filter(
      (s) => s.score > 0 && isPayable(s.service, chains) && !isRecentlyFailed(s.service.resource),
    )
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
       WHERE (${chainClauses}) AND ${reachableClause()}
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
 * Can the agent actually pay this service, on either rail?
 *
 * The chain filter above is necessary but nowhere near sufficient — a service
 * can advertise a chain and a price and still be unpayable by us. Handing the
 * planner one of those means it proposes a plan, the user approves it, and the
 * run dies after they have already said yes.
 *
 * Two rails now qualify. Gateway settles batched authorisations carrying
 * Circle's marker. Plain x402 signs an EIP-3009 authorisation against the USDC
 * token instead, which the x402 client can only do on the chains it knows —
 * narrower than Gateway's list, and notably excluding Solana, which needs a
 * signer this wallet is not.
 *
 * Free services are exempt: metered by a direct Arc Testnet transfer, never
 * touching either rail.
 */
function isPayable(service: Service, chains: SupportedChainName[]): boolean {
  if (service.source === 'free') return true
  return service.networks.some((option) => {
    if (!chains.includes(option.chainKey)) return false
    return option.rail === 'gateway'
      ? option.gatewayBatchable === true
      : vanillaSupportsChain(option.chainKey)
  })
}

/* ------------------------------------------------------- endpoint health */

/**
 * Endpoints that have just failed, so the planner stops picking them.
 *
 * Not a health-check subsystem — just a memory of what did not work in the
 * last few minutes. A provider having a bad hour should not keep being
 * proposed to every user, and the alternative is usually just as good.
 */
const recentFailures = new Map<string, number>()
/** Distinct endpoints seen failing per host, to tell one bad path from an outage. */
const hostFailures = new Map<string, Set<string>>()
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000
/**
 * Two different endpoints from the same provider failing is an outage, not a
 * fussy path. Below that, only the individual endpoint is set aside — one
 * endpoint rejecting our parameters says nothing about its neighbours.
 */
const HOST_OUTAGE_THRESHOLD = 2

function hostOfResource(resource: string): string {
  try {
    return new URL(resource).host
  } catch {
    return resource
  }
}

export function noteEndpointFailure(resource: string): void {
  const now = Date.now()
  recentFailures.set(resource, now)

  const host = hostOfResource(resource)
  const seen = hostFailures.get(host) ?? new Set<string>()
  seen.add(resource)
  hostFailures.set(host, seen)
  if (seen.size >= HOST_OUTAGE_THRESHOLD) recentFailures.set(host, now)
}

function coolingDown(key: string): boolean {
  const at = recentFailures.get(key)
  if (at === undefined) return false
  if (Date.now() - at > FAILURE_COOLDOWN_MS) {
    recentFailures.delete(key)
    hostFailures.delete(key)
    return false
  }
  return true
}

export function isRecentlyFailed(resource: string): boolean {
  return coolingDown(resource) || coolingDown(hostOfResource(resource))
}

/**
 * How long an endpoint may be continuously unreachable before it stops being
 * offered at all.
 *
 * Seven days. Long enough that a provider's bad afternoon, a certificate lapse
 * or a regional outage does not cost them their listing, short enough that the
 * catalog is not padded with services that no longer exist. The ten-minute
 * in-memory cooldown handles the short case; this handles abandonment.
 */
const UNREACHABLE_CUTOFF_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Record that an endpoint could not be reached at all.
 *
 * Only for network-level failure — DNS, connection refused, TLS, timeout. A
 * 4xx, a rejected payment or a bad parameter all mean the endpoint answered,
 * which is the opposite of unreachable.
 *
 * The distinction is not academic. A bridge bug of ours reverted before two
 * BlockRun endpoints were ever contacted, and the runner logged both as failed;
 * had that counted here, a week's blacklist would have followed from a mistake
 * on our side.
 *
 * The first failure is the one that counts — the timestamp is not refreshed on
 * repeat, so the clock measures how long it has been down rather than how
 * recently it was tried.
 */
export function noteEndpointUnreachable(resource: string): void {
  db.prepare(
    `UPDATE services SET unreachable_since = ?
      WHERE resource = ? AND unreachable_since IS NULL`,
  ).run(Date.now(), resource)
}

/** Record that an endpoint answered, whatever it said. Clears any outage. */
export function noteEndpointReachable(resource: string): void {
  db.prepare(
    `UPDATE services SET unreachable_since = NULL
      WHERE resource = ? AND unreachable_since IS NOT NULL`,
  ).run(resource)
}

/** True once an endpoint has been dark for longer than the cutoff. */
export function isLongDead(unreachableSince: number | null): boolean {
  if (unreachableSince === null) return false
  return Date.now() - unreachableSince > UNREACHABLE_CUTOFF_MS
}

/** SQL fragment excluding endpoints dark beyond the cutoff. */
export function reachableClause(): string {
  return `(unreachable_since IS NULL OR unreachable_since > ${Date.now() - UNREACHABLE_CUTOFF_MS})`
}

/**
 * Other services that could serve the same step, best first.
 *
 * Used when a step fails mid-run: the user asked for an answer, not for a
 * particular provider, so a working substitute is a better outcome than an
 * apology. Only ever cheaper or equal — the user approved a price, and
 * silently spending more than that would be worse than failing.
 */
/**
 * The distinguishing words of a resource path, ignoring the provider.
 *
 * `/api/v1/pm/polymarket/candlesticks/{hash}` reduces to
 * {api, pm, polymarket, candlesticks} — with version segments, numbers and
 * placeholders dropped, since none of them say what the endpoint does.
 */
/**
 * Path segments that describe structure, not capability.
 *
 * Every REST path has some of these, so treating them as evidence makes any two
 * endpoints look related. `/api/v1/pm/polymarket/candlesticks` and
 * `/api/v1/pm/polymarket/events` share `api` — which was enough, in the first
 * draft of this check, to let an events lookup stand in for OHLCV data.
 */
const GENERIC_PATH_WORDS = new Set([
  'api', 'apis', 'rest', 'data', 'get', 'list', 'query', 'endpoint', 'endpoints',
  'service', 'services', 'public', 'latest', 'current', 'info', 'all',
])

/** Meaningful path segments, in order. */
function pathWords(resource: string): string[] {
  let path: string
  try {
    // Decoded, because the URL parser percent-encodes a `{placeholder}` into
    // `%7B…%7D`, which then survives the placeholder filter and gets mistaken
    // for the segment that names the capability.
    path = decodeURIComponent(new URL(resource).pathname)
  } catch {
    path = resource
  }
  return path
    .split(/[/_.-]+/)
    .map((segment) => segment.toLowerCase().replace(/\{.*\}/, ''))
    .filter(
      (segment) =>
        segment.length > 2 &&
        !/^v\d+$/.test(segment) &&
        !/^\d+$/.test(segment) &&
        !GENERIC_PATH_WORDS.has(segment),
    )
}

/**
 * The last meaningful path segment — what the endpoint actually returns.
 *
 * `/pm/polymarket/candlesticks/{hash}` is about candlesticks;
 * `/pm/polymarket/events` is about events. Everything before the final segment
 * is namespace, and namespaces are shared by endpoints that do entirely
 * different things.
 */
function capabilityOf(resource: string): string | null {
  const words = pathWords(resource)
  return words[words.length - 1] ?? null
}

/**
 * Whether a substitute does the same *kind* of thing as what it replaces.
 *
 * Ranking on term overlap and price alone is not enough. When a bridge revert
 * knocked out a candlesticks endpoint, the best-scoring substitute was an
 * events endpoint from the same marketplace: both matched "polymarket", so it
 * won, and the user paid for an events list after asking for OHLCV data. Price
 * and payability were both fine. It simply answered a different question.
 *
 * The test is a shared capability word in the path beyond the provider's own —
 * `candlesticks` against `events` shares only `polymarket`, which comes from
 * the provider and is already excluded, so nothing is left and no substitution
 * happens. Two Kalshi market endpoints share `markets`, and that is a real
 * alternative.
 *
 * Failing the step honestly is the better outcome when nothing qualifies.
 */
function answersTheSameQuestion(
  failed: Pick<Service, 'resource' | 'host' | 'tags'>,
  candidate: Pick<Service, 'resource' | 'host' | 'tags'>,
): boolean {
  const wanted = capabilityOf(failed.resource)
  const offered = capabilityOf(candidate.resource)

  if (wanted !== null && offered !== null) {
    /*
     * Both paths say what they return, so believe them. Tags must not overrule
     * this: `surf/search/social/posts` and `surf/search/social/people` share
     * their provider's tags, and letting those vouch substituted a people
     * lookup for a posts lookup — the same class of wrong answer the path check
     * exists to prevent.
     */
    return wanted === offered
  }

  /*
   * One side names no capability. Fall back to tags, which is the only evidence
   * available for providers that describe themselves there rather than in the
   * path. The provider's own name is excluded so "blockrun" cannot vouch for
   * itself.
   */
  const provider = new Set([
    ...failed.host.toLowerCase().split(/[.\-]/),
    ...candidate.host.toLowerCase().split(/[.\-]/),
  ])
  const failedTags = new Set(failed.tags.map((t) => t.toLowerCase()))
  if (
    candidate.tags.some((t) => failedTags.has(t.toLowerCase()) && !provider.has(t.toLowerCase()))
  ) {
    return true
  }

  return wanted === null
}

/** Test seam for the relevance rule — the check that stops a wrong substitution. */
export function __testAnswersTheSameQuestion(
  a: Pick<Service, 'resource' | 'host' | 'tags'>,
  b: Pick<Service, 'resource' | 'host' | 'tags'>,
): boolean {
  return answersTheSameQuestion(a, b)
}

export function findAlternatives(
  failed: Service,
  purpose: string,
  approvedCostUsdc: number,
  chains: SupportedChainName[],
  exclude: Set<string>,
): Service[] {
  /*
   * Search on what the step is *for*, never on the failed service's name.
   *
   * The name carries the provider ("Orthogonal /tavily/search"), and that term
   * dominates the match — every substitute came back as another Orthogonal
   * path, all sharing the outage being worked around. The planner's purpose
   * line describes the job without naming who does it.
   */
  /*
   * And strip the provider's own words. Their descriptions name themselves
   * ("tavily endpoint via Orthogonal nanopayment proxy"), so the provider
   * survives into the terms even when the name is left out, and pulls the
   * search straight back to its own siblings.
   */
  const ownWords = new Set(
    extractTerms(
      // Host and provider only. The full service name carries the path, and
      // stripping that removed the verb the search depends on — "search" is
      // both Orthogonal's path segment and the whole point of the step.
      `${failed.host.replace(/[.\-]/g, ' ')} ${failed.serviceName.split(' ')[0] ?? ''}`,
    ),
  )
  const terms = extractTerms(`${purpose} ${failed.description}`).filter((t) => !ownWords.has(t))
  if (terms.length === 0) return []

  const { services } = selectCandidates(terms.join(' '), { chains, limit: 12 })

  const usable = services.filter(
    (s) =>
      s.resource !== failed.resource &&
      !exclude.has(s.resource) &&
      s.source === failed.source &&
      s.priceUsdc <= approvedCostUsdc &&
      !isRecentlyFailed(s.resource) &&
      answersTheSameQuestion(failed, s),
  )

  /*
   * A different provider first.
   *
   * Outages are usually provider-wide, not per-endpoint: when Orthogonal's
   * search failed, every substitute the scoring liked best was another
   * Orthogonal path, all sharing the same downtime. Trying a sibling of the
   * thing that just failed spends attempts learning what we already know.
   */
  const otherHost = usable.filter((s) => s.host !== failed.host)
  const sameHost = usable.filter((s) => s.host === failed.host)
  return [...otherHost, ...sameHost]
}
