import { Router } from 'express'
import { findServiceByResource } from '../circle/registryService.ts'

/**
 * Public data for the landing page carousel. No auth — this is read by people
 * who have not signed up yet.
 *
 * Every figure on the marketing page comes from the live registry: the price,
 * the 30-day call volume, whether the service is curated. Only the human
 * phrasing is authored here, and it is keyed to an exact resource URL, so a
 * service that gets delisted from the Bazaar disappears from the landing page
 * on the next boot rather than advertising something that no longer answers.
 *
 * Ranking is by real call volume across the x402 network, not by Trident's own
 * task history — Trident has run a few dozen tasks, which is not a signal.
 * Revisit once task_steps carries enough volume to rank from.
 */

interface ShowcaseCopy {
  /** Exact registry resource. Unmatched entries are dropped, never faked. */
  resource: string
  category: string
  /** Phrased as something a person would actually type to their agent. */
  prompt: string
  /** What the agent does end to end: scout, call, pay, answer. */
  does: string
}

const COPY: ShowcaseCopy[] = [
  {
    resource: 'https://x402.twit.sh/tweets/search',
    category: 'Social Search',
    prompt: 'What are people saying about Arc mainnet this week?',
    does: 'Scans X for matching posts, pays per search, and comes back with the actual tweets.',
  },
  {
    resource: 'https://x402.tavily.com/search',
    category: 'Web Search',
    prompt: 'Summarise the last month of stablecoin regulation news.',
    does: 'Runs an advanced web search, settles the fee from your wallet, returns sourced findings.',
  },
  {
    resource: 'https://api.exa.ai/search',
    category: 'Research',
    prompt: 'Find the top 3 competitors to Stripe and what they raised.',
    does: 'Searches Exa’s neural index, pays per query, and answers with the sources it used.',
  },
  {
    resource: 'https://api.nansen.ai/api/v1/profiler/address/current-balance',
    category: 'Onchain Data',
    prompt: 'What is this wallet holding right now?',
    does: 'Pulls the address’s live balances from Nansen and reports the positions back in plain text.',
  },
  {
    resource: 'https://x402.ottoai.services/crypto-news',
    category: 'Market News',
    prompt: 'What is moving the crypto market this morning?',
    does: 'Fetches ranked headlines with sentiment, pays a fraction of a cent, and gives you the gist.',
  },
  {
    resource: 'https://stabletravel.dev/api/seats-aero/search',
    category: 'Travel',
    prompt: 'Any business award seats London to Tokyo in March?',
    does: 'Searches cached award availability by route and cabin, then lists what it found.',
  },
  {
    resource: 'https://stableenrich.dev/api/pdl/people-enrich',
    category: 'Enrichment',
    prompt: 'Who is the CTO at this company, and how do I reach them?',
    does: 'Enriches the person from a name or profile URL and returns their role and contact details.',
  },
  {
    resource: 'https://x402engine.app/api/crypto/price',
    category: 'Prices',
    prompt: 'What is SOL worth in euros right now?',
    does: 'Quotes any coin in any fiat currency for a tenth of a cent, and converts it exactly.',
  },
  {
    resource: 'https://x402.agentutility.ai/users-by-username',
    category: 'Profiles',
    prompt: 'Pull the profile and follower count for this X handle.',
    does: 'Resolves the handle to a public profile and hands back the fields, no scraping.',
  },
  {
    resource: 'https://blockrun.ai/api/v1/exa/search',
    category: 'Deep Search',
    prompt: 'Find recent research papers on intent-based bridging.',
    does: 'Runs a filtered search across papers, news and repos, and cites what it returns.',
  },
  {
    resource: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd',
    category: 'Free tier',
    prompt: 'What are BTC and ETH trading at?',
    does: 'Free to call — metered by a testnet payment, so you can try the agent before funding it.',
  },
  {
    resource: 'https://api.open-meteo.com/v1/forecast?latitude=51.5&longitude=-0.13&current_weather=true',
    category: 'Free tier',
    prompt: 'What is the weather in London?',
    does: 'Another free endpoint, settled on Arc Testnet, so the whole flow is real without real money.',
  },
]

export interface ShowcaseCard extends ShowcaseCopy {
  serviceName: string
  host: string
  priceUsdc: number
  calls30d: number
  curated: boolean
  source: 'free' | 'x402'
}

/**
 * Resolved once per process. The registry only changes on a sync, and this is
 * hit by every anonymous visitor — there is no reason to query per request.
 */
let cache: { cards: ShowcaseCard[]; builtAt: number } | null = null
const CACHE_MS = 10 * 60 * 1000

function buildCards(): ShowcaseCard[] {
  const cards: ShowcaseCard[] = []
  for (const copy of COPY) {
    const service = findServiceByResource(copy.resource)
    // Delisted, renamed, or not yet synced — say nothing rather than something
    // stale. A short carousel is better than one advertising a dead endpoint.
    if (!service) continue
    cards.push({
      ...copy,
      serviceName: service.serviceName,
      host: service.host,
      priceUsdc: service.priceUsdc,
      calls30d: service.calls30d,
      curated: service.curated,
      source: service.source === 'free' ? 'free' : 'x402',
    })
  }
  // Busiest first, but the two free-tier cards stay at the end: they are the
  // "try it without funding" story, not the headline capability.
  return cards.sort((a, b) => {
    if (a.source !== b.source) return a.source === 'free' ? 1 : -1
    return b.calls30d - a.calls30d
  })
}

export function showcaseCards(): ShowcaseCard[] {
  if (!cache || Date.now() - cache.builtAt > CACHE_MS) {
    cache = { cards: buildCards(), builtAt: Date.now() }
  }
  return cache.cards
}

const router = Router()

router.get('/', (_req, res) => {
  const cards = showcaseCards()
  res.setHeader('Cache-Control', 'public, max-age=300')
  res.json({ cards })
})

export default router
