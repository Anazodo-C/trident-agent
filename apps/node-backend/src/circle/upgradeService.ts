import db, { type ServiceRow } from '../db.ts'
import { rowToService, type Service } from './registryService.ts'
import { extractTerms } from './candidateService.ts'
import { chooseChain, type ChainPolicy } from './chainPolicy.ts'

/**
 * Premium upgrades for free steps.
 *
 * A free public API is often a thinner version of something purchasable: a
 * Wikipedia summary where Exa would do real neural search, CoinGecko spot
 * prices where a paid feed carries depth and history. When a plan leans on the
 * free tier, the user should be able to see what paying would buy them —
 * stated as a concrete service and price, not a vague nudge.
 *
 * This is deliberately advisory. Nothing is substituted automatically and no
 * upgrade is pre-selected: the plan the user approves is the plan they asked
 * for. It also stays quiet when a paid service would not actually be better.
 */

export interface PremiumUpgrade {
  serviceName: string
  resource: string
  description: string
  priceUsdc: number
  chain: string | null
  curated: boolean
  calls30d: number
  /** True when the user could run it today, false when mainnet is still off. */
  available: boolean
}

export interface StepUpgrade {
  stepIndex: number
  /** The free service being matched against. */
  freeServiceName: string
  /** Human label for what the paid tier offers, e.g. "web search and research". */
  category: string
  options: PremiumUpgrade[]
}

/** Below this, a paid service has too little usage to recommend over a working free one. */
const MIN_CALLS_TO_RECOMMEND = 50
const MAX_OPTIONS = 2

/**
 * Find paid services that plausibly outperform a given free one.
 *
 * Matches on the free service's declared premium category plus its own tags, so
 * a recommendation has to share subject matter — not merely be popular.
 */
function findUpgradesFor(free: Service, policy: ChainPolicy): PremiumUpgrade[] {
  // Match on the declared premium category only.
  //
  // Using the free service's own tags as well produced nonsense: Cat Facts
  // (tags: cat, facts, fun) matched an AI inference gateway on "fun", and
  // CoinGecko matched a travel API. A free service without a declared category
  // has no paid equivalent worth suggesting, so it gets no upsell at all —
  // there is no premium cat-fact service, and pretending otherwise costs trust.
  if (!free.premiumCategory) return []

  const unique = extractTerms(free.premiumCategory).filter((t) => t.length > 2).slice(0, 6)
  if (unique.length === 0) return []

  const clauses = unique
    .map((_, i) => `(service_name LIKE @t${i} OR tags LIKE @t${i} OR description LIKE @t${i})`)
    .join(' OR ')
  const params = Object.fromEntries(unique.map((t, i) => [`t${i}`, `%${t}%`]))

  const rows = db
    .prepare(
      `SELECT * FROM services
       WHERE source = 'x402'
         AND calls_30d >= @minCalls
         AND (${clauses})
       ORDER BY curated DESC, calls_30d DESC
       LIMIT 12`,
    )
    .all({ ...params, minCalls: MIN_CALLS_TO_RECOMMEND }) as ServiceRow[]

  // One suggestion per provider — the registry lists many endpoints per host,
  // and showing the same brand twice reads as padding.
  const seen = new Set<string>()

  return rows
    .map(rowToService)
    .filter((s) => {
      if (s.resource === free.resource) return false
      const key = s.serviceName.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, MAX_OPTIONS)
    .map((s) => {
      const choice = chooseChain(s.networks, policy)
      return {
        serviceName: s.serviceName,
        resource: s.resource,
        description: s.description.slice(0, 160),
        priceUsdc: choice?.priceUsdc ?? s.priceUsdc,
        chain: choice?.chain ?? s.chainKey,
        curated: s.curated,
        calls30d: s.calls30d,
        available: choice !== null,
      }
    })
}

/**
 * Build upgrade suggestions for every free step in a plan.
 * Returns an empty array when the plan uses no free services.
 */
export function findUpgrades(
  steps: { stepIndex: number; endpointUrl: string }[],
  policy: ChainPolicy,
): StepUpgrade[] {
  const upgrades: StepUpgrade[] = []

  for (const step of steps) {
    const row = db.prepare('SELECT * FROM services WHERE resource = ?').get(step.endpointUrl) as
      | ServiceRow
      | undefined
    if (!row || row.source !== 'free') continue

    const free = rowToService(row)
    const options = findUpgradesFor(free, policy)
    if (options.length === 0) continue

    upgrades.push({
      stepIndex: step.stepIndex,
      freeServiceName: free.serviceName,
      category: free.premiumCategory ?? 'a paid alternative',
      options,
    })
  }

  return upgrades
}
