export function TridentMark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
      <path
        d="M16 3v26M16 29l-3.5-3M16 29l3.5-3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M7 8v6a9 9 0 0 0 18 0V8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M7 8L5 4M25 8l2-4M16 3l0-1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
