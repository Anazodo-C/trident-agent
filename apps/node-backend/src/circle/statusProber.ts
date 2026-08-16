import db from '../db.ts'
import { noteEndpointReachable, noteEndpointUnreachable } from './candidateService.ts'
import { STATUS_PROBER_ENABLED } from '../env.ts'
import { fillTemplate, isTemplated } from './pathParams.ts'

/**
 * Continuous reachability checks over the whole catalog.
 *
 * The probe is an unpaid request. No payment header is ever sent, so nothing
 * can be charged and no paid work can run on the seller's side — and the 402
 * that comes back is not a failure but the most informative answer available:
 * it carries the seller's live terms, which proves in one round trip that DNS,
 * TLS and the host are up, the path still exists, and the service still sells.
 *
 * Pacing is the whole design. Probing all ~936 endpoints every five seconds
 * would be 187 requests a second, forever, with sixty of them landing on a
 * single provider — indistinguishable from an attack, and aimed squarely at the
 * providers the agent depends on. Instead a slice of 16 goes out every five
 * seconds, round-robin, so every endpoint is refreshed inside five minutes and
 * something is always in flight, at roughly 3 requests a second in total.
 *
 * Hosts are swept separately and much more cheaply. A provider going dark is
 * the common failure and it takes out every one of its endpoints at once, so
 * checking 44 origins every 30 seconds catches it far faster than waiting for
 * the rolling slice to walk 302 paths, and spares the provider 302 timeouts
 * while it is already having a bad day.
 */

export type ProbeState = 'live' | 'answering' | 'throttled' | 'gone' | 'erroring' | 'down'

/** States that mean the endpoint answered. The status page's Reachable tab. */
const REACHABLE: ReadonlySet<ProbeState> = new Set<ProbeState>(['live', 'answering', 'throttled'])

export function isReachableState(state: ProbeState): boolean {
  return REACHABLE.has(state)
}

const SLICE_SIZE = 16
const SLICE_INTERVAL_MS = 5_000
const HOST_SWEEP_INTERVAL_MS = 30_000
const PROBE_TIMEOUT_MS = 8_000
const PER_HOST_CONCURRENCY = 4
const GLOBAL_CONCURRENCY = 24

/**
 * Named so a provider reading their logs can tell what this is and where to
 * complain. An anonymous crawler hitting an API every few seconds is the kind
 * of thing that gets an IP blocked without anyone asking why.
 */
const USER_AGENT = 'TridentStatus/1.0 (+https://status.tridentagent.xyz)'

/**
 * Consecutive hard failures before an endpoint is written off in the column the
 * planner reads.
 *
 * Two, not one. `unreachable_since` decides what the agent is allowed to
 * propose, and a single blip — a dropped connection, a provider restarting —
 * must not cost a working seller its place in the catalog. Any success clears
 * the streak immediately, so recovery is instant while condemnation is slow.
 */
const FAIL_STREAK_TO_CONDEMN = 2


/**
 * Turn one response into a state.
 *
 * The governing rule, inherited from `noteEndpointUnreachable`: a 4xx means the
 * endpoint answered, which is the opposite of unreachable. Only silence, a
 * server error, or a path that is definitively absent count against it.
 */
export function classifyProbe(
  status: number | null,
  hasTerms: boolean,
  templated: boolean,
): ProbeState {
  // Null means nothing came back at all — DNS, TLS, refused, timeout.
  if (status === null) return 'down'
  // The terms are what separate "still selling at a known price" from merely
  // "something is listening": a 402 without a parseable challenge tells the
  // runner nothing it can pay against.
  if (status === 402) return hasTerms ? 'live' : 'answering'
  if (status >= 200 && status < 300) return 'live'
  // Being rate-limited is proof of life, and treating it as an outage would
  // turn our own impatience into a red dot on someone else's service.
  if (status === 429) return 'throttled'
  if (status === 404 || status === 410) {
    // On a templated path a 404 is inconclusive: either the path is gone, or
    // the id we invented does not exist — which is the endpoint working
    // correctly. `/agentphone/v1/calls/probe` 404s for exactly that reason.
    // Never condemn a path over an identifier we made up.
    return templated ? 'answering' : 'gone'
  }
  if (status >= 400 && status < 500) return 'answering'
  return 'erroring'
}

