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
  // Models emit numbers/booleans here often enough that coercing beats retrying.
  params: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
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

export const PlanSchema = z.object({
  goal: z.string(),
  steps: z.array(StepSchema),
  totalEstimatedCostUsdc: z.number().nonnegative(),
  reasoning: z.string(),
  alternativeSteps: z.array(StepSchema).default([]),
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
- Prefer trust "curated", then "active". A service with trust "untested" has no recorded usage and may not work — only choose one when nothing else fits the goal.
- Order steps logically; stepIndex starts at 0 and increases by 1.
- totalEstimatedCostUsdc must equal the sum of the steps' estimatedCostUsdc.
- If a budget is given, keep totalEstimatedCostUsdc at or under it.
- If the budget is too low for any useful plan, return "steps": [] and set minCostUsdc to the cheapest workable total.
- If none of these services can address the goal, return "steps": [] and say so plainly in "reasoning". Do not substitute an unrelated service.

Respond with exactly this JSON shape:
{"goal":string,"steps":[{"stepIndex":number,"serviceName":string,"endpointUrl":string,"httpMethod":"GET"|"POST","params":object,"purpose":string,"estimatedCostUsdc":number}],"totalEstimatedCostUsdc":number,"reasoning":string,"alternativeSteps":[],"minCostUsdc":number}`
}

/**
 * Reject any step the model invented. A hallucinated URL would otherwise become
 * a real payment attempt against an arbitrary host, so this compares against
 * the exact resource URLs offered — never a prefix.
 */
export function assertStepsAreCatalogued(plan: ExecutionPlan, candidates: Service[]): void {
  const allowed = new Set(candidates.map((s) => s.resource))
  const offending = plan.steps.find((s) => !allowed.has(s.endpointUrl))
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
  return { ...plan, steps, totalEstimatedCostUsdc: Number(total.toFixed(6)) }
}

export async function buildPlan(
  goal: string,
  candidates: Service[],
  budgetUsdc?: number,
): Promise<ExecutionPlan> {
  if (candidates.length === 0) {
    return normalise({
      goal,
      steps: [],
      totalEstimatedCostUsdc: 0,
      reasoning:
        'No payable services are available for this wallet yet. If the service catalog is still syncing, try again shortly.',
      alternativeSteps: [],
    })
  }

  const system = systemPrompt(candidates)
  const userContent = `Goal: ${goal}${budgetUsdc !== undefined ? `\nBudget: $${budgetUsdc} USDC` : ''}`

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
