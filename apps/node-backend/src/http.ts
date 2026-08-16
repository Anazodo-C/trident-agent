import type { NextFunction, Request, RequestHandler, Response } from 'express'

export interface HttpError extends Error {
  status?: number
  expose?: boolean
  /**
   * Machine-readable companions to the message, merged into the JSON body.
   *
   * For refusals a client can act on programmatically rather than by reading
   * prose. Only ever set deliberately, and only on errors we raise ourselves,
   * so nothing internal reaches a caller through it.
   */
  details?: Record<string, unknown>
}

export function httpError(
  status: number,
  message: string,
  details?: Record<string, unknown>,
): HttpError {
  return Object.assign(new Error(message), { status, expose: true, ...(details ? { details } : {}) })
}

/** Extra fields to send alongside the message, when the error carries any. */
export function detailsOf(err: unknown): Record<string, unknown> {
  const details = (err as HttpError | undefined)?.details
  return details && statusOf(err) < 500 ? details : {}
}

/** Wraps an async handler so rejected promises reach the Express error handler. */
export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next)
  }
}

export function statusOf(err: unknown): number {
  const status = (err as HttpError | undefined)?.status
  return typeof status === 'number' && status >= 400 && status <= 599 ? status : 500
}

/**
 * Never leak internals on a 5xx. 4xx messages we raise ourselves are safe to
 * show, since they describe the caller's own mistake.
 */
export function messageOf(err: unknown): string {
  const status = statusOf(err)
  // 5xx messages we deliberately marked `expose` describe an operator
  // configuration problem the user can act on, so they are safe to show.
  if (status >= 500 && !(err as HttpError | undefined)?.expose) {
    return 'Internal server error'
  }
  return err instanceof Error ? err.message : 'Request failed'
}
