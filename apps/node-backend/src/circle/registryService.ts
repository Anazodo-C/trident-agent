import { createHash } from 'node:crypto'
import { CHAIN_CONFIGS } from '@circle-fin/x402-batching/client'
import type { SupportedChainName } from '@circle-fin/x402-batching/client'
import db, { type ServiceRow } from '../db.ts'
import { FREE_API_CATALOG } from './freeApiCatalog.ts'
import { VERIFICATION_AMOUNT_USDC, VERIFICATION_CHAIN } from './testnetVerification.ts'

/**
 * Mirror of the x402 discovery registry (the "Bazaar").
 *
 * agents.circle.com has no public API — its catalogue is server-rendered and
 * its JS bundle contains no fetch URLs. The x402 ecosystem does publish a
 * discovery API, which is a superset of Circle's marketplace and carries the
 * `curated` flag identifying it.
 */
/**
 * Circle's Agent Marketplace discovery API — public, no key.
 *
 * Replaces the Coinbase x402 Bazaar. The Bazaar listed ~14k services of which
 * zero carried Circle's Gateway marker, so GatewayClient.pay() had no
 * counterparty and no mainnet call could ever settle. Circle's own marketplace
 * exposes supportsCircleGateway as a filter, and every listing behind it
 * carries the GatewayWalletBatched authorisation the SDK requires.
 */
const DISCOVERY_URL = 'https://api.circle.com/v2/x402/discovery/resources'
const PAGE_SIZE = 200 // Circle's documented maximum.

/**
 * Identifies the upstream catalog. Bump when the source changes so existing
 * deployments rebuild instead of serving rows from the previous provider.
 */
export const CATALOG_SOURCE = 'circle-agent-marketplace-v1'

/**
 * Bump whenever the sync starts reading something new out of the upstream
 * payload.
 *
 * A row is only as good as the code that wrote it. `input_schema` was added one
 * commit after the switch to Circle, so every deployment that had already
 * synced kept a catalog where that column was NULL — and the source had not
 * changed, so nothing triggered a rebuild. The planner was handed no body
 * shapes, the runner found no required parameters to check, and both behaved
 * exactly as if the endpoints published nothing. Four fixes shipped against
 * data that was never rewritten.
 *
 * The upstream identity and our extraction of it are separate things, and both
 * have to invalidate the stored copy.
 */
const CATALOG_SCHEMA_VERSION = 2

/** What gets written to `registry_sync.source_version`. */
export const CATALOG_VERSION = `${CATALOG_SOURCE}#${CATALOG_SCHEMA_VERSION}`
const MAX_PAGES = 40
const REQUEST_TIMEOUT_MS = 45_000

/** Resources with no recorded traffic are shown, but flagged. */
export type TrustTier = 'curated' | 'active' | 'untested'

export interface ServiceNetworkOption {
  network: string
  chainKey: SupportedChainName
  isTestnet: boolean
  priceUsdc: number
  asset: string | null
  scheme: string
  /** True only when Circle Gateway can settle it — see isGatewayBatchable. */
  gatewayBatchable?: boolean
}

export type ServiceSource = 'x402' | 'free'

export interface Service {
  id: string
  resource: string
  source: ServiceSource
  serviceName: string
  description: string
  tags: string[]
  host: string
  network: string | null
  chainKey: SupportedChainName | null
  isTestnet: boolean
  networks: ServiceNetworkOption[]
  priceUsdc: number
  httpMethod: 'GET' | 'POST'
  curated: boolean
  calls30d: number
  payers30d: number
  lastCalledAt: string | null
  iconUrl: string | null
  trust: TrustTier
  /** Parameter names the endpoint requires, from its published schema. */
  requiredParams: string[]
  /** Compact POST body shape, or null for GET / no published schema. */
  bodyShape: string | null
  /** Query string or request body, from the schema. Null when none was published. */
  paramLocation: 'query' | 'body' | null
  /** Closed value sets by parameter name, for the ones that publish them. */
  paramEnums: Record<string, string[]>
  /** For free APIs: the paid category an x402 service could upgrade this to. */
  premiumCategory: string | null
}

/* ------------------------------------------------------------------ chains */

