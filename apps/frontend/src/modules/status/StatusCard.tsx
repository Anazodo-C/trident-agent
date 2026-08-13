import type { StatusEndpoint } from '../../lib/types.ts'

/**
 * One endpoint, one card.
 *
 * Small and dense on purpose: there are ~936 of these, and the page is scanned
 * rather than read. The dot in the top-right is the whole point, it is what
 * the eye lands on first, and everything else is confirmation.
 */

/** Semantic state, kept clear of the cyan accent so a green dot never reads as "selected". */
const TONE: Record<string, { dot: string; text: string; glow: string }> = {
  live: { dot: 'bg-[#00FF88]', text: 'text-[#00FF88]', glow: '0 0 7px rgba(0,255,136,.55)' },
  answering: { dot: 'bg-[#FFA040]', text: 'text-[#FFA040]', glow: '0 0 7px rgba(255,160,64,.5)' },
  throttled: { dot: 'bg-[#FFA040]', text: 'text-[#FFA040]', glow: '0 0 7px rgba(255,160,64,.5)' },
  gone: { dot: 'bg-[#FF4466]', text: 'text-[#FF4466]', glow: '0 0 7px rgba(255,68,102,.55)' },
  erroring: { dot: 'bg-[#FF4466]', text: 'text-[#FF4466]', glow: '0 0 7px rgba(255,68,102,.55)' },
  down: { dot: 'bg-[#FF4466]', text: 'text-[#FF4466]', glow: '0 0 7px rgba(255,68,102,.55)' },
}

export function StatusCard({ endpoint, label }: { endpoint: StatusEndpoint; label: string }) {
  const tone = TONE[endpoint.state] ?? TONE['live']!
  const price = endpoint.free
    ? 'free'
    : `$${endpoint.priceUsdc.toFixed(endpoint.priceUsdc < 0.01 ? 4 : 3)}`
  const detail = [endpoint.status, endpoint.latencyMs ? `${endpoint.latencyMs}ms` : null]
    .filter(Boolean)
    .join(' · ')

  return (
    <article className="relative rounded-lg border border-[#1A7FFF]/20 bg-[#0D1526]/80 py-3 pl-3.5 pr-8 transition-colors hover:border-[#00D4FF]/55 hover:bg-[#111D35]">
      <span
        className={`absolute right-3 top-3 h-2 w-2 rounded-full ${tone.dot}`}
        style={{ boxShadow: tone.glow }}
        role="img"
        aria-label={label}
      />

      {/* break-all rather than truncate: the tail of a path is the part that
          distinguishes it, and two lines fits all but a handful. */}
      <span className="line-clamp-2 block break-all font-mono text-xs leading-snug text-slate-200">
        {endpoint.path}
      </span>

      <div className="mt-1.5 flex items-center gap-1.5 whitespace-nowrap font-mono text-[10.5px] text-slate-500">
        <span className="text-slate-600">{endpoint.method}</span>
        <span className="text-[#29354a]">·</span>
        {/* min-width:0 is what actually lets the ellipsis happen, a flex item
            will not shrink below its content without it. */}
        <span className="min-w-0 overflow-hidden text-ellipsis">{endpoint.host}</span>
        <span className="text-[#29354a]">·</span>
        <span>{price}</span>
        <span className={`ml-auto uppercase tracking-wide ${tone.text}`} title={detail}>
          {label}
        </span>
      </div>
    </article>
  )
}
