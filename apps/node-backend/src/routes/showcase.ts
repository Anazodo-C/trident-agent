import { Router } from 'express'
import { findServiceByResource } from '../circle/registryService.ts'

/**
 * Public data for the landing page carousel. No auth — this is read by people
 * who have not signed up yet.
 *
 * Every figure on the marketing page comes from the live registry: the price,
 * the 30-day call volume, whether the service is curated. Only the human
 * phrasing is authored here, and it is keyed to an exact resource URL, so a
 * service delisted from Circle's marketplace disappears from the landing page
 * on the next boot rather than advertising something that no longer answers.
 *
 * Order is authored. Circle's marketplace publishes no call volumes, so there
 * is no usage signal to rank by.
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
    resource: 'https://x402.alchemy.com/prices/v1/tokens/by-symbol',
    category: 'Prices',
    prompt: 'What are BTC and ETH trading at right now?',
    does: 'Pulls live token prices from Alchemy and answers with the figures, not a chart.',
  },
  {
    resource: 'https://api.aisa.one/apis/v2/polymarket/events',
    category: 'Prediction Markets',
    prompt: 'What odds is Polymarket giving that event?',
    does: 'Reads current market odds and trades, and tells you where the money actually sits.',
  },
  {
    resource: 'https://api.aisa.one/apis/v2/coingecko/simple/price',
    category: 'Market Data',
    prompt: 'Price of SOL in euros, and how it moved this week.',
    does: 'Queries CoinGecko for spot prices in any currency and converts them exactly.',
  },
  {
    resource: 'https://api.aisa.one/apis/v2/twitter/user_about',
    category: 'Social',
    prompt: 'Who is behind this X account, and how big is their following?',
    does: 'Resolves the handle to a real profile with engagement figures, no scraping.',
  },
  {
    resource: 'https://nano.blockrun.ai/api/v1/surf/news/detail',
    category: 'Market News',
    prompt: 'What is behind this morning’s move in crypto?',
    does: 'Fetches the article behind a headline so the answer cites something you can read.',
  },
  {
    resource: 'https://nano.blockrun.ai/api/v1/pm/polymarket/wallet/{address}',
    category: 'Onchain Data',
    prompt: 'What has this wallet been betting on?',
    does: 'Builds a full profile of a trader’s positions and performance from onchain history.',
  },
  {
    resource: 'https://np.orthogonal.com/tomba/v1/domain-search',
    category: 'Enrichment',
    prompt: 'Who should I contact at this company?',
    does: 'Searches a domain for named contacts and returns roles alongside addresses.',
  },
  {
    resource: 'https://np.orthogonal.com/findymail/api/technologies/search',
    category: 'Research',
    prompt: 'What is this company’s stack built on?',
    does: 'Detects the technologies a site runs on, for a tenth of a cent.',
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
  // Authored order, with the two free-tier cards last: they are the "try it
  // without funding" story, not the headline capability. Circle publishes no
  // usage figures, so there is nothing to rank by and inventing an order would
  // just be a shuffle.
  return cards.sort((a, b) => {
    if (a.source !== b.source) return a.source === 'free' ? 1 : -1
    return 0
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