const TESTNET_KEYS = new Set<SupportedChainName>([
  'arcTestnet',
  'baseSepolia',
  'sepolia',
  'arbitrumSepolia',
  'avalancheFuji',
  'optimismSepolia',
  'polygonAmoy',
  'unichainSepolia',
  'seiAtlantic',
  'sonicTestnet',
  'worldChainSepolia',
  'hyperEvmTestnet',
])

/**
 * CAIP-2 network -> Gateway chain key, derived from the SDK's own chain table
 * rather than hardcoded, so it stays correct as the SDK adds chains.
 */
const NETWORK_TO_CHAIN: Record<string, SupportedChainName> = (() => {
  const map: Record<string, SupportedChainName> = {}
  for (const [key, config] of Object.entries(CHAIN_CONFIGS)) {
    map[`eip155:${config.chain.id}`] = key as SupportedChainName
  }
  // Registry entries are not consistently CAIP-2; some publish bare names.
  Object.assign(map, {
    base: 'base',
    'base-sepolia': 'baseSepolia',
    polygon: 'polygon',
    arbitrum: 'arbitrum',
    ethereum: 'ethereum',
    optimism: 'optimism',
    avalanche: 'avalanche',
  } satisfies Record<string, SupportedChainName>)
  return map
})()

export function chainForNetwork(network: string): SupportedChainName | null {
  return NETWORK_TO_CHAIN[network.trim()] ?? null
}

export function isTestnetChain(chain: SupportedChainName): boolean {
  return TESTNET_KEYS.has(chain)
}

/* ------------------------------------------------------------------- sync */

interface DiscoveryAccept {
  scheme?: string
  network?: string
  amount?: string
  asset?: string
  extra?: Record<string, unknown>
}

interface DiscoveryProvider {
  name?: string
  description?: string
  category?: string
  tags?: unknown
  website?: string
  docsUrl?: string
}

interface DiscoveryMetadata {
  provider?: DiscoveryProvider
  path?: string
  /** The real HTTP verb. The Bazaar never published this, so it was guessed. */
  method?: string
  description?: string
  mimeType?: string
  input?: unknown
  siwx?: boolean
  supportsVanillax402?: boolean
  supportsCircleGateway?: boolean
}

interface DiscoveryItem {
  resource?: string
  type?: string
  accepts?: DiscoveryAccept[]
  metadata?: DiscoveryMetadata
}

function toUsdc(amount: string | undefined): number {
  const n = Number(amount ?? 0)
  // x402 amounts are atomic units of the asset; USDC is 6dp.
  return Number.isFinite(n) ? Number((n / 1e6).toFixed(6)) : 0
}

/**
 * Mirrors the SDK's own selection test, which is the only thing that decides
 * whether a payment will go through.
 */
