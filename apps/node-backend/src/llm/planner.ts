import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { ANTHROPIC_API_KEY, ANTHROPIC_ENABLED } from '../env.ts'
import type { Service } from '../circle/marketplaceService.ts'

const MODEL = 'claude-haiku-4-5-20251001'
const MAX_RETRIES = 3

let client: Anthropic | null = null
function anthropic(): Anthropic {
  if (!ANTHROPIC_ENABLED) {
    throw Object.assign(new Error('Planner unavailable: ANTHROPIC_API_KEY is not configured'), {
      status: 503,
    })
  }
  client ??= new Anthropic({ apiKey: ANTHROPIC_API_KEY })
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

function systemPrompt(catalog: Service[]): string {
  const compact = catalog.map((s) => ({
    name: s.name,
    description: s.description,
    category: s.category,
    baseUrl: s.baseUrl,
    endpoints: s.endpoints,
    priceRangeUsdc: s.priceRangeUsdc,
    tags: s.tags,
    verification: s.verification,
  }))

  return `You are Trident's planning engine. Given a user goal and a service catalog, output a minimal, cost-effective execution plan as pure JSON. No markdown. No prose outside JSON.

Catalog:
${JSON.stringify(compact, null, 2)}

Rules:
- Only include services genuinely needed to accomplish the goal.
- endpointUrl MUST be exactly one of the catalog baseUrl values concatenated with one of that service's endpoints. Never invent a URL.
- serviceName MUST match a catalog "name" exactly.
- Prefer services with verification "verified-x402" when they can do the job.
- Order steps logically; stepIndex starts at 0 and increases by 1.
- estimatedCostUsdc must sit inside the service's priceRangeUsdc.
- totalEstimatedCostUsdc must equal the sum of the steps' estimatedCostUsdc.
- If a budget is given, keep totalEstimatedCostUsdc at or under it.
- If the budget is too low for any useful plan, return "steps": [] and set minCostUsdc to the cheapest workable total.
- If no catalog service can address the goal, return "steps": [] and explain why in "reasoning".

Respond with exactly this JSON shape:
{"goal":string,"steps":[{"stepIndex":number,"serviceName":string,"endpointUrl":string,"httpMethod":"GET"|"POST","params":object,"purpose":string,"estimatedCostUsdc":number}],"totalEstimatedCostUsdc":number,"reasoning":string,"alternativeSteps":[],"minCostUsdc":number}`
}

/**
 * Reject any step the model invented. A hallucinated URL would otherwise become
 * a real payment attempt against an arbitrary host.
 */
export function assertStepsAreCatalogued(plan: ExecutionPlan, catalog: Service[]): void {
  const allowed = new Set(
    catalog.flatMap((s) => s.endpoints.map((e) => `${s.baseUrl}${e}`)),
  )
  const offending = plan.steps.find((s) => !allowed.has(s.endpointUrl))
  if (offending) {
    throw new Error(
      `Planner produced an endpoint outside the catalog: ${offending.endpointUrl}`,
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
  catalog: Service[],
  budgetUsdc?: number,
): Promise<ExecutionPlan> {
  const system = systemPrompt(catalog)
  const userContent = `Goal: ${goal}${budgetUsdc !== undefined ? `\nBudget: $${budgetUsdc} USDC` : ''}`

  let lastErr: Error | null = null
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const msg = await anthropic().messages.create({
        model: MODEL,
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
      assertStepsAreCatalogued(plan, catalog)
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
        new Error('Planner unavailable: the Anthropic API key was rejected.'),
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
