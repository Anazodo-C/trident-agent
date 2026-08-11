/**
 * Is this the status subdomain?
 *
 * status.tridentagent.xyz is served by the same Vercel project as the app — one
 * build, one deploy — so the hostname is what decides which of the two the
 * bundle should mount. Shared between main.tsx, which uses it to skip the
 * wallet providers entirely, and App.tsx, which routes on it.
 */
export function onStatusHost(): boolean {
  return typeof window !== 'undefined' && window.location.hostname.startsWith('status.')
}