function isGatewayBatchable(accept: {
  scheme?: string
  extra?: Record<string, unknown>
}): boolean {
  const extra = accept.extra
  return (
    extra?.['name'] === 'GatewayWalletBatched' &&
    extra?.['version'] === '1' &&
    typeof extra?.['verifyingContract'] === 'string'
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/**
 * Reduce a discovery item to the shape we store. Returns null when nothing
 * about it is settleable through Gateway, which is the only way we can pay.
 */
function normalise(item: DiscoveryItem): Omit<ServiceRow, 'synced_at'> | null {
  const resource = item.resource?.trim()
  if (!resource || !/^https?:\/\//i.test(resource)) return null
  if (item.type && item.type !== 'http') return null

  const options: ServiceNetworkOption[] = []
  for (const accept of item.accepts ?? []) {
    const network = accept.network?.trim()
    if (!network) continue
    const chainKey = chainForNetwork(network)
    if (!chainKey) continue
    options.push({
      network,
      chainKey,
      isTestnet: isTestnetChain(chainKey),
      priceUsdc: toUsdc(accept.amount),
      asset: accept.asset ?? null,
      scheme: accept.scheme ?? 'exact',
      /**
       * Whether Circle's Gateway can actually settle this option.
       *
       * `scheme: 'batch-settlement'` is not enough — it is a generic label and
       * other implementations use it too (Tempo, for one). The SDK will only
       * pay an option carrying Circle's own marker, and refuses anything else
       * with "No Gateway batching option available". Recording the answer here
       * is the difference between a plan that can run and one that dies after
       * the user approves it.
       */
      gatewayBatchable: isGatewayBatchable(accept),
    })
  }
  if (options.length === 0) return null

  // Prefer mainnet Base — the deepest inventory and our mainnet default —
  // then any other mainnet, then testnet.
  const preferred =
    options.find((o) => o.chainKey === 'base') ??
    options.find((o) => !o.isTestnet) ??
    options[0]!

  const meta = item.metadata ?? {}
  const provider = meta.provider ?? {}
  const host = hostOf(resource)

  // Category is a useful retrieval term, so it joins the tags rather than
  // needing a column of its own.
  const tags = [
    ...(Array.isArray(provider.tags) ? provider.tags.map(String) : []),
    ...(provider.category ? [String(provider.category)] : []),
  ].filter(Boolean)

  // The endpoint description is the specific one ("Categories with Market
  // Data"); the provider's is the general one. Both help the planner match.
  const description = [meta.description?.trim(), provider.description?.trim()]
    .filter(Boolean)
    .join(' — ')

  const name = provider.name?.trim()
  const method = meta.method?.trim().toUpperCase()

  return {
    id: createHash('sha1').update(resource).digest('hex').slice(0, 24),
    resource,
    source: 'x402',
    // Provider plus path: a provider lists dozens of endpoints, and "Aisa" on
    // thirty rows tells the planner nothing about which one to pick.
    service_name: name ? `${name}${meta.path ? ` ${meta.path}` : ''}` : host || 'Unnamed service',
    description,
    tags: JSON.stringify(tags),
    host,
    network: preferred.network,
    chain_key: preferred.chainKey,
    is_testnet: preferred.isTestnet ? 1 : 0,
    networks_json: JSON.stringify(options),
    asset: preferred.asset,
    price_usdc: preferred.priceUsdc,
    scheme: preferred.scheme,
    // Published now, so the verb is known rather than guessed — the Bazaar's
    // silence here is what produced 405s from the planner's guesses.
    http_method: method === 'POST' ? 'POST' : 'GET',
    /**
     * Everything here is Circle-vetted and Gateway-settleable, which is a
     * stronger signal than the Bazaar's open listing ever was — so the whole
     * catalog ranks as curated.
     */
    curated: 1,
    // Circle publishes no usage figures. Left at zero rather than invented;
    // ranking leans on curation and term matching instead.
    calls_30d: 0,
    payers_30d: 0,
    last_called_at: null,
    icon_url: null,
    input_schema: meta.input ? JSON.stringify(meta.input) : null,
  }
}

/**
 * Where a service reads its parameters from.
 *
 * Not inferrable from the HTTP method. Of the 337 POST services in the live
 * catalog, 209 declare a `body` and 8 declare `queryParams` — a POST that reads
 * its arguments from the query string. Sending those a body leaves the query
 * empty, which is how a paid call to AIsa's scholar search came back
 * "Field required" for a field the planner had in fact supplied.
 *
 * Null means the service published no schema (120 POSTs, including
 * Orthogonal). Body is the safer guess there, but the caller should know it is
 * a guess.
 */
export function paramLocationOf(inputSchema: string | null): 'query' | 'body' | null {
  if (!inputSchema) return null
  try {
    const schema = JSON.parse(inputSchema) as { queryParams?: unknown; body?: unknown }
    if (schema.queryParams) return 'query'
    if (schema.body) return 'body'
    return null
  } catch {
    return null
  }
}

/**
 * Closed value sets, by parameter name.
 *
 * Needed because a parameter can be present, correctly typed, and still
 * rejected. BlockRun publishes two chat endpoints: `/chat/completions` takes 40
 * models, `/api/v1/messages` takes 9, all Anthropic. Failing over between them
 * carried `model: "openai/gpt-4o-mini"` into the one that has never accepted an
 * OpenAI model, and the answer was a flat 400.
 */
export function paramEnumsOf(inputSchema: string | null): Record<string, string[]> {
  if (!inputSchema) return {}
  try {
    const schema = JSON.parse(inputSchema) as Record<string, { properties?: unknown }>
    const enums: Record<string, string[]> = {}
    for (const section of ['queryParams', 'body'] as const) {
      const properties = schema[section]?.properties as
        | Record<string, { enum?: unknown }>
        | undefined
      if (!properties) continue
      for (const [name, spec] of Object.entries(properties)) {
        if (Array.isArray(spec?.enum) && spec.enum.length > 0) {
          enums[name] = spec.enum.map(String)
        }
      }
    }
    return enums
  } catch {
    return {}
  }
}

/** How many values of a closed set to show before trailing off. */
const MAX_ENUM_SHOWN = 6
/** How far into nested objects and arrays to descend. */
const MAX_SHAPE_DEPTH = 3

interface SchemaNode {
  type?: unknown
  enum?: unknown
  items?: SchemaNode
  properties?: Record<string, SchemaNode>
  required?: unknown
}

/**
 * One parameter's type, as something a model can copy.
 *
 * "array" is not a type a caller can act on. BlockRun's chat body declares
 * `messages` as an array whose items are `{ role, content }`, and rendering
 * only the word "array" discarded the half that mattered — the planner sent a
 * list of strings and got a 400, twice, on two different endpoints. 100 of the
 * catalog's 233 array-typed body parameters publish an item shape.
 *
 * Closed value sets are inlined for the same reason: a name alone leaves the
 * model to invent one.
 */
function describeType(spec: SchemaNode | undefined, depth = 0): string {
  if (!spec) return 'any'

  if (Array.isArray(spec.enum) && spec.enum.length > 0) {
    const shown = spec.enum.slice(0, MAX_ENUM_SHOWN).map((v) => JSON.stringify(String(v)))
    return spec.enum.length > MAX_ENUM_SHOWN ? `${shown.join('|')}|…` : shown.join('|')
  }

  const type = Array.isArray(spec.type) ? spec.type.join('|') : (spec.type ?? 'any')

  if (depth < MAX_SHAPE_DEPTH) {
    if (type === 'array' && spec.items) return `[${describeType(spec.items, depth + 1)}]`
    if (type === 'object' && spec.properties) {
      const required = new Set(
        Array.isArray(spec.required) ? (spec.required as unknown[]).map(String) : [],
      )
      const inner = Object.entries(spec.properties)
        .slice(0, 8)
        .map(([k, v]) => `${k}${required.has(k) ? '' : '?'}: ${describeType(v, depth + 1)}`)
      if (inner.length) return `{ ${inner.join(', ')} }`
    }
  }

  return String(type)
}

/**
 * A one-line sketch of a POST body: property names, their types, and which are
 * required. Enough for the model to build the right envelope without shipping
 * forty full JSON Schemas into the prompt.
 */
export function bodyShapeOf(inputSchema: string | null): string | null {
  if (!inputSchema) return null
  try {
    const body = (JSON.parse(inputSchema) as { body?: SchemaNode }).body
    const properties = body?.properties
    if (!properties) return null

    const required = new Set(
      Array.isArray(body?.required) ? (body.required as unknown[]).map(String) : [],
    )
    const parts = Object.entries(properties)
      .slice(0, 12)
      .map(([name, spec]) => `${name}${required.has(name) ? '' : '?'}: ${describeType(spec)}`)
    return parts.length ? `{ ${parts.join(', ')} }` : null
  } catch {
    return null
  }
}

/**
 * The parameter names an endpoint requires, pulled out of its JSON Schema.
 *
 * Only the names, and only the required ones: the planner needs to know what
 * to fill in, and shipping whole schemas for forty candidates would crowd out
 * the prompt. The runner checks the same list before it pays.
 */
export function requiredParamsOf(inputSchema: string | null): string[] {
  if (!inputSchema) return []
  try {
    const schema = JSON.parse(inputSchema) as {
      queryParams?: { required?: unknown }
      body?: { required?: unknown }
    }
    return [
      ...(Array.isArray(schema.queryParams?.required) ? schema.queryParams.required : []),
      ...(Array.isArray(schema.body?.required) ? schema.body.required : []),
    ].map(String)
  } catch {
    return []
  }
}

/**
 * Drop the catalogued example values for parameters the planner is expected to
 * fill.
 *
 * The geocoding entry was stored as "?name=lagos&count=3" so that the URL was
 * demonstrably working when it was added. But a stored example is
 * indistinguishable from an answer: a request for the University of Ibadan
 * that arrived without a `name` was served Lagos, with HTTP 200 and no hint
 * that anything was wrong. Removing the value means the same call now returns
 * nothing and says so.
 *
 * Only the declared parameters go. Fixed parts of the URL — `count=3`,
 * `format=json`, an API version — are configuration, not answers, and stay.
 */
function withoutExampleValues(resource: string, params?: string[]): string {
  if (!params?.length) return resource
  try {
    const url = new URL(resource)
    for (const name of params) url.searchParams.delete(name)
    return url.toString()
  } catch {
    return resource
  }
}

/**
 * Free public APIs, stored in the same table as x402 services so search,
 * retrieval and the runner treat them uniformly.
 *
 * They are priced at the Arc Testnet verification amount rather than zero: a
 * free call still moves value on chain before it runs, so the cost shown is the
 * cost actually incurred.
 */
/**
 * Test seam: the free-catalog rows exactly as sync would write them, so a test
 * can assert no example value survives into the registry.
 */
export function __testFreeApiRows(): ServiceRow[] {
  return freeApiRows(0)
}

function freeApiRows(syncedAt: number): ServiceRow[] {
  const option: ServiceNetworkOption = {
    network: `eip155:${CHAIN_CONFIGS[VERIFICATION_CHAIN].chain.id}`,
    chainKey: VERIFICATION_CHAIN,
    isTestnet: true,
    priceUsdc: VERIFICATION_AMOUNT_USDC,
    asset: CHAIN_CONFIGS[VERIFICATION_CHAIN].usdc,
    scheme: 'verification',
  }

  return FREE_API_CATALOG.map((api) => ({
    id: `free-${api.id}`,
    resource: withoutExampleValues(api.resource, api.params),
    source: 'free',
    service_name: api.name,
    description: api.description,
    tags: JSON.stringify(
      api.premiumCategory ? [...api.tags, `premium:${api.premiumCategory}`] : api.tags,
    ),
    host: hostOf(api.resource),
    network: option.network,
    chain_key: VERIFICATION_CHAIN,
    is_testnet: 1,
    networks_json: JSON.stringify([option]),
    asset: option.asset,
    price_usdc: VERIFICATION_AMOUNT_USDC,
    scheme: 'verification',
    http_method: 'GET',
    curated: api.curated ? 1 : 0,
    // Free entries are hand-verified, so they rank as used rather than untested.
    calls_30d: api.curated ? 1000 : 100,
    payers_30d: 0,
    last_called_at: null,
    icon_url: null,
    /*
     * Same shape the paid catalog publishes, so requiredParams reaches the
     * planner by the one path. A free endpoint whose URL carries an example
     * value is otherwise indistinguishable from one that takes no input, and
     * the example gets returned as though it were the answer.
     */
    input_schema: api.params?.length
      ? JSON.stringify({
          type: 'http',
          method: 'GET',
          queryParams: {
            type: 'object',
            required: api.params,
            properties: Object.fromEntries(
              api.params.map((name) => [name, { type: 'string', description: 'query parameter' }]),
            ),
          },
        })
      : null,
    synced_at: syncedAt,
  }))
}

async function fetchPage(offset: number): Promise<DiscoveryItem[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    // Only what the agent can actually pay. Filtering at the source keeps the
    // catalog honest — there is no point mirroring listings the wallet cannot
    // settle and the planner would then have to be stopped from proposing.
    const url =
      `${DISCOVERY_URL}?supportsCircleGateway=true&type=http` +
      `&limit=${PAGE_SIZE}&offset=${offset}`
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`discovery returned ${res.status}`)
    const body = (await res.json()) as { items?: DiscoveryItem[] }
    return body.items ?? []
  } finally {
    clearTimeout(timer)
  }
}

export interface SyncResult {
  seen: number
  kept: number
  durationMs: number
}

let syncInFlight: Promise<SyncResult> | null = null

/** Full refresh. Concurrent callers share one run rather than stampeding. */
export function syncRegistry(): Promise<SyncResult> {
  syncInFlight ??= runSync().finally(() => {
    syncInFlight = null
  })
  return syncInFlight
}

async function runSync(): Promise<SyncResult> {
  const startedAt = Date.now()

  /*
   * On a source swap, clear the old provider's listings first. Upsert is keyed
   * by resource, so without this the previous catalog simply stays alongside
   * the new one — thousands of services the agent cannot pay, still visible in
   * the Endpoints page. Free entries are ours and are rewritten every boot.
   */
  if (catalogSourceChanged()) {
    const removed = db.prepare(`DELETE FROM services WHERE source = 'x402'`).run().changes
    console.warn(`[trident] discovery source changed — dropped ${removed} stale services`)
  }
  db.prepare(
    `INSERT INTO registry_sync (id, started_at, status, source_version) VALUES (1, ?, 'running', ?)
     ON CONFLICT(id) DO UPDATE SET started_at = excluded.started_at, status = 'running',
       error = NULL, source_version = excluded.source_version`,
  ).run(Math.floor(startedAt / 1000), CATALOG_VERSION)

  const upsert = db.prepare(`
    INSERT INTO services (
      id, resource, source, service_name, description, tags, host, network, chain_key,
      is_testnet, networks_json, asset, price_usdc, scheme, http_method, curated,
      calls_30d, payers_30d, last_called_at, icon_url, input_schema, synced_at
    ) VALUES (
      @id, @resource, @source, @service_name, @description, @tags, @host, @network, @chain_key,
      @is_testnet, @networks_json, @asset, @price_usdc, @scheme, @http_method, @curated,
      @calls_30d, @payers_30d, @last_called_at, @icon_url, @input_schema, @synced_at
    )
    ON CONFLICT(resource) DO UPDATE SET
      source = excluded.source, service_name = excluded.service_name, description = excluded.description,
      tags = excluded.tags, host = excluded.host, network = excluded.network,
      chain_key = excluded.chain_key, is_testnet = excluded.is_testnet,
      networks_json = excluded.networks_json, asset = excluded.asset,
      input_schema = excluded.input_schema,
      price_usdc = excluded.price_usdc, scheme = excluded.scheme,
      curated = excluded.curated, calls_30d = excluded.calls_30d,
      payers_30d = excluded.payers_30d, last_called_at = excluded.last_called_at,
      icon_url = excluded.icon_url, synced_at = excluded.synced_at
  `)

  let seen = 0
  let kept = 0
  const syncedAt = Math.floor(Date.now() / 1000)

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const items = await fetchPage(page * PAGE_SIZE)
      if (items.length === 0) break
      seen += items.length

      const rows = items
        .map(normalise)
        .filter((r): r is Omit<ServiceRow, 'synced_at'> => r !== null)
        .map((r) => ({ ...r, synced_at: syncedAt }))

      db.transaction(() => {
        for (const row of rows) upsert.run(row)
      })()
      kept += rows.length

      if (items.length < PAGE_SIZE) break
    }

    // Free APIs are part of the same catalog, written every run so a change to
    // the curated list takes effect without a separate migration.
    const freeRows = freeApiRows(syncedAt)
    db.transaction(() => {
      for (const row of freeRows) upsert.run(row)
    })()
    kept += freeRows.length

    // Anything not seen this run has left the registry.
    db.prepare('DELETE FROM services WHERE synced_at IS NULL OR synced_at < ?').run(syncedAt)

    const durationMs = Date.now() - startedAt
    db.prepare(
      `UPDATE registry_sync SET completed_at = ?, total_seen = ?, total_kept = ?, status = 'ok', error = NULL WHERE id = 1`,
    ).run(Math.floor(Date.now() / 1000), seen, kept)
    console.log(`[trident] registry sync: ${kept} services from ${seen} records in ${durationMs}ms`)
    return { seen, kept, durationMs }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    db.prepare(
      `UPDATE registry_sync SET completed_at = ?, status = 'failed', error = ? WHERE id = 1`,
    ).run(Math.floor(Date.now() / 1000), message.slice(0, 300))
    console.error('[trident] registry sync failed:', message)
    throw err
  }
}

