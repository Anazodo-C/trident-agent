/**
 * Free public APIs the agent can call without paying.
 *
 * Sourced from github.com/public-apis/public-apis, but not ingested from it:
 * that list records homepages and documentation pages as often as endpoints, so
 * of 698 no-auth HTTPS entries only ~110 return JSON at all, and most of those
 * are GitHub doc pages returning GitHub's own metadata. Blindly importing it
 * would fill the catalog with services that fail the moment the agent calls them.
 *
 * These are real endpoint paths, each verified to return JSON. They exist so
 * there is something genuinely runnable on testnet, before any mainnet spend.
 */

export interface FreeApi {
  /** Stable id; also the registry primary key suffix. */
  id: string
  name: string
  description: string
  /** Callable endpoint returning JSON. */
  resource: string
  tags: string[]
  /** Curated = dependable, well-known, good default for its category. */
  curated: boolean
  /**
   * Query parameters the caller should set, where the stored URL carries an
   * example value.
   *
   * Without this the planner has no idea a parameter exists, so the example
   * ships as the answer — the geocoding entry is stored as "?name=lagos", and
   * a request for the University of Georgia was billed and answered as Lagos.
   * Named here, the planner fills them and they override the example.
   */
  params?: string[]
  /**
   * The kind of paid capability this stands in for, used to suggest an x402
   * upgrade when a premium service would do the job better.
   */
  premiumCategory?: string
}

