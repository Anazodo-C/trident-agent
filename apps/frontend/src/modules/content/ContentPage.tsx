import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { TridentMark } from '../layout/TridentMark.tsx'

/**
 * The frame shared by /docs, /privacy and /terms.
 *
 * All three are long prose documents with a contents rail, and all three are
 * public, read by people deciding whether to trust the product, often before
 * they have an account. Keeping the masthead, the rail and the footer in one
 * place is what stops the legal pages from slowly looking like a different site
 * than the documentation.
 *
 * The masthead is the landing page's own lockup and type scale, unchanged.
 */

export interface TocEntry {
  /** The section's `id`, without the hash. */
  id: string
  label: string
}

export function ContentPage({
  eyebrow,
  title,
  lede,
  updated,
  toc,
  children,
  numbered = false,
}: {
  eyebrow: string
  /** Rendered as-is, so a caller can break the line where it reads best. */
  title: React.ReactNode
  lede: React.ReactNode
  /** Shown on the legal pages, which need a version date. */
  updated?: string
  toc: TocEntry[]
  children: React.ReactNode
  /** Numbers the sections, for documents referenced by clause. */
  numbered?: boolean
}) {
  // index.html is titled for the app; these are separate documents and a tab
  // reading "Agentic Workspace" would be the wrong label for a privacy policy.
  useEffect(() => {
    const previous = document.title
    document.title = `Trident ${eyebrow}`
    return () => {
      document.title = previous
    }
  }, [eyebrow])

  return (
    <div className="doc-page">
      <header>
        <Link
          to="/"
          className="flex w-fit items-center gap-3 transition-opacity hover:opacity-80"
          aria-label="Trident home"
        >
          <TridentMark className="h-8 w-8" />
          <span className="font-mono text-sm uppercase tracking-[0.3em] text-slate-200">
            Trident
          </span>
        </Link>

        <p className="heading-mono mt-10">{eyebrow}</p>
        <h1 className="mt-5 font-mono text-3xl uppercase leading-[1.15] tracking-[0.08em] text-slate-100 sm:text-4xl sm:leading-[1.12]">
          {title}
        </h1>
        <p className="mt-6 max-w-[62ch] text-base leading-relaxed text-slate-400 sm:text-lg">
          {lede}
        </p>
        {updated && (
          <p className="mt-6 font-mono text-[11px] uppercase tracking-[0.12em] text-slate-600">
            Last updated {updated}
          </p>
        )}
      </header>

      <div className="doc-shell">
        <nav className="doc-toc" aria-label="Contents">
          <p className="doc-toc-label">Contents</p>
          <ol className="flex list-none flex-col gap-[7px] p-0">
            {toc.map((entry, i) => (
              <li key={entry.id}>
                <a className="doc-toc-link" href={`#${entry.id}`}>
                  {numbered && (
                    <span className="mr-1.5 tabular-nums text-slate-600">{i + 1}</span>
                  )}
                  {entry.label}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <main className={`doc-body ${numbered ? 'doc-clauses' : ''}`}>
          {children}
          <ContentFooter />
        </main>
      </div>
    </div>
  )
}

/** One section. `numbered` on the page turns the heading into a clause number. */
export function Section({
  id,
  heading,
  numbered = false,
  children,
}: {
  id: string
  heading: string
  numbered?: boolean
  children: React.ReactNode
}) {
  return (
    <section id={id} className={`doc-section ${numbered ? 'doc-clause' : ''}`}>
      <h2 className="doc-h2">{heading}</h2>
      {children}
    </section>
  )
}

/** A callout. `tone` carries meaning, not decoration: money, stop, or plain. */
export function Note({
  tag,
  tone = 'plain',
  children,
}: {
  tag: string
  tone?: 'plain' | 'money' | 'stop' | 'free'
  children: React.ReactNode
}) {
  const toneClass =
    tone === 'money'
      ? 'doc-note-money'
      : tone === 'stop'
        ? 'doc-note-stop'
        : tone === 'free'
          ? 'doc-note-free'
          : ''
  const tagColour =
    tone === 'money'
      ? 'text-[#FFA040]'
      : tone === 'stop'
        ? 'text-[#FF4466]'
        : tone === 'free'
          ? 'text-[#00FF88]'
          : 'text-slate-500'

  return (
    <div className={`doc-note ${toneClass}`}>
      <span className={`doc-note-tag ${tagColour}`}>{tag}</span>
      {children}
    </div>
  )
}

function ContentFooter() {
  return (
    <footer className="mt-16 flex flex-wrap items-center gap-x-6 gap-y-2.5 border-t border-[#1A7FFF]/20 pt-5 font-mono text-[11px] uppercase tracking-[0.12em]">
      <span className="mr-auto text-slate-600">Trident v1</span>
      <Link className="text-slate-500 transition-colors hover:text-[#00D4FF]" to="/docs">
        Docs
      </Link>
      <Link className="text-slate-500 transition-colors hover:text-[#00D4FF]" to="/privacy">
        Privacy
      </Link>
      <Link className="text-slate-500 transition-colors hover:text-[#00D4FF]" to="/terms">
        Terms
      </Link>
      <a
        className="text-slate-500 transition-colors hover:text-[#00D4FF]"
        href="https://github.com/Anazodo-C/trident-agent"
        target="_blank"
        rel="noreferrer noopener"
      >
        GitHub
      </a>
    </footer>
  )
}
