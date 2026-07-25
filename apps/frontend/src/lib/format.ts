export function shortAddress(address: string | null | undefined, size = 4): string {
  if (!address) return '—'
  if (address.length <= size * 2 + 2) return address
  return `${address.slice(0, size + 2)}…${address.slice(-size)}`
}

export function usdc(value: number | string | null | undefined, dp = 3): string {
  const n = typeof value === 'string' ? Number.parseFloat(value) : (value ?? 0)
  if (!Number.isFinite(n)) return '0.000'
  return n.toFixed(dp)
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
