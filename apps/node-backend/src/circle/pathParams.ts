/**
 * `{placeholder}` segments in a catalogued resource URL.
 *
 * 117 of the catalog's ~936 resources are templates: `/usstock/price/{symbol}`,
 * `/coins/{id}`, `/agentphone/v1/calls/{callId}`. A placeholder is a required
 * input like any other — the only thing that distinguishes it is that it goes
 * into the URL rather than the body or the query string.
 *
 * Nothing modelled it that way, and the same fault surfaced independently in
 * three places: the planner was never told the value existed, failover judged
 * such endpoints unfillable, and the status prober sent the braces literally
 * and read the resulting 404 as the endpoint being dead. This module is the one
 * definition all three now share.
 */

/** Matches `{id}` but not `{{id}}` or an unclosed brace. */
const PATH_PLACEHOLDER = /\{([^{}]+)\}/g

/** The placeholder names a URL still expects to have filled, in order. */
export function pathPlaceholders(url: string): string[] {
  return [...url.matchAll(PATH_PLACEHOLDER)].map((m) => m[1] as string)
}

/** Whether a resource carries any placeholder at all. */
export function isTemplated(url: string): boolean {
  // A fresh regex each time: PATH_PLACEHOLDER is global, and `test` on a shared
  // global regex advances lastIndex, so consecutive calls would alternate
  // between true and false.
  return pathPlaceholders(url).length > 0
}

/**
 * Fill `{id}`-style segments from a step's parameters.
 *
 * Sent as published, a template is requested with the braces still in it — a
 * failover once called `/api/v1/videos/generations/{id}` verbatim and read the
 * 400 as the endpoint being broken.
 *
 * A parameter spent on the path is reported back so the caller does not also
 * append it to the query string, where it would be a duplicate the server
 * ignores. Values are percent-encoded: they come from the user, and they are
 * being placed into a URL.
 */
export function applyPathParams(
  url: string,
  params: Record<string, unknown>,
): { url: string; consumed: Set<string> } {
  const consumed = new Set<string>()
  const filled = url.replace(PATH_PLACEHOLDER, (whole, name: string) => {
    const value = params[name]
    if (!hasValue(value)) return whole
    consumed.add(name)
    return encodeURIComponent(String(value))
  })
  return { url: filled, consumed }
}

/**
 * What counts as a value.
 *
 * Shared by both functions below deliberately. They disagreed once: filling
 * treated `"  "` as a value and produced `/price/%20%20`, while the check that
 * decides whether to ask the user treated it as absent. One of them has to be
 * wrong about the same input, and a request built from whitespace is the worse
 * outcome — it spends money on a call that cannot mean anything.
 */
function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== ''
}

/** Placeholders in `url` that `params` does not supply a value for. */
export function missingPathParams(url: string, params: Record<string, unknown>): string[] {
  return pathPlaceholders(url).filter((name) => !hasValue(params[name]))
}

/**
 * Substitute a neutral token so a template can be probed for liveness.
 *
 * Only for reachability checks, never for a real call. The prober cannot know
 * which symbol a user wants, but it still needs to ask the seller whether the
 * route exists — and `/usstock/price/{symbol}` answers 404 to the braces while
 * `/usstock/price/probe` answers 402. A real call fills these from the user's
 * own request, or asks for them; see missingPathParams.
 */
export function fillTemplate(url: string): string {
  return url.replace(PATH_PLACEHOLDER, 'probe')
}
