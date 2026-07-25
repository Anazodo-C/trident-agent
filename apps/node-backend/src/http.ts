import type { NextFunction, Request, RequestHandler, Response } from 'express'

export interface HttpError extends Error {
  status?: number
  expose?: boolean
}

export function httpError(status: number, message: string): HttpError {
  return Object.assign(new Error(message), { status, expose: true })
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
