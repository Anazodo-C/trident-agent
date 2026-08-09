import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import {
  ANTHROPIC_API_KEY,
  ANTHROPIC_BASE_URL,
  ANTHROPIC_ENABLED,
  ANTHROPIC_MODEL,
} from '../env.ts'
import type { Service } from '../circle/registryService.ts'

const MAX_RETRIES = 3

let client: Anthropic | null = null
function anthropic(): Anthropic {
  if (!ANTHROPIC_ENABLED) {
    throw Object.assign(new Error('Planner unavailable: ANTHROPIC_API_KEY is not configured'), {
      status: 503,
    })
  }
  // baseURL only when configured, so the default stays Anthropic's own.
  client ??= new Anthropic({
    apiKey: ANTHROPIC_API_KEY,
    ...(ANTHROPIC_BASE_URL ? { baseURL: ANTHROPIC_BASE_URL } : {}),
  })
  return client
}

export const StepSchema = z.object({
  stepIndex: z.number().int().nonnegative(),
  serviceName: z.string().min(1),
  endpointUrl: z.string().url(),
  httpMethod: z.enum(['GET', 'POST']),
  /**
   * Request inputs: query parameters for a GET, the request body for a POST.
   *
   * Any JSON value, because a POST body is not always flat — Goldsky's
   * JSON-RPC endpoints want {jsonrpc, id, method, params: []}, and a schema
   * limited to scalars could not express that, so the body went out malformed
   * and the endpoint answered "failed to unmarshal json-rpc request" after the
   * payment had settled. Query strings are flattened at request time instead.
   */
  params: z.record(z.unknown()).default({}),
  purpose: z.string().min(1),
  estimatedCostUsdc: z.number().nonnegative(),
})

/**
 * Provenance attached to each step after planning. The model does not produce
 * these — they are looked up from the registry, so the approval card shows the
 * user facts rather than the model's claims about them.
 */
export interface StepAnnotation {
  trust: 'curated' | 'active' | 'untested'
  calls30d: number
  host: string
  chain: string | null
  isTestnet: boolean
  /** Set when the step cannot be paid under the user's current chain policy. */
  blockedReason?: string
  /** Shown on the approval card when the endpoint has no recorded usage. */
  warning?: string
}

export type AnnotatedStep = PlanStep & { annotation: StepAnnotation }

/**
 * A second, more reliable way to do the same job — offered alongside the
 * cheapest one so the user can trade cost against reliability knowingly.
 * Null when the cheapest route is already the most reliable.
 */
export const RouteSchema = z.object({
  steps: z.array(StepSchema),
  rationale: z.string(),
})

export type PlanRoute = z.infer<typeof RouteSchema>

export const PlanSchema = z.object({
  goal: z.string(),
  steps: z.array(StepSchema),
  totalEstimatedCostUsdc: z.number().nonnegative(),
  reasoning: z.string(),
  alternativeSteps: z.array(StepSchema).default([]),
  // Present even when it exceeds the cap: an unaffordable route is exactly
  // what the budget guidance needs in order to quote a figure.
  alternativeRoute: RouteSchema.nullable().default(null),
  minCostUsdc: z.number().nonnegative().optional(),
})

export type PlanStep = z.infer<typeof StepSchema>
export type ExecutionPlan = z.infer<typeof PlanSchema>

export function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence?.[1]) return fence[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) return text.slice(start, end + 1)
  throw new Error('No JSON found in LLM response')
}

