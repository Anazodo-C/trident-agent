/**
 * How USDC amounts are shown to people.
 *
 * Two rules, because two different things get called an amount:
 *
 *  - formatMoney — a figure the agent DERIVED, like a converted price or a
 *    difference. Two decimals, because that is how money reads and the extra
 *    digits of an FX conversion are noise.
 *  - formatUsdc — an amount actually CHARGED, quoted, or held. Exact. The user
 *    is looking at what leaves their wallet, and rounding it either way is
 *    telling them something untrue about their own money.
 *
 * Both keep more precision below half a cent, where two decimals would render
 * a real amount as "$0.00". Free-tier calls are metered at $0.000001 of Arc
 * Testnet USDC, and they did happen.
 *
 * Amounts are computed and stored at full precision throughout; this is only
 * how they are presented.
 */

/** Below this, two decimal places would show a real amount as zero. */
const SUB_CENT = 0.005

/** Two significant digits, expanded out of exponent notation. */
function subCent(value: number): string {
  const text = value.toPrecision(2)
  if (!text.includes('e')) return trimZeros(text)

  const decimals = Math.min(20, Math.max(0, 1 - Math.floor(Math.log10(Math.abs(value)))))
  return trimZeros(value.toFixed(decimals))
}

function trimZeros(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
}

export function formatMoney(value: number | null | undefined): string {
  const n = value ?? 0
  if (!Number.isFinite(n) || n === 0) return '0.00'
  if (Math.abs(n) < SUB_CENT) return subCent(n)
  return n.toFixed(2)
}

/**
 * An amount of money that is actually charged, quoted, or held — shown exactly.
 *
 * Two decimals is the floor, because that is how money reads, but never the
 * ceiling: a route costing $0.153 is shown as $0.153. Not $0.15, which
 * understates what leaves the wallet, and not $0.16, which pads it. USDC
 * carries six decimals, so that is as far as this ever goes.
 *
 * Distinct from formatMoney above, which rounds to two decimals for figures the
 * agent derives in conversation. A converted price is a calculation; this is a
 * charge, and the user is entitled to see it exactly.
 */
export function formatUsdc(value: number | null | undefined): string {
  const n = value ?? 0
  if (!Number.isFinite(n) || n === 0) return '0.00'

  // Below USDC's six decimals nothing can actually be charged, but a spending
  // cap can still be set there — and showing someone's own limit as "$0.00"
  // is the failure this whole function exists to avoid.
  const exact = Number(n.toFixed(6))
  if (exact === 0) return subCent(n)

  const decimals = (String(exact).split('.')[1] ?? '').length
  return exact.toFixed(Math.max(2, Math.min(6, decimals)))
}
