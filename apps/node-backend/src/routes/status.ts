import { Router } from 'express'
import { statusPayload, statusSummaryPayload } from '../circle/statusProber.ts'

/**
 * Public reachability data for status.tridentagent.xyz.
 *
 * No auth, like /api/showcase: a status page that asked you to sign in before
 * telling you whether the service was up would be answering the wrong question.
 *
 * The body is serialised once per probe tick rather than per request, so the
 * cost of a page polling every five seconds is a buffer write. An ETag turns
 * most of those polls into a 304 with no body at all — the data only changes
 * when a slice lands, and a slice is 16 rows out of ~936.
 */

const router = Router()

router.get('/', (req, res) => {
  /*
   * `?summary=1` drops the endpoint list, leaving the counts.
   *
   * For callers that want the headline rather than the table, chiefly the
   * landing page, where the full body would be ~205KB of records to render
   * four numbers. Same caching, same 304 path, its own ETag.
   */
  const { json, etag } =
    req.query['summary'] === '1' ? statusSummaryPayload() : statusPayload()

  res.setHeader('ETag', etag)
  // Five seconds, matching the client's poll: a shared cache in front of this
  // can absorb a crowd without ever serving anything meaningfully stale.
  res.setHeader('Cache-Control', 'public, max-age=5')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')

  if (req.headers['if-none-match'] === etag) {
    res.status(304).end()
    return
  }

  res.status(200).send(json)
})

export default router
