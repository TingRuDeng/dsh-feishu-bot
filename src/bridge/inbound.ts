/**
 * Inbound message lifecycle (design §6.1): idempotent dedup by Feishu event
 * id, durable commit point BEFORE followup, and the five-row crash
 * reconciliation over the session log.
 *
 * Commit order for a routed message:
 *   1. mint the DSH message id (createUserMessage) — not yet durable;
 *   2. write `messageId` + target into the inbound record (durable commit);
 *   3. `agent.followup(message)` — inbox splice logs `agent/inbox/spliced`;
 *   4. terminal write: status `enqueued`, text cleared (same write).
 * A crash between 2 and 4 is recovered by {@link reconcileMessage}; a crash
 * before 2 leaves a `received` record whose followup provably never ran
 * (no messageId), so recovery re-routes it from scratch.
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Declaration-merge import: dsh-agent contributes 'agent/inbox/spliced' to SessionEventMap.
import type {} from '@deepseek-ai/dsh-agent'
import type { DshMessageId, InboundMessage } from './domain.ts'

/** Reconciliation verdict for one recovering inbound message record. */
export type ReconcileVerdict =
  /** No messageId — followup provably never ran; rebuild and route anew. */
  | { action: 'reroute' }
  /** The message reached `user/message` — it was consumed; mark enqueued. */
  | { action: 'enqueued'; via: 'user-message' }
  /** The message sits in the folded inbox — accepted; mark enqueued. */
  | { action: 'enqueued'; via: 'inbox' }
  /** A canceled splice discarded it — mark rejected with the discard reason. */
  | { action: 'rejected'; via: 'canceled-splice' }
  /** No trace in the log — followup never spliced; re-followup with a NEW id. */
  | { action: 'refollowup' }

/** Inbox splice payload subset the fold needs (mirrors agent/inbox/spliced). */
interface SplicedData {
  target: 'next-turn' | 'next-step'
  start: number
  removedCount: number
  inserted: readonly { id: string }[]
  outcome?: string
}

/**
 * Fold `agent/inbox/spliced` events into the two live inbox lists and the
 * set of message ids removed by canceled splices.
 * @param events - the session's contiguous event log.
 * @returns folded lists plus canceled-discard ids.
 */
export function foldInbox(events: readonly SessionEvent[]): {
  nextTurn: string[]
  nextStep: string[]
  canceledIds: Set<string>
} {
  const lists = { 'next-turn': [] as string[], 'next-step': [] as string[] }
  const canceledIds = new Set<string>()
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    const data = event.data as unknown as SplicedData
    const list = lists[data.target]
    if (list === undefined) continue
    const removed = list.splice(data.start, data.removedCount, ...data.inserted.map(item => item.id))
    if (data.outcome === 'canceled') for (const id of removed) canceledIds.add(id)
  }
  return { nextTurn: lists['next-turn'], nextStep: lists['next-step'], canceledIds }
}

/**
 * Decide the recovery action for one interrupted inbound message record
 * against the target session's event log (design §6.1 five-row table).
 * @param record - the recovering inbound message record.
 * @param events - the bound session's event log (empty when unavailable).
 * @returns the verdict; caller performs the corresponding durable write.
 */
export function reconcileMessage(
  record: Pick<InboundMessage, 'messageId'>,
  events: readonly SessionEvent[],
): ReconcileVerdict {
  const messageId = record.messageId as DshMessageId | undefined
  if (messageId === undefined) return { action: 'reroute' }
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type === 'user/message'
      && (event.data as unknown as { id: string }).id === messageId) {
      return { action: 'enqueued', via: 'user-message' }
    }
  }
  const { nextTurn, nextStep, canceledIds } = foldInbox(events)
  if (nextTurn.includes(messageId) || nextStep.includes(messageId)) {
    return { action: 'enqueued', via: 'inbox' }
  }
  if (canceledIds.has(messageId)) return { action: 'rejected', via: 'canceled-splice' }
  return { action: 'refollowup' }
}
