import { useEffect, useState } from 'react'

/**
 * The hero's ambient loop: one goal going out and one answer coming back.
 *
 * Five beats on a 6s cycle — the goal types, endpoints are scanned, the match
 * is paid for, the answer returns, then it holds and repeats. The timing lives
 * in index.css so every element shares one timeline and the beats cannot drift.
 *
 * Drawn as inline SVG rather than a video or a Lottie payload: it is a dozen
 * shapes, it costs nothing to ship, and it stays crisp at any size. It occupies
 * the hero's second column rather than sitting behind the copy — the headline
 * and CTA lead, and nothing here is ever allowed to overlap them.
 */
export function HeroLoop({ className = '' }: { className?: string }) {
  const [hidden, setHidden] = useState(false)

  /**
   * Stop burning frames once the tab goes to the background — browsers throttle
   * timers, but not CSS animations.
   *
   * Driven by the visibilitychange event only, and deliberately not by reading
   * visibilityState at mount. An embedder that reports "hidden" for a view the
   * user is actually looking at, and never fires the event to correct it, would
   * otherwise leave this frozen forever with no way back. Starting from playing
   * costs at most a few seconds of animation in a tab opened in the background;
   * starting from paused risks a hero that never moves at all.
   *
   * Note this is belt and braces: engines already freeze CSS animations in a
   * document they consider hidden, so the class mainly documents the intent and
   * covers embedders that keep ticking.
   */
  useEffect(() => {
    const onChange = (): void => setHidden(document.visibilityState === 'hidden')
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])

  return (
    <svg
      viewBox="0 0 420 260"
      className={`${className} ${hidden ? 'hero-loop-paused' : ''}`}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id="lockGlow">
          <stop offset="0%" stopColor="#00D4FF" stopOpacity="0.7" />
          <stop offset="100%" stopColor="#00D4FF" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Beat 1 — the goal, typed out and settling. */}
      <g className="hero-bubble">
        <rect
          x="8"
          y="16"
          width="212"
          height="40"
          rx="10"
          fill="#111D35"
          stroke="#1A7FFF"
          strokeOpacity="0.35"
        />
        <text className="hero-typing-a" x="22" y="34" fill="#CBD5E1" fontFamily="monospace" fontSize="10.5">
          Find the top 3 competitors
        </text>
        <text className="hero-typing-b" x="22" y="48" fill="#CBD5E1" fontFamily="monospace" fontSize="10.5">
          for my startup
        </text>
        <rect className="hero-caret-a" x="184" y="26" width="6" height="11" fill="#00D4FF" />
        <rect className="hero-caret-b" x="112" y="40" width="6" height="11" fill="#00D4FF" />
      </g>

      {/* Beat 2 — candidate endpoints, dim until evaluated. */}
      <g>
        {CANDIDATES.map((node, i) => (
          <circle
            key={i}
            cx={node.x}
            cy={node.y}
            r="4"
            fill="#1A7FFF"
            className="hero-scan"
            // Staggered so they flicker in sequence rather than in unison.
            style={{ animationDelay: `${i * -0.45}s` }}
          />
        ))}

        {/* Beat 2 end — the endpoint that matches the goal. */}
        <circle className="hero-lock-glow" cx="330" cy="120" r="16" fill="url(#lockGlow)" />
        <circle className="hero-lock" cx="330" cy="120" r="4" fill="#00D4FF" />
      </g>

      {/* The request travelling to the matched endpoint. */}
      <path
        className="hero-wire"
        d="M224 46 C 268 46, 292 92, 326 118"
        fill="none"
        stroke="#00D4FF"
        strokeWidth="1.4"
        strokeDasharray="96"
        strokeLinecap="round"
      />

      {/* Beat 3 — the x402 payment settling. */}
      <g className="hero-pay">
        <rect
          x="286"
          y="140"
          width="88"
          height="24"
          rx="6"
          fill="#0A0E1A"
          stroke="#00FF88"
          strokeOpacity="0.5"
        />
        <text x="298" y="156" fill="#00FF88" fontFamily="monospace" fontSize="11">
          $0.03 paid
        </text>
      </g>

      {/* Beat 4 — the answer, back in the thread. */}
      <g className="hero-result">
        <rect
          x="8"
          y="196"
          width="196"
          height="34"
          rx="10"
          fill="#0D1526"
          stroke="#00FF88"
          strokeOpacity="0.3"
        />
        <text x="22" y="217" fill="#94A3B8" fontFamily="monospace" fontSize="10.5">
          Found 3 matches
        </text>
        <text x="150" y="217" fill="#00FF88" fontFamily="monospace" fontSize="11">
          ✓
        </text>
      </g>
    </svg>
  )
}

/** The unmatched endpoints, loosely on the hex lattice used as page texture. */
const CANDIDATES = [
  { x: 268, y: 62 },
  { x: 330, y: 46 },
  { x: 388, y: 78 },
  { x: 268, y: 132 },
  { x: 388, y: 148 },
  { x: 300, y: 186 },
  { x: 360, y: 196 },
]
