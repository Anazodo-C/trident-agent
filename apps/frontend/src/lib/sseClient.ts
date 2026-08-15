import { apiUrl } from './api.ts'
import type { PlanStep } from './types.ts'

export interface RunPayload {
  taskId: string
  approvedSteps: PlanStep[]
  budgetUsdc: number | null
}

export type AgentEventName =
  | 'start'
  | 'step_start'
  | 'step_done'
  | 'step_replayed'
  | 'step_failed'
  | 'budget_exceeded'
  | 'cap_exceeded'
  | 'stopped'
  | 'complete'
  | 'summary'
  | 'fatal'
  | 'error'

/**
 * SSE over POST.
 *
 * `EventSource` is deliberately not used, though the original reason is gone:
 * it only issues GET requests, which used to mean putting the private key in a
 * query string. There is no key any more, but two reasons remain. EventSource
 * cannot set an Authorization header, and the approved plan is an array too
 * large to belong in a URL.
 */
export async function streamAgentRun(
  payload: RunPayload,
  jwt: string,
  onEvent: (event: AgentEventName, data: Record<string, unknown>) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(apiUrl('/api/agent/run'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(payload),
    signal,
  })

  if (!res.ok) {
    let message = `Run failed (${res.status})`
    let budgetGuidance: unknown
    try {
      const body = (await res.json()) as { error?: string; budgetGuidance?: unknown }
      if (body.error) message = body.error
      // A cap refusal carries the quote for the work. Carried on the error so
      // the caller can show it instead of a bare message.
      budgetGuidance = body.budgetGuidance
    } catch {
      /* non-JSON error body; keep the status-based message */
    }
    throw Object.assign(new Error(message), budgetGuidance ? { budgetGuidance } : {})
  }
  if (!res.body) throw new Error('Streaming is not supported by this browser')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // Frames are separated by a blank line; a partial frame stays buffered.
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''

      for (const frame of frames) {
        let eventName: AgentEventName | null = null
        const dataLines: string[] = []

        for (const line of frame.split('\n')) {
          if (line.startsWith(':')) continue // heartbeat comment
          if (line.startsWith('event:')) eventName = line.slice(6).trim() as AgentEventName
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
        }

        if (!eventName || dataLines.length === 0) continue
        try {
          onEvent(eventName, JSON.parse(dataLines.join('\n')) as Record<string, unknown>)
        } catch {
          /* ignore a malformed frame rather than killing the stream */
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
