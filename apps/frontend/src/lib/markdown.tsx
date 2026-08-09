import type { ReactNode } from 'react'

/**
 * A deliberately small markdown renderer for agent replies.
 *
 * The responder is prompted to emit one narrow subset — paragraphs, "- "
 * bullets, **bold** and `code` — so a full markdown library would be several
 * hundred kilobytes to parse four constructs.
 *
 * It builds React elements directly and never touches innerHTML, so a payload
 * that happens to contain markup is text, not markup. That matters here: this
 * content originates from third-party API responses, and an agent reply is not
 * a trusted string.
 */

/** Splits on **bold** and `code`, leaving everything else as plain text. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0
  let match: RegExpExecArray | null
  let index = 0

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const token = match[0]
    const key = `${keyPrefix}-i${index++}`
    if (token.startsWith('**')) {
      nodes.push(
        <strong key={key} className="font-semibold text-slate-100">
          {token.slice(2, -2)}
        </strong>,
      )
    } else {
      nodes.push(
        <code
          key={key}
          className="rounded bg-[#0A0E1A] px-1 py-0.5 font-mono text-[0.85em] text-[#00D4FF]"
        >
          {token.slice(1, -1)}
        </code>,
      )
    }
    last = match.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

const BULLET = /^\s*[-*]\s+/

export function Markdown({ text }: { text: string }) {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let bullets: string[] = []
  let paragraph: string[] = []
  let key = 0

  const flushBullets = (): void => {
    if (bullets.length === 0) return
    const items = bullets
    bullets = []
    blocks.push(
      <ul key={`ul-${key++}`} className="my-2 flex flex-col gap-1.5">
        {items.map((item, i) => (
          <li key={i} className="flex gap-2.5">
            <span aria-hidden className="mt-[0.45rem] h-1 w-1 shrink-0 rounded-full bg-[#00D4FF]" />
            <span className="min-w-0 flex-1">{renderInline(item, `b${key}-${i}`)}</span>
          </li>
        ))}
      </ul>,
    )
  }

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    const body = paragraph.join(' ')
    paragraph = []
    blocks.push(
      <p key={`p-${key++}`} className="my-1.5 first:mt-0 last:mb-0">
        {renderInline(body, `p${key}`)}
      </p>,
    )
  }

  for (const line of lines) {
    if (BULLET.test(line)) {
      flushParagraph()
      bullets.push(line.replace(BULLET, ''))
    } else if (line.trim() === '') {
      flushParagraph()
      flushBullets()
    } else {
      flushBullets()
      paragraph.push(line.trim())
    }
  }
  flushParagraph()
  flushBullets()

  return <div className="text-sm leading-relaxed text-slate-300">{blocks}</div>
}
