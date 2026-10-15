/**
 * Bounded paged reads of a session's committed event log.
 *
 * The bridge's delivery catch-up needs a historical window (`[fromSeq, ∞)`)
 * rather than the session's current state, so a Session projection does not
 * fit: a head-state fold would silently drop the older settled tasks a lagging
 * delivery cursor still owes. DSH's deprecation note prescribes explicit
 * asynchronous pagination for exactly this case
 * (`2026-09-09-deprecate-synchronous-session-event-reads`):
 *
 *   "Historical content presented on demand uses explicit asynchronous
 *    pagination and progressive loading, with each read limited to the
 *    requested window."
 *
 * This module is that path. It deliberately reads through a persistence handle
 * instead of `session.snapshotEvents()`, so the bridge stops depending on the
 * complete event sequence being resident in memory.
 */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Events per read; bounds one page's I/O and resident slice. */
export const SESSION_READ_PAGE = 256

/** The persistence surface this reader needs. */
export interface PagedReadHandle {
  read(offset?: number, length?: number): Promise<{ events: readonly SessionEvent[] }>
  close(): Promise<void>
}

/** Opens a read handle for one session. */
export type OpenReadHandle = (sessionId: SessionId) => Promise<PagedReadHandle>

/**
 * Read every committed event from `fromSeq` to the end, in bounded pages.
 *
 * The loop terminates on the first short page — `read` returns fewer events
 * than requested only at the end of the valid contiguous log — so a session
 * with millions of events is still read window by window.
 * @param open - opens a read handle for the session.
 * @param sessionId - the session to read.
 * @param fromSeq - first logical event seq to include.
 * @returns the events in seq order; empty when `fromSeq` is past the end.
 */
export async function readSessionEventsFrom(
  open: OpenReadHandle, sessionId: SessionId, fromSeq: number,
): Promise<readonly SessionEvent[]> {
  const handle = await open(sessionId)
  try {
    const collected: SessionEvent[] = []
    for (let offset = Math.max(0, fromSeq); ; offset += SESSION_READ_PAGE) {
      const { events } = await handle.read(offset, SESSION_READ_PAGE)
      if (events.length === 0) break
      collected.push(...events)
      if (events.length < SESSION_READ_PAGE) break
    }
    return collected
  } finally {
    await handle.close()
  }
}
