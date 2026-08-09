import Anthropic from '@anthropic-ai/sdk'
import {
  ANTHROPIC_API_KEY,
  ANTHROPIC_BASE_URL,
  ANTHROPIC_ENABLED,
  ANTHROPIC_MODEL,
} from '../env.ts'
import { calculate } from './arithmetic.ts'
import { formatMoney } from '../money.ts'

/**
 * Turns run results into something a person reads, and answers follow-up
 * questions about a run.
 *
 * Two rules shape this file:
 *
 *  1. It must never break a run. A run that fetched real data and moved real
 *     money has already succeeded; a summariser outage is a rendering problem.
 *     Every entry point falls back to a deterministic, non-LLM rendering.
 *  2. It must not spend the user's credits carelessly. A follow-up is answered
 *     from data already fetched wherever the data supports it, and only
 *     escalates to a new plan when it genuinely cannot be.
 */

let client: Anthropic | null = null
function anthropic(): Anthropic {
  client ??= new Anthropic({
    apiKey: ANTHROPIC_API_KEY,
    ...(ANTHROPIC_BASE_URL ? { baseURL: ANTHROPIC_BASE_URL } : {}),
  })
  return client
}

export interface StepResult {
  stepIndex: number
  serviceName: string
  purpose: string
  status: string
  /** JSON payload as returned, or the error text for a failed step. */
  data: unknown
  costUsdc: number
  source: 'free' | 'x402'
}

export interface RunContext {
  goal: string
  steps: StepResult[]
  totalCostUsdc: number
  status: string
}

/**
 * The model does not do arithmetic. Every figure it derives comes back through
 * here, so a reported number is computed, not recalled.
 */
const CALCULATOR: Anthropic.Tool = {
  name: 'calculate',
  description:
    'Evaluate an arithmetic expression exactly. Use this for every calculation, ' +
    'however simple — conversions, differences, percentages, totals. Supports ' +
    '+ - * / % ^ and parentheses. Returns the exact result and the rounded form ' +
    'to quote in your reply.',
  input_schema: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'e.g. "64999 * 0.8571". Numbers and operators only.',
      },
    },
    required: ['expression'],
  },
}

/** Bounds the tool loop. Each pass is one round trip, so a runaway is a cost. */
const MAX_TOOL_ROUNDS = 6

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()
}

async function complete(system: string, user: string, maxTokens: number): Promise<string> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: user }]

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const message = await anthropic().messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system,
      tools: [CALCULATOR],
      messages,
    })

    const toolUses = message.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    )
    if (toolUses.length === 0) {
      const text = textOf(message)
      if (text) return text

      // A turn that is neither a tool call nor an answer. Seen once in testing
      // and not reproducible, so the cause is unknown — but the caller's only
      // other option is an apology in place of results the user paid for, and
      // asking again costs one short round trip.
      messages.push({ role: 'assistant', content: message.content })
      messages.push({ role: 'user', content: 'Give your answer now, in plain text.' })
      continue
    }

    messages.push({ role: 'assistant', content: message.content })
    messages.push({
      role: 'user',
      content: toolUses.map((use): Anthropic.ToolResultBlockParam => {
        const expression = String((use.input as { expression?: unknown })?.expression ?? '')
        const outcome = calculate(expression)
        if (!outcome.ok) {
          return {
            type: 'tool_result',
            tool_use_id: use.id,
            content: `Error: ${outcome.result}`,
            is_error: true,
          }
        }
        // The rounding is done here too. Asking the model to round its own
        // result reintroduces exactly the arithmetic this tool exists to take
        // away from it — it only has to copy the second figure.
        const display = formatMoney(Number(outcome.result))
        return {
          type: 'tool_result',
          tool_use_id: use.id,
          content: `exact: ${outcome.result}\nreport this figure: ${display}`,
        }
      }),
    })
  }

  // Out of rounds: ask for the answer with what it has rather than returning
  // nothing, since the caller's fallback is a raw JSON dump.
  const final = await anthropic().messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [...messages, { role: 'user', content: 'Give your final answer now.' }],
  })
  return textOf(final)
}

