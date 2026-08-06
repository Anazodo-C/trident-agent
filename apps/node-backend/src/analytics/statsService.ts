import db from '../db.ts'

/**
 * Aggregate usage statistics.
 *
 * Everything here is derived from tasks and task_steps, which the runner
 * already writes as it executes — there is no separate event pipeline to drift
 * out of sync with what actually happened.
 *
 * Read-only and scoped to the requesting user unless `userId` is omitted.
 */

export interface Totals {
  uniqueUsers: number
  walletsCreated: number
  runs: number
  stepsExecuted: number
  transactions: number
  totalSpentUsdc: number
  endpointsCalled: number
  servicesUsed: number
  freeCalls: number
  paidCalls: number
}

export interface Breakdown {
  label: string
  count: number
  amountUsdc: number
}

export interface TimePoint {
  day: string
  runs: number
  spentUsdc: number
  activeUsers: number
}

export interface Stats {
  totals: Totals
  successRate: number
  avgCostPerRun: number
  avgStepsPerRun: number
  runsByStatus: Breakdown[]
  topServices: Breakdown[]
  spendByChain: Breakdown[]
  failureReasons: Breakdown[]
  daily: TimePoint[]
  registry: { total: number; free: number; x402: number; curated: number }
}

/**
 * Scope fragments so the same queries serve the personal and global view.
 *
 * The user filter is expressed as a bare predicate rather than a whole WHERE
 * clause: some queries need a LEFT JOIN between FROM and WHERE, and splicing a
 * ready-made WHERE in ahead of the join produces invalid SQL.
 */
function scope(userId: string | null): {
  /** Predicate to AND into a WHERE clause, or '1=1' when unscoped. */
  userPredicate: string
  params: Record<string, unknown>
} {
  return userId
    ? { userPredicate: 't.user_id = @userId', params: { userId } }
    : { userPredicate: '1=1', params: {} }
}

function round(n: number, dp = 6): number {
  return Number((n || 0).toFixed(dp))
}