function textOf(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

function systemPrompt(candidates: Service[]): string {
  // Only the fields that help the model choose. The registry holds ~14k
  // services; these are the shortlist retrieved for this specific goal.
  const compact = candidates.map((s) => ({
    name: s.serviceName,
    url: s.resource,
    description: s.description.slice(0, 220),
    tags: s.tags.slice(0, 6),
    priceUsdc: s.priceUsdc,
    // Without this the model has to guess the verb, and a wrong guess is a 405
    // from the endpoint. It is overwritten from the registry after planning
    // regardless — this is here so the plan the user approves is coherent.
    httpMethod: s.httpMethod,
    // Named so the model fills them in. An endpoint called without its
    // required parameters answers 400 after the payment has authorised.
    requiredParams: s.requiredParams,
    // POST bodies are structured, and the shape cannot be guessed from a list
    // of names — 210 of the 215 POST services publish one.
    ...(s.bodyShape ? { bodyShape: s.bodyShape } : {}),
    trust: s.trust,
    callsLast30Days: s.calls30d,
  }))

  return `You are Trident's planning engine. Given a user goal and a shortlist of x402-payable services, output a minimal, cost-effective execution plan as pure JSON. No markdown. No prose outside JSON.

Each service costs real money per call, charged to the user's wallet. Spend as little as possible.

Services:
${JSON.stringify(compact, null, 2)}

Rules:
- Only include services genuinely needed to accomplish the goal.
- endpointUrl MUST be copied exactly from a service's "url". Never invent, modify, or append to a URL.
- serviceName MUST match that service's "name" exactly.
- estimatedCostUsdc MUST equal that service's "priceUsdc".
- httpMethod MUST equal that service's "httpMethod". Do not infer it from the endpoint's name or purpose.
- "params" MUST include every name listed in that service's "requiredParams", filled with a value drawn from the goal. The run is now stopped before any payment when one is missing, so an omission costs the user their answer.
- Every required value must come from the goal. Never carry over an example from a description or a URL, and never invent a placeholder to fill a slot — if the goal does not supply what a service requires, that service is the wrong choice for it.
- For a GET, "params" are query parameters and each value must be a string, number, boolean, or an array of those.
- For a POST, "params" IS the request body. When the service has a "bodyShape", follow it exactly, including nested objects and arrays. A JSON-RPC service needs the full envelope, e.g. {"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]} — not a flattened key/value map.
- Fill "params" by name in both cases. Whether they travel in the query string or the body is decided from the service's schema after planning, so do not restructure them for it.
- Prefer trust "curated", then "active". A service with trust "untested" has no recorded usage and may not work — only choose one when nothing else fits the goal.
- Order steps logically; stepIndex starts at 0 and increases by 1.
- totalEstimatedCostUsdc must equal the sum of the steps' estimatedCostUsdc.
- If none of these services can address the goal, return "steps": [] and say so plainly in "reasoning". Do not substitute an unrelated service.

Two routes:
- "steps" is the CHEAPEST route that genuinely accomplishes the goal. Cost is the only thing being minimised here; it must still do the whole job.
- "alternativeRoute" is a MORE RELIABLE route for the same goal — higher trust tiers, more recorded usage, or better-suited services — even when it costs more. Set it to null if the cheapest route is already the most reliable one available, or if no second route exists. Never pad it with extra calls just to make it different.
- Cost the two independently. Do not make the cheapest route worse in order to create a contrast.

Spending limit:
- A limit is given below. It is absolute and set by the user: never plan above it, and never assume it can be raised.
- If the cheapest route that accomplishes the goal costs MORE than the limit, still return it in "steps", and set minCostUsdc to its total. It will be shown to the user as a quote, not run. Do not substitute a cheaper route that does not actually accomplish the goal.

Respond with exactly this JSON shape:
{"goal":string,"steps":[{"stepIndex":number,"serviceName":string,"endpointUrl":string,"httpMethod":"GET"|"POST","params":object (a GET's query parameters, or a POST's full request body — nested objects and arrays allowed),"purpose":string,"estimatedCostUsdc":number}],"totalEstimatedCostUsdc":number,"reasoning":string,"alternativeSteps":[],"alternativeRoute":{"steps":[...same step shape...],"rationale":string}|null,"minCostUsdc":number}`
}

/**
 * Reject any step the model invented. A hallucinated URL would otherwise become
 * a real payment attempt against an arbitrary host, so this compares against
 * the exact resource URLs offered — never a prefix.
 */
export function assertStepsAreCatalogued(plan: ExecutionPlan, candidates: Service[]): void {
  const allowed = new Set(candidates.map((s) => s.resource))
  // The alternative route is quoted to the user and can be approved, so it is
  // held to the same standard as the primary one.
  const all = [...plan.steps, ...(plan.alternativeRoute?.steps ?? [])]
  const offending = all.find((s) => !allowed.has(s.endpointUrl))
  if (offending) {
    throw new Error(
      `Planner produced an endpoint outside the offered shortlist: ${offending.endpointUrl}`,
    )
  }
}

/** Renumber and recompute so downstream code can trust these invariants. */
export function normalise(plan: ExecutionPlan): ExecutionPlan {
  const steps = plan.steps.map((s, i) => ({ ...s, stepIndex: i }))
  const total = steps.reduce((sum, s) => sum + s.estimatedCostUsdc, 0)

  const alternativeRoute = plan.alternativeRoute
    ? {
        ...plan.alternativeRoute,
        steps: plan.alternativeRoute.steps.map((s, i) => ({ ...s, stepIndex: i })),
      }
    : null

  // A route identical to the primary is not an alternative, and showing the
  // same thing twice at two prices would be worse than showing it once.
  const sameAsPrimary =
    alternativeRoute !== null &&
    alternativeRoute.steps.length === steps.length &&
    alternativeRoute.steps.every((s, i) => s.endpointUrl === steps[i]?.endpointUrl)

  return {
    ...plan,
    steps,
    totalEstimatedCostUsdc: Number(total.toFixed(6)),
    alternativeRoute: sameAsPrimary ? null : alternativeRoute,
  }
}

export interface PlanLimits {
  /** The account spending cap. Absolute — the planner is never told to exceed it. */
  capUsdc: number
  /** Optional per-run budget, which can only tighten the cap. */
  budgetUsdc?: number | undefined
}

export async function buildPlan(
  goal: string,
  candidates: Service[],
  limits: PlanLimits,
): Promise<ExecutionPlan> {
  if (candidates.length === 0) {
    return normalise({
      goal,
      steps: [],
      totalEstimatedCostUsdc: 0,
      reasoning:
        'No payable services are available for this wallet yet. If the service catalog is still syncing, try again shortly.',
      alternativeSteps: [],
      alternativeRoute: null,
    })
  }

  const ceiling =
    limits.budgetUsdc === undefined
      ? limits.capUsdc
      : Math.min(limits.capUsdc, limits.budgetUsdc)

  const system = systemPrompt(candidates)
  const userContent = [
    `Goal: ${goal}`,
    `Spending limit: $${ceiling} USDC (absolute)`,
    limits.budgetUsdc !== undefined && limits.budgetUsdc < limits.capUsdc
      ? `This is a per-run budget, tighter than the $${limits.capUsdc} account cap.`
      : `This is the user's account spending cap.`,
  ].join('\n')

  let lastErr: Error | null = null
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const msg = await anthropic().messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 2048,
        system,
        messages: [
          { role: 'user', content: userContent },
          // Prefilling the opening brace keeps Haiku from emitting a preamble.
          { role: 'assistant', content: '{' },
        ],
      })

      const raw = textOf(msg)
      const json = extractJson(raw.trimStart().startsWith('{') ? raw : `{${raw}`)
      const plan = normalise(PlanSchema.parse(JSON.parse(json)))
      assertStepsAreCatalogued(plan, candidates)
      return plan
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      if (attempt < MAX_RETRIES) await new Promise((r) => setTimeout(r, 400 * attempt))
    }
  }
  throw plannerError(lastErr)
}