/**
 * Write the free catalog without touching the discovery API.
 *
 * The full sync is skipped when the remote registry was fetched recently, which
 * meant a deploy that changed this list left production without it — the free
 * entries are local static data, so they should not wait on a remote refresh.
 * Cheap and idempotent, so it runs on every boot.
 */
export function syncFreeApis(): number {
  const syncedAt = Math.floor(Date.now() / 1000)
  const rows = freeApiRows(syncedAt)
  const upsert = db.prepare(`
    INSERT INTO services (
      id, resource, source, service_name, description, tags, host, network, chain_key,
      is_testnet, networks_json, asset, price_usdc, scheme, http_method, curated,
      calls_30d, payers_30d, last_called_at, icon_url, input_schema, synced_at
    ) VALUES (
      @id, @resource, @source, @service_name, @description, @tags, @host, @network, @chain_key,
      @is_testnet, @networks_json, @asset, @price_usdc, @scheme, @http_method, @curated,
      @calls_30d, @payers_30d, @last_called_at, @icon_url, @input_schema, @synced_at
    )
    ON CONFLICT(resource) DO UPDATE SET
      source = excluded.source, service_name = excluded.service_name,
      description = excluded.description, tags = excluded.tags, host = excluded.host,
      network = excluded.network, chain_key = excluded.chain_key,
      is_testnet = excluded.is_testnet, networks_json = excluded.networks_json,
      asset = excluded.asset, price_usdc = excluded.price_usdc, scheme = excluded.scheme,
      input_schema = excluded.input_schema,
      curated = excluded.curated, calls_30d = excluded.calls_30d,
      synced_at = excluded.synced_at
  `)
  /*
   * Drop free rows that are no longer in the catalog before writing it back.
   *
   * Not housekeeping — required for correctness. The upsert reconciles on
   * `resource`, but `id` is the primary key, so an entry whose URL changed
   * arrives as a new resource carrying an id that is already taken: the insert
   * hits the primary key, the conflict clause does not cover it, and boot
   * fails. Stripping the example values from the geocoding URL is exactly that
   * case. Deleting first also stops the superseded URL lingering as a
   * selectable endpoint, which for the entry that used to answer "lagos" would
   * leave the bug in place under a stale row.
   */
  const keep = rows.map((row) => row.resource)
  db.transaction(() => {
    if (keep.length > 0) {
      db.prepare(
        `DELETE FROM services
          WHERE source = 'free' AND resource NOT IN (${keep.map(() => '?').join(',')})`,
      ).run(...keep)
    }
    for (const row of rows) upsert.run(row)
  })()
  return rows.length
}