export function buildStats(userId: string | null, days = 30): Stats {
  const { userPredicate, params } = scope(userId)
  // FROM/JOIN only — any LEFT JOIN must be appended before the WHERE clause.
  const stepFrom = 'FROM task_steps s JOIN tasks t ON t.id = s.task_id'

  const totalsRow = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM users) AS uniqueUsers,
         (SELECT COUNT(*) FROM users WHERE eoa_address IS NOT NULL) AS walletsCreated,
         (SELECT COUNT(*) FROM tasks t WHERE ${userPredicate}) AS runs,
         (SELECT COUNT(*) ${stepFrom} WHERE ${userPredicate}) AS stepsExecuted,
         -- A transaction is a settled step: it has an on-chain reference.
         (SELECT COUNT(*) ${stepFrom} WHERE ${userPredicate} AND s.tx_ref IS NOT NULL) AS transactions,
         (SELECT COALESCE(SUM(s.actual_cost_usdc), 0) ${stepFrom} WHERE ${userPredicate}) AS totalSpentUsdc,
         (SELECT COUNT(DISTINCT s.endpoint_url) ${stepFrom} WHERE ${userPredicate}) AS endpointsCalled,
         (SELECT COUNT(DISTINCT s.service_name) ${stepFrom} WHERE ${userPredicate}) AS servicesUsed`,
    )
    .get(params) as Record<string, number>

  // Free vs paid is decided by the registry, not by cost, so a mispriced row
  // cannot misclassify a call.
  const sourceSplit = db
    .prepare(
      `SELECT COALESCE(sv.source, 'x402') AS source, COUNT(*) AS n
       ${stepFrom}
       LEFT JOIN services sv ON sv.resource = s.endpoint_url
       WHERE ${userPredicate} AND s.status = 'done'
       GROUP BY COALESCE(sv.source, 'x402')`,
    )
    .all(params) as { source: string; n: number }[]

  const runsByStatus = db
    .prepare(
      `SELECT t.status AS label, COUNT(*) AS count, COALESCE(SUM(t.total_cost_usdc), 0) AS amountUsdc
       FROM tasks t WHERE ${userPredicate}
       GROUP BY t.status ORDER BY count DESC`,
    )
    .all(params) as Breakdown[]

  const topServices = db
    .prepare(
      `SELECT s.service_name AS label, COUNT(*) AS count,
              COALESCE(SUM(s.actual_cost_usdc), 0) AS amountUsdc
       ${stepFrom}
       WHERE ${userPredicate} AND s.status = 'done'
       GROUP BY s.service_name ORDER BY count DESC, amountUsdc DESC LIMIT 10`,
    )
    .all(params) as Breakdown[]

  const spendByChain = db
    .prepare(
      `SELECT COALESCE(sv.chain_key, 'unknown') AS label, COUNT(*) AS count,
              COALESCE(SUM(s.actual_cost_usdc), 0) AS amountUsdc
       ${stepFrom}
       LEFT JOIN services sv ON sv.resource = s.endpoint_url
       WHERE ${userPredicate} AND s.status = 'done'
       GROUP BY COALESCE(sv.chain_key, 'unknown') ORDER BY count DESC`,
    )
    .all(params) as Breakdown[]

  // Failure text is free-form, so bucket by its leading phrase rather than
  // listing every distinct message.
  const failureReasons = db
    .prepare(
      `SELECT substr(COALESCE(s.response_summary, 'unknown'), 1, 60) AS label,
              COUNT(*) AS count, 0 AS amountUsdc
       ${stepFrom}
       WHERE ${userPredicate} AND s.status = 'failed'
       GROUP BY label ORDER BY count DESC LIMIT 8`,
    )
    .all(params) as Breakdown[]

  const daily = db
    .prepare(
      `SELECT date(t.created_at, 'unixepoch') AS day,
              COUNT(*) AS runs,
              COALESCE(SUM(t.total_cost_usdc), 0) AS spentUsdc,
              COUNT(DISTINCT t.user_id) AS activeUsers
       FROM tasks t
       WHERE ${userPredicate} AND t.created_at >= strftime('%s','now') - (@days * 86400)
       GROUP BY day ORDER BY day ASC`,
    )
    .all({ ...params, days }) as TimePoint[]

  const stepStatus = db
    .prepare(
      `SELECT s.status AS label, COUNT(*) AS count ${stepFrom}
       WHERE ${userPredicate} GROUP BY s.status`,
    )
    .all(params) as { label: string; count: number }[]

  const doneSteps = stepStatus.find((r) => r.label === 'done')?.count ?? 0
  const finishedSteps = stepStatus
    .filter((r) => r.label === 'done' || r.label === 'failed')
    .reduce((sum, r) => sum + r.count, 0)

  const registry = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(source = 'free') AS free,
              SUM(source = 'x402') AS x402,
              SUM(curated = 1) AS curated
       FROM services`,
    )
    .get() as { total: number; free: number; x402: number; curated: number }

  const runs = totalsRow['runs'] ?? 0

  return {
    totals: {
      uniqueUsers: totalsRow['uniqueUsers'] ?? 0,
      walletsCreated: totalsRow['walletsCreated'] ?? 0,
      runs,
      stepsExecuted: totalsRow['stepsExecuted'] ?? 0,
      transactions: totalsRow['transactions'] ?? 0,
      totalSpentUsdc: round(totalsRow['totalSpentUsdc'] ?? 0),
      endpointsCalled: totalsRow['endpointsCalled'] ?? 0,
      servicesUsed: totalsRow['servicesUsed'] ?? 0,
      freeCalls: sourceSplit.find((r) => r.source === 'free')?.n ?? 0,
      paidCalls: sourceSplit.find((r) => r.source === 'x402')?.n ?? 0,
    },
    successRate: finishedSteps > 0 ? round(doneSteps / finishedSteps, 4) : 0,
    avgCostPerRun: runs > 0 ? round((totalsRow['totalSpentUsdc'] ?? 0) / runs) : 0,
    avgStepsPerRun: runs > 0 ? round((totalsRow['stepsExecuted'] ?? 0) / runs, 2) : 0,
    runsByStatus: runsByStatus.map((r) => ({ ...r, amountUsdc: round(r.amountUsdc) })),
    topServices: topServices.map((r) => ({ ...r, amountUsdc: round(r.amountUsdc) })),
    spendByChain: spendByChain.map((r) => ({ ...r, amountUsdc: round(r.amountUsdc) })),
    failureReasons,
    daily: daily.map((d) => ({ ...d, spentUsdc: round(d.spentUsdc) })),
    registry: {
      total: registry.total ?? 0,
      free: registry.free ?? 0,
      x402: registry.x402 ?? 0,
      curated: registry.curated ?? 0,
    },
  }
}