export interface ProbeResult {
  state: ProbeState
  status: number | null
  latencyMs: number
}

/** Limits how many requests may be in flight, overall and per provider. */
class Gate {
  private active = 0
  private readonly queue: (() => void)[] = []
  // Assigned in the body rather than as a parameter property: the backend runs
  // under node --experimental-strip-types, which cannot rewrite those.
  private readonly limit: number

  constructor(limit: number) {
    this.limit = limit
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve))
    }
    this.active += 1
    try {
      return await fn()
    } finally {
      this.active -= 1
      this.queue.shift()?.()
    }
  }
}

const globalGate = new Gate(GLOBAL_CONCURRENCY)
const hostGates = new Map<string, Gate>()

function gateFor(host: string): Gate {
  let gate = hostGates.get(host)
  if (!gate) {
    gate = new Gate(PER_HOST_CONCURRENCY)
    hostGates.set(host, gate)
  }
  return gate
}

export function hostOf(resource: string): string {
  try {
    return new URL(resource).host
  } catch {
    return resource
  }
}

/**
 * Probe a single endpoint.
 *
 * Never throws: a prober that can fall over takes the whole status page with
 * it, and "we could not tell" is itself a result worth recording.
 */
export async function probeOnce(
  resource: string,
  method: string,
): Promise<ProbeResult> {
  const templated = isTemplated(resource)
  const url = fillTemplate(resource)
  const verb = method === 'POST' ? 'POST' : 'GET'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  const started = Date.now()

  try {
    const response = await fetch(url, {
      method: verb,
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      // An empty object rather than no body: several sellers parse before they
      // reach their payment gate and answer 400 to a bodyless POST.
      ...(verb === 'POST' ? { body: '{}' } : {}),
    })
    // Same header quoteFromEndpoint reads. Presence is enough here — the price
    // itself belongs to the payment path, not to a liveness check.
    const hasTerms = response.headers.get('payment-required') !== null
    // Drain so the socket can be reused rather than left hanging.
    await response.arrayBuffer().catch(() => undefined)
    return {
      state: classifyProbe(response.status, hasTerms, templated),
      status: response.status,
      latencyMs: Date.now() - started,
    }
  } catch {
    return { state: 'down', status: null, latencyMs: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Is the provider itself reachable?
 *
 * Any HTTP answer counts, including a 404 — most API hosts serve nothing at
 * their root, and this question is only ever about DNS, TLS and the connection.
 */
async function probeHost(host: string): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    await fetch(`https://${host}/`, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { 'user-agent': USER_AGENT },
    })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

const recordProbe = db.prepare(
  `UPDATE services
      SET probe_state = ?, probe_status = ?, probe_latency_ms = ?, probe_checked_at = ?,
          probe_fail_streak = ?
    WHERE resource = ?`,
)

const readStreak = db.prepare(`SELECT probe_fail_streak FROM services WHERE resource = ?`)

/**
 * Write one result, and decide whether it changes what the agent may propose.
 *
 * The status page and the planner read the same column deliberately: an
 * endpoint shown red here is one the agent stops offering, so the page is not a
 * separate opinion about the catalog but the catalog's own account of itself.
 */
function persist(resource: string, result: ProbeResult): void {
  const reachable = isReachableState(result.state)
  const previous = (readStreak.get(resource) as { probe_fail_streak?: number } | undefined)
  const streak = reachable ? 0 : (previous?.probe_fail_streak ?? 0) + 1

  recordProbe.run(
    result.state,
    result.status,
    result.latencyMs,
    Date.now(),
    streak,
    resource,
  )

  if (reachable) {
    noteEndpointReachable(resource)
  } else if (streak >= FAIL_STREAK_TO_CONDEMN) {
    noteEndpointUnreachable(resource)
  }
}

/** The hysteresis rule is the reason this module can affect the agent, so it is
 *  reachable from tests without exporting the write path to the rest of the app. */
export function __testPersist(resource: string, result: ProbeResult): void {
  persist(resource, result)
}

interface Target {
  resource: string
  http_method: string
  host: string | null
}

let cursor = 0
/** Hosts that failed their last origin check, so their endpoints are skipped. */
const darkHosts = new Set<string>()
let snapshotDirty = true

function targets(): Target[] {
  return db
    .prepare(`SELECT resource, http_method, host FROM services ORDER BY host, resource`)
    .all() as Target[]
}

/** One rolling slice: the next SLICE_SIZE endpoints, wrapping at the end. */
async function runSlice(): Promise<void> {
  const rows = targets()
  if (rows.length === 0) return
  if (cursor >= rows.length) cursor = 0

  const slice = rows.slice(cursor, cursor + SLICE_SIZE)
  cursor = (cursor + SLICE_SIZE) % rows.length

  await Promise.all(
    slice.map(async (row) => {
      const host = row.host ?? hostOf(row.resource)
      // The origin check already answered for this one. Recording it without a
      // request is both faster and kinder than adding to a struggling host's load.
      if (darkHosts.has(host)) {
        persist(row.resource, { state: 'down', status: null, latencyMs: 0 })
        return
      }
      const result = await globalGate.run(() =>
        gateFor(host).run(() => probeOnce(row.resource, row.http_method)),
      )
      persist(row.resource, result)
    }),
  )
  snapshotDirty = true
}

/** Every host at once — 44 HEAD requests, one per provider. */
async function runHostSweep(): Promise<void> {
  const hosts = (
    db.prepare(`SELECT DISTINCT host FROM services WHERE host IS NOT NULL`).all() as {
      host: string
    }[]
  ).map((r) => r.host)

  await Promise.all(
    hosts.map(async (host) => {
      const up = await globalGate.run(() => gateFor(host).run(() => probeHost(host)))
      if (up) darkHosts.delete(host)
      else darkHosts.add(host)
    }),
  )
}

export interface StatusEndpoint {
  path: string
  host: string
  method: string
  priceUsdc: number
  free: boolean
  state: ProbeState
  status: number | null
  latencyMs: number | null
  checkedAt: number | null
  reachable: boolean
}

export interface StatusSnapshot {
  sweptAt: number | null
  total: number
  reachable: number
  confirmedSelling: number
  providers: number
  byState: Record<string, number>
  endpoints: StatusEndpoint[]
}

let cached: { json: string; etag: string } | null = null
let cachedSummary: { json: string; etag: string } | null = null

function pathOf(resource: string, host: string): string {
  try {
    const url = new URL(resource)
    return url.pathname + url.search
  } catch {
    return resource.replace(`https://${host}`, '')
  }
}

function build(): StatusSnapshot {
  const rows = db
    .prepare(
      `SELECT resource, host, http_method, price_usdc, source,
              probe_state, probe_status, probe_latency_ms, probe_checked_at
         FROM services
        ORDER BY host, resource`,
    )
    .all() as {
    resource: string
    host: string | null
    http_method: string
    price_usdc: number | null
    source: string
    probe_state: string | null
    probe_status: number | null
    probe_latency_ms: number | null
    probe_checked_at: number | null
  }[]

  const byState: Record<string, number> = {}
  let reachable = 0
  let sweptAt: number | null = null

  const endpoints = rows.map((r) => {
    const host = r.host ?? hostOf(r.resource)
    // Unprobed rows are 'live' by assumption rather than 'down': a service that
    // has not had its turn yet is not evidence of an outage, and showing a red
    // dot for one would make a cold start look like a catastrophe.
    const state = (r.probe_state as ProbeState | null) ?? 'live'
    const ok = isReachableState(state)
    if (ok) reachable += 1
    byState[state] = (byState[state] ?? 0) + 1
    if (r.probe_checked_at && (sweptAt === null || r.probe_checked_at > sweptAt)) {
      sweptAt = r.probe_checked_at
    }
    return {
      path: pathOf(r.resource, host),
      host,
      method: r.http_method,
      priceUsdc: r.price_usdc ?? 0,
      free: r.source === 'free',
      state,
      status: r.probe_status,
      latencyMs: r.probe_latency_ms,
      checkedAt: r.probe_checked_at,
      reachable: ok,
    }
  })

  return {
    sweptAt,
    total: endpoints.length,
    reachable,
    confirmedSelling: byState['live'] ?? 0,
    providers: new Set(endpoints.map((e) => e.host)).size,
    byState,
    endpoints,
  }
}

/**
 * The payload, serialised once per sweep rather than per request.
 *
 * Every visitor polls this every five seconds, so the cost of rebuilding it has
 * to be paid by the prober, not by the reader. Rebuilt lazily on the first
 * request after a tick, so an idle page costs nothing at all.
 */
export function statusPayload(): { json: string; etag: string } {
  rebuildIfStale()
  return cached!
}

/**
 * The same figures without the endpoint list.
 *
 * The full body is roughly 205KB because of ~1,000 endpoint records. The
 * landing page wants four integers from it, and making every visitor to the
 * busiest public page download a thousand rows to render four numbers is not a
 * trade worth making.
 *
 * Built in the same pass as the full payload and invalidated by the same flag,
 * so a reader still never pays for serialisation. Its ETag is derived from its
 * own bytes: sharing one with the full payload would tell a client that had
 * seen the summary that the full body was unchanged, and it would render the
 * counts with no endpoints at all.
 */
export function statusSummaryPayload(): { json: string; etag: string } {
  rebuildIfStale()
  return cachedSummary!
}

function rebuildIfStale(): void {
  if (cached && cachedSummary && !snapshotDirty) return

  const snapshot = build()
  const json = JSON.stringify(snapshot)
  cached = { json, etag: etagFor('f', json) }

  const { endpoints: _endpoints, ...summary } = snapshot
  const summaryJson = JSON.stringify(summary)
  cachedSummary = { json: summaryJson, etag: etagFor('s', summaryJson) }

  snapshotDirty = false
}

/** Prefixed per variant so two bodies of equal length cannot collide. */
function etagFor(kind: string, json: string): string {
  return `W/"${kind}${json.length.toString(36)}-${Date.now().toString(36)}"`
}

/** Uncached, for tests and for callers that want the object rather than bytes. */
export function statusSnapshot(): StatusSnapshot {
  return build()
}

let started = false

export function startProber(): void {
  if (started) return
  if (!STATUS_PROBER_ENABLED) {
    console.log('[trident] status prober disabled (set STATUS_PROBER=on to enable)')
    return
  }
  started = true

  const slice = Math.round((SLICE_SIZE / (SLICE_INTERVAL_MS / 1000)) * 10) / 10
  console.log(
    `[trident] status prober: ${SLICE_SIZE} endpoints every ${SLICE_INTERVAL_MS / 1000}s ` +
      `(~${slice} req/s), hosts every ${HOST_SWEEP_INTERVAL_MS / 1000}s`,
  )

  // A failing tick must never stop the timer, or the page silently freezes at
  // whatever it last knew while claiming to be live.
  const guard = (label: string, fn: () => Promise<void>) => () => {
    fn().catch((err) => console.error(`[trident] status ${label} failed:`, String(err)))
  }

  setInterval(guard('slice', runSlice), SLICE_INTERVAL_MS).unref()
  setInterval(guard('host sweep', runHostSweep), HOST_SWEEP_INTERVAL_MS).unref()
  // Hosts first: knowing which providers are dark makes the first slices both
  // cheaper and more accurate.
  void guard('host sweep', runHostSweep)()
}