function describeRun(context: RunContext): string {
  const lines = [`Goal: ${context.goal}`, `Run status: ${context.status}`, '']
  for (const step of context.steps) {
    lines.push(`--- Step ${step.stepIndex + 1}: ${step.serviceName} (${step.status})`)
    lines.push(`Purpose: ${step.purpose}`)
    lines.push(`Data: ${typeof step.data === 'string' ? step.data : JSON.stringify(step.data)}`)
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * The step count decides prose versus bullets, and the code knows it exactly.
 * Stating it as a direct instruction per run is far more reliable than hoping
 * the model counts the steps and picks the matching rule out of the system
 * prompt — in testing it read three steps and answered in prose anyway.
 */
function formatDirective(stepCount: number): string {
  return stepCount <= 1
    ? 'This run had ONE step. Answer in two or three sentences of plain prose. Do not use bullets.'
    : `This run had ${stepCount} steps. Your entire reply must be exactly ${stepCount} markdown bullets, one per step, each beginning with "- ". No sentence before the first bullet. At most one sentence after the last, and only if it adds something the bullets do not.`
}

const SUMMARY_SYSTEM = `You are Trident, an agent that calls paid and metered APIs on the user's behalf and then reports back.

You have just finished a run. Write what you found, as a person would say it.

Rules:
- Lead with the answer. The user asked a question; the first sentence answers it.
- Report the values you retrieved as the payload gives them. Do not invent precision and do not turn a number into a vague description.
- Never say "the data shows" without saying what it shows.
- If you need to derive a figure, call the calculate tool. It returns an exact value and a "report this figure" line — quote the latter, verbatim, and never the exact one. Never do arithmetic yourself.
- One step: two or three sentences of prose. No bullets, no headings.
- Two or more steps: one bullet per step, each starting with "- " and in the form "- **Label** — finding". Put the concrete number or fact in the bullet. Markdown list syntax is required; bold text on its own line is not a bullet.
- Never state a finding in prose and then repeat it in a bullet. Say each thing once. With two or more steps, go straight to the bullets — no lead-in sentence restating what is about to be listed.
- Close with a single sentence tying the results together only when that says something the bullets do not. Otherwise stop after the bullets.
- If a step failed, say so plainly in its bullet and continue. Don't apologise or speculate about why.
- Never mention cost, transaction hashes, chains, or which endpoint you used — the interface already shows all of that.
- Never invent a value that isn't in the data. If a payload is unusable, say the step returned nothing usable.
- No preamble ("Here's a summary", "I've completed"). No sign-off. Plain markdown only.`

/** Deterministic rendering used when the model is unavailable. */
function fallbackSummary(context: RunContext): string {
  const done = context.steps.filter((s) => s.status === 'done')
  if (done.length === 0) return 'No step returned data. See the step details below.'

  const render = (step: StepResult): string => {
    const text = typeof step.data === 'string' ? step.data : JSON.stringify(step.data)
    return text.length > 300 ? `${text.slice(0, 300)}…` : text
  }

  if (context.steps.length === 1) {
    const step = context.steps[0]!
    return step.status === 'done'
      ? `${step.serviceName} returned: ${render(step)}`
      : `${step.serviceName} failed: ${render(step)}`
  }
  return context.steps
    .map((step) => `- **${step.serviceName}** — ${step.status === 'done' ? render(step) : `failed: ${render(step)}`}`)
    .join('\n')
}

/**
 * Prose summary of a finished run. Never throws — a failure here degrades to
 * the deterministic rendering rather than losing results the user paid for.
 */
export async function summariseRun(context: RunContext): Promise<string> {
  if (!ANTHROPIC_ENABLED) return fallbackSummary(context)
  try {
    const prompt = `${describeRun(context)}\n${formatDirective(context.steps.length)}`
    const text = await complete(SUMMARY_SYSTEM, prompt, 1024)
    return text || fallbackSummary(context)
  } catch (err) {
    console.error('[trident] summary failed:', String(err))
    return fallbackSummary(context)
  }
}

export type FollowUpKind = 'answer' | 'needs_run'

export interface FollowUpResult {
  kind: FollowUpKind
  /** Prose reply for 'answer'; for 'needs_run', why the existing data falls short. */
  content: string
  /** For 'needs_run': the goal to plan, phrased as a standalone request. */
  suggestedGoal?: string
}

const FOLLOWUP_SYSTEM = `You are Trident, an agent that calls paid and metered APIs on the user's behalf.

The user is asking a follow-up about a run you already completed. You have the full results of that run.

Decide which of these is true, then reply in the exact format below.

ANSWER — the question can be answered from the data you already have, including by reasoning over it (comparing, converting, ranking, filtering, explaining) or by explaining what you did. Prefer this. Re-fetching data you already hold spends the user's money for nothing.

Only these count as data you have: the payloads listed above, and the record of which services were called with which parameters. You do not know anything else about those services — not their pricing, their authentication, their reliability, or why one was picked over another. If asked why you used a service, say it was the catalog match for that part of the goal and leave it there. Never describe a property of a service that is not in front of you.

NEEDS_RUN — the question genuinely needs data you do not have: a different subject, a different time, or a fact absent from every payload.

Format for ANSWER:
ANSWER
<your reply — plain markdown, direct, cite the actual values, bullets only if comparing several things>

Format for NEEDS_RUN:
NEEDS_RUN
GOAL: <the question rewritten as a standalone goal, with every detail needed to act on it alone>
<one sentence telling the user what you'd need to fetch and that it will cost>

Never invent data. Stale data is still an answer — say when it's from the earlier run if that matters.

Arithmetic — follow this exactly:
1. Never calculate anything in your head. Call the calculate tool for every derived figure, however simple it looks, and chain calls when a result feeds the next one.
2. The tool returns two lines: an exact value, and "report this figure". Quote the second one, character for character. It is already rounded for presentation — do not round it further, extend it, or reformat it.
3. Never soften a figure with "about", "roughly" or "approximately". The number you are given is the number to state.
4. If the user asks for different precision, use the exact value and give them what they asked for.
5. Label the result in the unit you converted TO, not the unit you started from.
6. State the inputs you used. Do not print the working — the tool already guarantees the result, and a hand-written equation beside it invites a check against arithmetic you did not do.`

function parseFollowUp(text: string): FollowUpResult {
  const trimmed = text.trim()
  if (!trimmed.startsWith('NEEDS_RUN')) {
    return { kind: 'answer', content: trimmed.replace(/^ANSWER\s*/, '').trim() }
  }
  const body = trimmed.slice('NEEDS_RUN'.length).trim()
  const match = body.match(/^GOAL:\s*(.+)$/m)
  const content = body.replace(/^GOAL:.*$/m, '').trim()
  return {
    kind: 'needs_run',
    content: content || 'That needs data I have not fetched yet.',
    ...(match?.[1] ? { suggestedGoal: match[1].trim() } : {}),
  }
}

export interface Turn {
  role: 'user' | 'agent'
  content: string
}

/**
 * Answers a follow-up from the run's existing results where possible, and says
 * a new run is needed only when it actually is. Escalating on failure would be
 * the expensive default, so an outage degrades to 'answer' with an honest
 * explanation instead — the user keeps the choice to start a new goal.
 */
export async function answerFollowUp(
  question: string,
  context: RunContext,
  history: Turn[],
): Promise<FollowUpResult> {
  if (!ANTHROPIC_ENABLED) {
    return {
      kind: 'answer',
      content: 'Follow-up chat is unavailable right now. The run results are shown above.',
    }
  }

  // Recent turns only: enough to resolve "it" and "that one", not enough to
  // grow the prompt without bound as a conversation runs long.
  const recent = history
    .slice(-6)
    .map((turn) => `${turn.role === 'user' ? 'User' : 'You'}: ${turn.content}`)
    .join('\n')

  const prompt = [
    describeRun(context),
    recent ? `Earlier in this conversation:\n${recent}\n` : '',
    `The user now asks: ${question}`,
  ]
    .filter(Boolean)
    .join('\n')

  try {
    const text = await complete(FOLLOWUP_SYSTEM, prompt, 1024)
    if (!text) throw new Error('empty response')
    return parseFollowUp(text)
  } catch (err) {
    console.error('[trident] follow-up failed:', String(err))
    return {
      kind: 'answer',
      content: "I couldn't process that follow-up just now. Try again, or start a new goal.",
    }
  }
}
