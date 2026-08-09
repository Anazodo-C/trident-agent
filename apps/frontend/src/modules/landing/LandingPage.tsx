import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, KeyRound, Radar, Receipt, Wallet } from 'lucide-react'
import { api } from '../../lib/api.ts'
import type { ShowcaseCard } from '../../lib/types.ts'
import { useAuthStore } from '../../store/authStore.ts'
import { TridentMark } from '../layout/TridentMark.tsx'
import { HeroLoop } from './HeroLoop.tsx'
import { PromptCarousel } from './PromptCarousel.tsx'

export function LandingPage() {
  const token = useAuthStore((s) => s.token)
  const [cards, setCards] = useState<ShowcaseCard[]>([])

  useEffect(() => {
    // The carousel is the only part of this page that needs the backend. If it
    // is unreachable the section simply does not render — a marketing page must
    // not show an error, and must not block on a fetch to say what Trident is.
    api
      .showcase()
      .then((res) => setCards(res.cards))
      .catch(() => undefined)
  }, [])

  // Where the CTA sends you: into the app if you are signed in, to sign-in if
  // not. Distinct from `home` below — the CTA is the next step, the wordmark is
  // the way back.
  const enter = token ? '/app' : '/signin'
  const enterLabel = token ? 'Open Trident' : 'Start a task'
  const home = token ? '/app' : '/'

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-6 sm:px-8">
        {/* Home is wherever home is for you: the landing page signed out, the
            agent signed in. */}
        <Link
          to={home}
          className="flex items-center gap-3 transition-opacity hover:opacity-80"
          aria-label={token ? 'Open Trident' : 'Trident home'}
        >
          <TridentMark className="h-8 w-8" />
          <span className="font-mono text-sm uppercase tracking-[0.3em] text-slate-200">
            Trident
          </span>
        </Link>
        <Link to={enter} className="btn-ghost !px-3.5 !py-2 text-xs">
          {token ? 'Open app' : 'Sign in'}
        </Link>
      </header>

      {/* ---------------------------------------------------------------- hero */}
      <section className="mx-auto grid w-full max-w-6xl grid-cols-1 items-center gap-12 px-5 pb-20 pt-10 sm:px-8 sm:pb-28 sm:pt-16 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="max-w-2xl">
          <p className="heading-mono">One agent. One wallet.</p>

          {/* Sized to clear the loop column without wrapping: at text-5xl the
              first line broke in two once the hero became two columns. */}
          <h1 className="mt-5 font-mono text-3xl uppercase leading-[1.15] tracking-[0.08em] text-slate-100 sm:text-4xl sm:leading-[1.12]">
            Talk to your agent.
            <br />
            <span className="text-[#00D4FF]">It goes and gets it.</span>
          </h1>

          <p className="mt-6 max-w-xl text-base leading-relaxed text-slate-400 sm:text-lg">
            Type a goal. Trident finds the right service out of thousands, pays for the call
            from your own wallet, and comes back with the answer — not a list of links.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link to={enter} className="btn-primary">
              {enterLabel}
              <ArrowRight className="h-4 w-4" />
            </Link>
            <a href="#how" className="btn-ghost">
              How it works
            </a>
          </div>

          <RollingNote />
        </div>

        {/*
          Its own column rather than a layer behind the copy. Overlapping the
          text meant the returning-answer bubble landed on top of the paragraph
          at one point in the loop, and no amount of opacity fixes a collision.
          Hidden below lg: on a narrow screen there is no room for it beside the
          copy, and squeezing it in would push the CTA below the fold.
        */}
        <HeroLoop className="pointer-events-none hidden h-[300px] w-full opacity-90 lg:block" />
      </section>

      {/* ----------------------------------------------------------- carousel */}
      {cards.length > 0 && (
        <section className="mx-auto w-full max-w-6xl px-5 pb-20 sm:px-8 sm:pb-28">
          <PromptCarousel cards={cards} />
        </section>
      )}

      {/* ---------------------------------------------------------- mechanics */}
      <section id="how" className="mx-auto w-full max-w-6xl px-5 pb-20 sm:px-8 sm:pb-28">
        <p className="heading-mono">What happens after you hit enter</p>

        <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Step
            icon={<Radar className="h-4 w-4" />}
            title="Scouts"
            body="Searches a live catalog of x402-payable services and shortlists the ones that fit the goal."
          />
          <Step
            icon={<Receipt className="h-4 w-4" />}
            title="Prices it"
            body="Shows you the plan, the exact cost per call, and what each endpoint is for. Nothing runs unapproved."
          />
          <Step
            icon={<Wallet className="h-4 w-4" />}
            title="Pays"
            body="Settles each call from your agent wallet at the moment it runs. Your spending cap is absolute."
          />
          <Step
            icon={<KeyRound className="h-4 w-4" />}
            title="Answers"
            body="Returns the result as plain language you can ask follow-up questions about, with receipts underneath."
          />
        </div>
      </section>

      {/* --------------------------------------------------------------- cta */}
      <section className="mx-auto w-full max-w-6xl px-5 pb-24 sm:px-8">
        <div className="panel flex flex-col items-start gap-6 p-8 sm:flex-row sm:items-center sm:justify-between sm:p-10">
          <div>
            <h2 className="font-mono text-xl uppercase tracking-widest text-slate-100">
              Give it a goal
            </h2>
            <p className="mt-3 max-w-lg text-sm leading-relaxed text-slate-400">
              Trident creates a self-custody wallet for your agent, encrypted with a passphrase
              only you know. Start on free testnet endpoints and fund it when you are ready.
            </p>
          </div>
          <Link to={enter} className="btn-primary shrink-0">
            {enterLabel}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      <footer className="border-t border-[#1A7FFF]/15">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-7 sm:px-8">
          <span className="font-mono text-[11px] uppercase tracking-widest text-slate-600">
            Trident — autonomous execution over x402
          </span>
          <Link
            to={enter}
            className="font-mono text-[11px] uppercase tracking-widest text-slate-500 transition-colors hover:text-[#00D4FF]"
          >
            {token ? 'Open app' : 'Sign in'}
          </Link>
        </div>
      </footer>
    </div>
  )
}

/**
 * The two ways to pay, one at a time. Both matter — free testnet endpoints are
 * why you can try this without funding anything, and x402 is what the paid
 * catalog settles over — but stacking them turns a one-line footnote under the
 * CTA into a paragraph, so they take turns in a fixed-height slot.
 */
function RollingNote() {
  return (
    <div
      className="roll-window mt-6 h-[1.4em] overflow-hidden font-mono text-[11px]
                 uppercase leading-[1.4em] tracking-widest text-slate-600"
    >
      {/* Two children, each exactly the window's height, so -50% lands the
          second one precisely in the slot. */}
      <div className="roll-track">
        <p className="h-[1.4em] leading-[1.4em]">
          Free endpoints run on testnet — no funding needed to try it
        </p>
        <p className="h-[1.4em] leading-[1.4em]">
          Paid endpoints run on x402 — settled per call from your wallet
        </p>
      </div>
    </div>
  )
}

function Step({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode
  title: string
  body: string
}) {
  return (
    <div className="panel p-5">
      <div className="flex items-center gap-2.5 text-[#00D4FF]">
        {icon}
        <span className="font-mono text-xs uppercase tracking-widest">{title}</span>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-slate-400">{body}</p>
    </div>
  )
}