/**
 * Upstream failures are mostly operator-configuration problems (bad key, no
 * credit, rate limit). Surfacing "Internal server error" for those leaves the
 * user with nothing to act on, so classify them into an exposed message.
 */
function plannerError(err: Error | null): Error {
  const raw = err?.message ?? 'unknown error'

  if (err instanceof Anthropic.APIError) {
    if (err.status === 401 || err.status === 403) {
      return Object.assign(
        new Error(
          ANTHROPIC_BASE_URL
            ? `Planner unavailable: ${ANTHROPIC_BASE_URL} rejected the API key.`
            : 'Planner unavailable: the Anthropic API key was rejected. ' +
              'If this key is from a gateway rather than Anthropic, set ANTHROPIC_BASE_URL.',
        ),
        { status: 503, expose: true },
      )
    }
    if (err.status === 404 && ANTHROPIC_BASE_URL) {
      return Object.assign(
        new Error(
          `Planner unavailable: ${ANTHROPIC_BASE_URL} has no Messages endpoint. ` +
            'ANTHROPIC_BASE_URL should be the origin only — the SDK appends /v1/messages.',
        ),
        { status: 503, expose: true },
      )
    }
    if (err.status === 429) {
      return Object.assign(
        new Error('Planner is rate limited right now. Try again in a moment.'),
        { status: 429, expose: true },
      )
    }
    if (/credit balance|billing|quota/i.test(raw)) {
      return Object.assign(
        new Error(
          'Planner unavailable: the Anthropic account has no available credit. Add credit or update ANTHROPIC_API_KEY.',
        ),
        { status: 503, expose: true },
      )
    }
    return Object.assign(new Error(`Planner unavailable: Anthropic returned ${err.status}.`), {
      status: 503,
      expose: true,
    })
  }

  // Schema / JSON failures are ours, not the operator's — keep the detail.
  return Object.assign(new Error(`Planner could not produce a valid plan: ${raw}`), {
    status: 502,
    expose: true,
  })
}