/** True when the stored rows came from a different upstream than the code. */
export function catalogSourceChanged(): boolean {
  const row = db.prepare('SELECT source_version FROM registry_sync WHERE id = 1').get() as
    | { source_version: string | null }
    | undefined
  // No row at all is a first boot, which the normal empty-catalog path covers.
  if (!row) return false
  // Compare the source alone. A schema bump alone does not orphan the rows, so
  // it must not trigger the delete this guards.
  return (row.source_version ?? '').split('#')[0] !== CATALOG_SOURCE
}

/**
 * True when the stored catalog must be rebuilt, whatever its age.
 *
 * Two reasons, and the second is the one that bit. Either the upstream changed,
 * or this build reads fields the rows were never written with — and age cannot
 * detect that, because rewriting the code does not make the data older.
 *
 * The final clause is a self-heal for the case already in production, where the
 * version marker says current but not one row carries a schema. It is a cheap
 * indexed count, and it can only fire when the column is empty catalog-wide.
 */
export function catalogNeedsRebuild(): boolean {
  const row = db.prepare('SELECT source_version FROM registry_sync WHERE id = 1').get() as
    | { source_version: string | null }
    | undefined
  if (!row) return false
  if (row.source_version !== CATALOG_VERSION) return true

  const withSchema = db
    .prepare(`SELECT COUNT(*) AS n FROM services WHERE source = 'x402' AND input_schema IS NOT NULL`)
    .get() as { n: number }
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM services WHERE source = 'x402'`)
    .get() as { n: number }
  return total.n > 0 && withSchema.n === 0
}

export function syncStatus(): {
  startedAt: number | null
  completedAt: number | null
  totalKept: number
  status: string | null
  error: string | null
  serviceCount: number
} {
  const row = db.prepare('SELECT * FROM registry_sync WHERE id = 1').get() as
    | { started_at: number; completed_at: number; total_kept: number; status: string; error: string }
    | undefined
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM services').get() as { count: number }
  return {
    startedAt: row?.started_at ?? null,
    completedAt: row?.completed_at ?? null,
    totalKept: row?.total_kept ?? 0,
    status: row?.status ?? null,
    error: row?.error ?? null,
    serviceCount: count,
  }
}

/* ---------------------------------------------------------------- reading */

export function rowToService(row: ServiceRow): Service {
  const networks = safeParse<ServiceNetworkOption[]>(row.networks_json, [])
  const tags = safeParse<string[]>(row.tags, [])
  // premiumCategory rides along in tags as a prefixed entry so the free catalog
  // needs no extra column.
  const premiumTag = tags.find((t) => t.startsWith('premium:'))
  return {
    id: row.id,
    resource: row.resource,
    source: (row.source as ServiceSource) ?? 'x402',
    serviceName: row.service_name ?? row.host ?? 'Unnamed service',
    premiumCategory: premiumTag ? premiumTag.slice('premium:'.length) : null,
    description: row.description ?? '',
    tags: tags.filter((t) => !t.startsWith('premium:')),
    host: row.host ?? '',
    network: row.network,
    chainKey: (row.chain_key as SupportedChainName | null) ?? null,
    isTestnet: row.is_testnet === 1,
    networks,
    priceUsdc: row.price_usdc ?? 0,
    httpMethod: (row.http_method as 'GET' | 'POST') ?? 'GET',
    curated: row.curated === 1,
    calls30d: row.calls_30d,
    payers30d: row.payers_30d,
    lastCalledAt: row.last_called_at,
    iconUrl: row.icon_url,
    trust: row.curated === 1 ? 'curated' : row.calls_30d > 0 ? 'active' : 'untested',
    requiredParams: requiredParamsOf(row.input_schema),
    bodyShape: row.http_method === 'POST' ? bodyShapeOf(row.input_schema) : null,
    paramLocation: paramLocationOf(row.input_schema),
    paramEnums: paramEnumsOf(row.input_schema),
  }
}

function safeParse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

export interface SearchOptions {
  query?: string
  curatedOnly?: boolean
  /** 'free' = public APIs metered on testnet; 'x402' = paid services. */
  source?: ServiceSource
  /** Restrict to services settleable on these chains. */
  chains?: SupportedChainName[]
  limit?: number
  offset?: number
}

export function searchServices(options: SearchOptions = {}): {
  services: Service[]
  total: number
} {
  const { query = '', curatedOnly = false, source, chains, limit = 30, offset = 0 } = options
  const where: string[] = []
  const params: Record<string, unknown> = {}

  if (source) {
    where.push('source = @source')
    params['source'] = source
  }

  if (query.trim()) {
    where.push('(service_name LIKE @q OR description LIKE @q OR tags LIKE @q OR host LIKE @q)')
    params['q'] = `%${query.trim()}%`
  }
  if (curatedOnly) where.push('curated = 1')
  if (chains?.length) {
    // networks_json holds every settleable option, so match against it rather
    // than the single preferred chain.
    const clauses = chains.map((c, i) => {
      params[`c${i}`] = `%"chainKey":"${c}"%`
      return `networks_json LIKE @c${i}`
    })
    where.push(`(${clauses.join(' OR ')})`)
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM services ${clause}`)
    .get(params) as { total: number }

  const rows = db
    .prepare(
      `SELECT * FROM services ${clause}
       ORDER BY curated DESC, calls_30d DESC, service_name ASC
       LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset }) as ServiceRow[]

  return { services: rows.map(rowToService), total }
}

export function findServiceByResource(resource: string): Service | null {
  const row = db.prepare('SELECT * FROM services WHERE resource = ?').get(resource) as
    | ServiceRow
    | undefined
  return row ? rowToService(row) : null
}

/** The runner's allowlist: an endpoint must be a known registry resource. */
export function isKnownResource(resource: string): boolean {
  const row = db.prepare('SELECT 1 FROM services WHERE resource = ?').get(resource)
  return row !== undefined
}

export function categories(): string[] {
  const rows = db
    .prepare(`SELECT tags FROM services WHERE tags IS NOT NULL AND tags != '[]' LIMIT 4000`)
    .all() as { tags: string }[]
  const counts = new Map<string, number>()
  for (const r of rows) {
    for (const tag of safeParse<string[]>(r.tags, [])) {
      const t = tag.trim().toLowerCase()
      if (t.length > 1 && t.length < 24) counts.set(t, (counts.get(t) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 24)
    .map(([tag]) => tag)
}
