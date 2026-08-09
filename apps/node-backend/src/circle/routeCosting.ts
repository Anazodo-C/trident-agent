import { findServiceByResource } from './registryService.ts'
import type { PlanStep } from '../llm/planner.ts'

/**
 * What a route costs and how reliable it is — priced from the registry, not
 * from the model.
 *
 * The planner reports an estimated cost per step, but that figure is the
 * model's claim. The spending cap is absolute, so the number it is measured
 * against has to come from the catalog, which is also what the runner will
 * actually be charged.
 */

export interface RouteCost {
  totalUsdc: number
  /** The smallest cap that would permit this route. */
  minimumCapUsdc: number
  /**
   * 0–100. The weakest step decides it: a route is a chain of calls, and it
   * only delivers if every one of them responds.
   */
  quality: number
  /** Resources the registry does not know. A route with any of these is unusable. */
  uncatalogued: string[]
}

const TRUST_SCORE: Record<string, number> = { curated: 85, active: 60, untested: 15 }

/** Recorded usage nudges a tier upward, with diminishing returns. */
function stepQuality(trust: string, calls30d: number): number {
  const base = TRUST_SCORE[trust] ?? 15
  const usage = Math.min(15, Math.log10(Math.max(1, calls30d)) * 5)
  return Math.min(100, Math.round(base + usage))
}

export function priceRoute(steps: PlanStep[]): RouteCost {
  if (steps.length === 0) {
    return { totalUsdc: 0, minimumCapUsdc: 0, quality: 0, uncatalogued: [] }
  }

  let total = 0
  let quality = 100
  const uncatalogued: string[] = []

  for (const step of steps) {
    const service = findServiceByResource(step.endpointUrl)
    if (!service) {
      uncatalogued.push(step.endpointUrl)
      continue
    }
    total += service.priceUsdc
    quality = Math.min(quality, stepQuality(service.trust, service.calls30d))
  }

  const totalUsdc = Number(total.toFixed(6))
  return {
    totalUsdc,
    // The exact cost, not a rounded-up one. The gate is a strict ">", so a cap
    // equal to the total permits the run, and the user is entitled to see the
    // figure they would actually pay rather than a padded one.
    minimumCapUsdc: totalUsdc,
    quality: uncatalogued.length > 0 ? 0 : quality,
    uncatalogued,
  }
}

/**
 * The binding limit for a run: the account cap, tightened by a per-run budget
 * if the user set one. The cap can only ever lower this, never raise it.
 */
export function effectiveCeiling(capUsdc: number, budgetUsdc?: number | null): number {
  if (budgetUsdc === undefined || budgetUsdc === null) return capUsdc
  return Math.min(capUsdc, budgetUsdc)
}

/** A one-line description of what a route calls, for the guidance card. */
export function describeRoute(steps: PlanStep[]): string {
  const names = steps.map((step) => step.serviceName)
  if (names.length === 0) return 'no services'
  if (names.length <= 3) return names.join(' → ')
  return `${names.slice(0, 3).join(' → ')} and ${names.length - 3} more`
}
