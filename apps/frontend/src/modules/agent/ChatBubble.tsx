import { ArrowRight, Loader2 } from 'lucide-react'
import type { ChatMessage } from '../../lib/types.ts'
import { Markdown } from '../../lib/markdown.tsx'

/**
 * One turn in the transcript. The user's turns are bubbles on the right; the
 * agent's are unboxed text on the left, so a long write-up reads as prose
 * rather than as a card the user has to work through.
 */
export function ChatBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-xl rounded-br-sm border border-[#1A7FFF]/25 bg-[#111D35] px-4 py-2.5 text-sm text-slate-200">
          {message.content}
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-[95%]">
      <Markdown text={message.content} />
    </div>
  )
}

/** Placeholder while a follow-up is in flight. */
export function ChatThinking() {
  return (
    <div className="flex items-center gap-2.5 text-slate-500">
      <Loader2 className="h-3.5 w-3.5 animate-spin text-[#00D4FF]" />
      <span className="font-mono text-[11px] uppercase tracking-widest">Thinking</span>
    </div>
  )
}

/**
 * Shown when a follow-up needs data the run does not have. The agent proposes;
 * the user decides. Nothing is planned or spent until this is clicked, so a
 * conversational reply can never quietly turn into a charge.
 */
export function PlanOffer({ goal, onPlan }: { goal: string; onPlan: (goal: string) => void }) {
  return (
    <div className="rounded-xl border border-[#1A7FFF]/25 bg-[#111D35]/50 p-3.5">
      <p className="heading-mono">New run required</p>
      <p className="mt-2 text-sm text-slate-300">{goal}</p>
      <button className="btn-ghost mt-3" onClick={() => onPlan(goal)}>
        Plan this
        <ArrowRight className="h-4 w-4" />
      </button>
      <p className="mt-2 text-[11px] text-slate-600">
        You will see the cost and approve it before anything is spent.
      </p>
    </div>
  )
}
