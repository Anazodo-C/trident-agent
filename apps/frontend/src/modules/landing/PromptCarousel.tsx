import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Sparkles } from 'lucide-react'
import type { ShowcaseCard } from '../../lib/types.ts'
import { usdc } from '../../lib/format.ts'

/**
 * What the agent can be asked for, drawn from the live service registry.
 *
 * The prices and call volumes on these cards are the real ones from the x402
 * network, not marketing figures. The endpoint resolves each card against the
 * catalog and drops any service that has been delisted. Only the phrasing is
 * authored.
 *
 * Card sizing follows the reference row: ~340px wide with a 24px gap, which is
 * the density that reads tight without crowding. Height is left to the content
 * instead of being pinned, so a short card does not carry dead space.
 */
const AUTO_ADVANCE_MS = 4500

export function PromptCarousel({ cards }: { cards: ShowcaseCard[] }) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [paused, setPaused] = useState(false)

  const scrollByCard = useCallback((direction: 1 | -1) => {
    const track = trackRef.current
    if (!track) return

    const card = track.querySelector<HTMLElement>('[data-card]')
    const step = card ? card.offsetWidth + 24 : track.clientWidth * 0.8
    const max = track.scrollWidth - track.clientWidth

    // Wrap at both ends so the row reads as a loop rather than a dead stop.
    // A 2px tolerance: fractional scroll positions never land exactly on max.
    if (direction === 1 && track.scrollLeft >= max - 2) {
      track.scrollTo({ left: 0, behavior: 'smooth' })
      return
    }
    if (direction === -1 && track.scrollLeft <= 2) {
      track.scrollTo({ left: max, behavior: 'smooth' })
      return
    }
    track.scrollBy({ left: step * direction, behavior: 'smooth' })
  }, [])

  // Advances on its own, but never while the reader is engaged with it, never
  // in a hidden tab, and never for someone who asked for less motion.
  useEffect(() => {
    if (paused) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') scrollByCard(1)
    }, AUTO_ADVANCE_MS)
    return () => window.clearInterval(timer)
  }, [paused, scrollByCard])

  if (cards.length === 0) return null

  return (
    <div
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      // A touch anywhere in the row hands control over for good; nothing is
      // worse than a carousel that scrolls itself out from under a thumb.
      onTouchStart={() => setPaused(true)}
    >
      <div className="mb-5 flex items-end justify-between gap-4 px-1">
        <div>
          <p className="heading-mono">Ask for anything in the catalog</p>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-slate-400">
            Every price below is what that service charges today, pulled from the live x402
            registry.
          </p>
        </div>

        <div className="hidden shrink-0 gap-2 sm:flex">
          <button
            className="btn-ghost !px-2.5 !py-2"
            onClick={() => scrollByCard(-1)}
            aria-label="Previous examples"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            className="btn-ghost !px-2.5 !py-2"
            onClick={() => scrollByCard(1)}
            aria-label="More examples"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div
        ref={trackRef}
        className="flex snap-x snap-mandatory gap-6 overflow-x-auto scroll-smooth pb-4
                   [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {cards.map((card) => (
          <Card key={card.resource} card={card} />
        ))}
      </div>
    </div>
  )
}

function Card({ card }: { card: ShowcaseCard }) {
  const free = card.source === 'free'

  return (
    <article
      data-card
      className="panel-interactive flex w-[300px] shrink-0 snap-start flex-col p-5 sm:w-[340px]"
    >
      <div className="flex items-center justify-between gap-3">
        <span
          className={`badge ${
            free
              ? 'bg-[#00FF88]/10 text-[#00FF88]'
              : 'bg-[#1A7FFF]/15 text-[#7FB4FF]'
          }`}
        >
          {card.category}
        </span>
        {card.curated && (
          <span className="badge bg-[#00D4FF]/10 text-[#00D4FF]">Curated</span>
        )}
      </div>

      <p className="mt-4 flex-1 text-[15px] leading-relaxed text-slate-100">
        “{card.prompt}”
      </p>

      <p className="mt-4 flex items-start gap-2 text-sm leading-relaxed text-slate-400">
        <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#00D4FF]" />
        <span>{card.does}</span>
      </p>

      <div className="mt-5 flex items-baseline justify-between border-t border-[#1A7FFF]/15 pt-3.5">
        <span className="truncate font-mono text-[11px] text-slate-600">{card.host}</span>
        <span className="price shrink-0 font-mono text-sm">
          ${usdc(card.priceUsdc)}
          <span className="text-slate-600"> /call</span>
        </span>
      </div>
    </article>
  )
}