export const FREE_API_CATALOG: FreeApi[] = [
  // ---------------------------------------------------------------- crypto
  {
    id: 'coingecko-price',
    name: 'CoinGecko Simple Price',
    description: 'Spot price for any coin in any currency. No key required.',
    resource: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd',
    params: ['ids', 'vs_currencies'],
    tags: ['crypto', 'price', 'market', 'token'],
    curated: true,
    premiumCategory: 'crypto market data',
  },
  {
    id: 'coingecko-trending',
    name: 'CoinGecko Trending',
    description: 'Trending coins on CoinGecko in the last 24 hours.',
    resource: 'https://api.coingecko.com/api/v3/search/trending',
    tags: ['crypto', 'trending', 'market'],
    curated: true,
    premiumCategory: 'crypto market data',
  },
  // ------------------------------------------------------------------- fx
  {
    id: 'frankfurter-latest',
    name: 'Frankfurter FX Rates',
    description: 'Reference foreign-exchange rates published by the ECB.',
    resource: 'https://api.frankfurter.app/latest?from=USD',
    params: ['from'],
    tags: ['fx', 'currency', 'exchange', 'finance'],
    curated: true,
    premiumCategory: 'financial data',
  },
  // -------------------------------------------------------------- weather
  {
    id: 'open-meteo-forecast',
    name: 'Open-Meteo Forecast',
    description: 'Weather forecast by latitude and longitude. No key required.',
    resource: 'https://api.open-meteo.com/v1/forecast?latitude=51.5&longitude=-0.13&current_weather=true',
    params: ['latitude', 'longitude'],
    tags: ['weather', 'forecast', 'climate'],
    curated: true,
  },
  // ------------------------------------------------------- geo / reference
  {
    id: 'restcountries-all',
    name: 'REST Countries',
    description: 'Country data: capital, population, currencies, languages, borders.',
    resource: 'https://restcountries.com/v3.1/name/nigeria',
    tags: ['country', 'geo', 'reference', 'population'],
    curated: true,
  },
  {
    id: 'wikipedia-summary',
    name: 'Wikipedia Summary',
    description: 'Plain-text summary and thumbnail for any Wikipedia article.',
    resource: 'https://en.wikipedia.org/api/rest_v1/page/summary/Stripe_(company)',
    tags: ['wiki', 'summary', 'research', 'reference', 'encyclopedia'],
    curated: true,
    premiumCategory: 'web search and research',
  },
  {
    id: 'openlibrary-search',
    name: 'Open Library Search',
    description: 'Book metadata by title, author or subject.',
    resource: 'https://openlibrary.org/search.json?q=the+lean+startup&limit=5',
    params: ['q'],
    tags: ['books', 'library', 'research', 'metadata'],
    curated: true,
  },
  {
    id: 'datamuse-words',
    name: 'Datamuse',
    description: 'Word suggestions: synonyms, rhymes, related terms.',
    resource: 'https://api.datamuse.com/words?ml=startup&max=20',
    params: ['ml'],
    tags: ['words', 'language', 'thesaurus', 'naming'],
    curated: false,
  },
  // ---------------------------------------------------------------- science
  {
    id: 'usgs-earthquakes',
    name: 'USGS Earthquakes',
    description: 'Significant earthquakes worldwide in the past day.',
    resource: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_day.geojson',
    tags: ['earthquake', 'science', 'geo', 'usgs', 'disaster'],
    curated: true,
  },
  {
    id: 'iss-position',
    name: 'ISS Current Location',
    description: 'Current latitude and longitude of the International Space Station.',
    resource: 'http://api.open-notify.org/iss-now.json',
    tags: ['space', 'iss', 'satellite', 'science'],
    curated: false,
  },
  // ------------------------------------------------------------------ dev
  {
    id: 'npm-registry',
    name: 'npm Registry',
    description: 'Package metadata, versions and maintainers from npm.',
    resource: 'https://registry.npmjs.org/react',
    tags: ['npm', 'package', 'developer', 'javascript'],
    curated: true,
  },
  // -------------------------------------------------------------- utility
  {
    id: 'advice-slip',
    name: 'Advice Slip',
    description: 'A random piece of advice.',
    resource: 'https://api.adviceslip.com/advice',
    tags: ['advice', 'text', 'fun'],
    curated: false,
  },
  {
    id: 'catfact',
    name: 'Cat Facts',
    description: 'A random fact about cats.',
    resource: 'https://catfact.ninja/fact',
    tags: ['cat', 'facts', 'fun', 'animals'],
    curated: false,
  },
  {
    id: 'dog-random',
    name: 'Dog CEO',
    description: 'A random dog photograph.',
    resource: 'https://dog.ceo/api/breeds/image/random',
    tags: ['dog', 'image', 'fun', 'animals'],
    curated: false,
  },
  {
    id: 'random-user',
    name: 'Random User',
    description: 'Synthetic user profiles, useful for test data.',
    resource: 'https://randomuser.me/api/',
    tags: ['test', 'user', 'mock', 'data'],
    curated: false,
  },
  {
    id: 'jsonplaceholder-posts',
    name: 'JSONPlaceholder',
    description: 'Fake REST data for prototyping and testing.',
    resource: 'https://jsonplaceholder.typicode.com/posts?_limit=5',
    tags: ['test', 'mock', 'json', 'placeholder'],
    curated: false,
  },
  // ------------------------------------------------------------------ news
  {
    id: 'hn-topstories',
    name: 'Hacker News Top Stories',
    description: 'IDs of the current top stories on Hacker News.',
    resource: 'https://hacker-news.firebaseio.com/v0/topstories.json',
    tags: ['news', 'tech', 'hackernews', 'trending'],
    curated: true,
    premiumCategory: 'news and social data',
  },
  {
    id: 'hn-item',
    name: 'Hacker News Item',
    description: 'A single Hacker News story with title, score and URL.',
    resource: 'https://hacker-news.firebaseio.com/v0/item/1.json',
    tags: ['news', 'tech', 'hackernews', 'story'],
    curated: false,
    premiumCategory: 'news and social data',
  },
  {
    id: 'coingecko-markets',
    name: 'CoinGecko Markets',
    description: 'Top coins by market cap with price, volume and 24h change.',
    resource: 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&per_page=10&page=1',
    params: ['vs_currency'],
    tags: ['crypto', 'market', 'marketcap', 'ranking'],
    curated: true,
    premiumCategory: 'crypto market data',
  },
  {
    id: 'exchangerate-latest',
    name: 'ExchangeRate API',
    description: 'Latest exchange rates for any base currency.',
    resource: 'https://api.exchangerate-api.com/v4/latest/USD',
    tags: ['fx', 'currency', 'exchange', 'rates'],
    curated: true,
    premiumCategory: 'financial data',
  },
  {
    id: 'openmeteo-geocode',
    name: 'Open-Meteo Geocoding',
    description: 'Resolve a place name to coordinates, country and timezone.',
    resource: 'https://geocoding-api.open-meteo.com/v1/search?name=lagos&count=3',
    params: ['name'],
    tags: ['geocoding', 'geo', 'location', 'coordinates'],
    curated: true,
  },
  {
    id: 'wikipedia-search',
    name: 'Wikipedia Search',
    description: 'Full-text search across Wikipedia articles.',
    resource: 'https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=x402&format=json',
    params: ['srsearch'],
    tags: ['wiki', 'search', 'research', 'reference'],
    curated: true,
    premiumCategory: 'web search and research',
  },
  {
    id: 'nager-holidays',
    name: 'Public Holidays',
    description: 'Public holidays for a country and year.',
    resource: 'https://date.nager.at/api/v3/PublicHolidays/2026/US',
    tags: ['holidays', 'calendar', 'date', 'country'],
    curated: false,
  },
  {
    id: 'zippopotam-postal',
    name: 'Postal Code Lookup',
    description: 'Place, state and coordinates for a postal code.',
    resource: 'https://api.zippopotam.us/us/90210',
    tags: ['postal', 'zip', 'geo', 'address'],
    curated: false,
  },
  {
    id: 'sunrise-sunset',
    name: 'Sunrise / Sunset',
    description: 'Sunrise, sunset and twilight times for a coordinate.',
    resource: 'https://api.sunrise-sunset.org/json?lat=51.5&lng=-0.13',
    params: ['lat', 'lng'],
    tags: ['sun', 'daylight', 'astronomy', 'time'],
    curated: false,
  },
  {
    id: 'chucknorris-joke',
    name: 'Chuck Norris Jokes',
    description: 'A random Chuck Norris joke.',
    resource: 'https://api.chucknorris.io/jokes/random',
    tags: ['joke', 'fun', 'text'],
    curated: false,
  },
]
