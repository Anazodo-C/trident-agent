export function shortAddress(address: string | null | undefined, size = 4): string {
  if (!address) return '—'
  if (address.length <= size * 2 + 2) return address
  return `${address.slice(0, size + 2)}…${address.slice(-size)}`
}

/**
 * A USDC amount as shown in the interface: a cost paid, a quote, a cap, a
 * balance. Every one of these is real money, so it is shown exactly: two
 * decimals as a floor because that is how money reads, more when the amount
 * has more, never rounded in either direction.
 *
 * Mirrors formatUsdc in the backend's money.ts. The backend's other formatter,
 * formatMoney, rounds to two decimals; that one is for figures the agent
 * derives in conversation, which are calculations rather than charges, and it
 * never reaches this layer.
 */
export function usdc(value: number | string | null | undefined): string {
  const n = typeof value === 'string' ? Number.parseFloat(value) : (value ?? 0)
  if (!Number.isFinite(n) || n === 0) return '0.00'

  // Below USDC's six decimals nothing can be charged, but a cap can be set
  // there, and showing someone's own limit as "$0.00" would be a lie.
  const exact = Number(n.toFixed(6))
  if (exact === 0) {
    const text = n.toPrecision(2)
    const expanded = text.includes('e')
      ? n.toFixed(Math.min(20, Math.max(0, 1 - Math.floor(Math.log10(Math.abs(n))))))
      : text
    return expanded.includes('.') ? expanded.replace(/0+$/, '').replace(/\.$/, '') : expanded
  }

  const decimals = (String(exact).split('.')[1] ?? '').length
  return exact.toFixed(Math.max(2, Math.min(6, decimals)))
}

export function relativeTime(unixSeconds: number): string {
  const deltaSeconds = Math.floor(Date.now() / 1000) - unixSeconds
  if (deltaSeconds < 60) return 'just now'
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}m ago`
  if (deltaSeconds < 86_400) return `${Math.floor(deltaSeconds / 3600)}h ago`
  if (deltaSeconds < 604_800) return `${Math.floor(deltaSeconds / 86_400)}d ago`
  return new Date(unixSeconds * 1000).toLocaleDateString()
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
