/**
 * Projected crash-reconciliation fold.
 *
 * On restart the bridge replays each interrupted inbound record against its
 * target session's log to decide the five-row recovery table (design §6.1).
 * That decision used to read the whole log synchronously
 * (`session.snapshotEvents()`, deprecated by DSH
 * `2026-09-09-deprecate-synchronous-session-event-reads`). Everything it needs
 * is log-derived, so the registry folds it once per committed event.
 *
 * The upstream `inbox` projection holds the pending lists too, but it does not
 * track which ids a CANCELED splice discarded — and row 4 is exactly that.
 * Folding all three facts in one unit keeps the precedence explicit and the
 * state self-contained instead of splitting one verdict across two keys.
 *
 * State stays bounded in the ways the reference is: pending ids leave the
 * lists as splices remove them, and consumed/discarded ids are retained
 * because a later recovery may still ask about them. A message id can only
 * come from an inbox splice or a user message, both of which are per-message.
 */
import { z } from 'zod'

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

/** The event fields the fold reads; structurally satisfied by SessionEvent. */
export interface ReconciliationEvent {
  type: string
  data: unknown
}

/** Inbox splice payload subset the fold needs (mirrors agent/inbox/spliced). */
interface SplicedData {
  target: 'next-turn' | 'next-step'
  start: number
  removedCount: number
  inserted: readonly { id: string }[]
  outcome?: string
}

/** Event types the reconciliation fold consumes. */
export const RECONCILIATION_EVENT_TYPES: ReadonlySet<string> =
  new Set(['agent/inbox/spliced', 'user/message'])

/** Log-derived recovery state; JSON-serializable for checkpoints. */
export interface ReconciliationState {
  /** Ids still pending in `next-turn`, in order. */
  nextTurn: string[]
  /** Ids still pending in `next-step`, in order. */
  nextStep: string[]
  /** Ids that reached `user/message`; consumption wins over everything else. */
  consumed: string[]
  /** Ids a canceled splice discarded. */
  canceled: string[]
}

const stateSchema = z.object({
  nextTurn: z.array(z.string()),
  nextStep: z.array(z.string()),
  consumed: z.array(z.string()),
  // Rows restored from a checkpoint must remain askable, so canceled ids are
  // persisted rather than recomputed.
  canceled: z.array(z.string()),
})

/** Initial state for an empty log. */
export function reconciliationInit(): ReconciliationState {
  return { nextTurn: [], nextStep: [], consumed: [], canceled: [] }
}

/**
 * Advance the recovery fold by one committed event.
 *
 * Mirrors {@link foldInbox} plus the `user/message` consumption test, using
 * the same splice semantics: a splice replaces `removedCount` entries at
 * `start` with the inserted ids, and `outcome: 'canceled'` marks the removed
 * ones as discarded.
 * @param state - state covering every prior event.
 * @param event - the next committed session event.
 * @returns the next state, or the same reference when nothing changed.
 */
export function reconciliationApply(
  state: ReconciliationState, event: ReconciliationEvent,
): ReconciliationState {
  if (!RECONCILIATION_EVENT_TYPES.has(event.type)) return state

  if (event.type === 'user/message') {
    const id = (event.data as { id?: unknown } | null | undefined)?.id
    if (typeof id !== 'string') return state
    if (state.consumed.includes(id)) return state
    return { ...state, consumed: [...state.consumed, id] }
  }

  const data = event.data as SplicedData
  const list = data?.target === 'next-turn' ? state.nextTurn : data?.target === 'next-step' ? state.nextStep : undefined
  // An unknown target is not one the reference can splice, so ignore it exactly
  // as foldInbox does.
  if (list === undefined) return state
  const start = data.start
  const removedCount = data.removedCount ?? 0
  if (!Number.isSafeInteger(start) || start < 0 || start > list.length
    || !Number.isSafeInteger(removedCount) || removedCount < 0
    || start + removedCount > list.length) {
    // The reference's splice would silently mangle the list here; refusing to
    // apply keeps the fold deterministic instead of corrupting it.
    return state
  }
  const removed = list.slice(start, start + removedCount)
  const next = [...list.slice(0, start), ...data.inserted.map(item => item.id), ...list.slice(start + removedCount)]
  const canceled = data.outcome === 'canceled' && removed.length > 0
    ? [...state.canceled, ...removed.filter(id => !state.canceled.includes(id))]
    : state.canceled
  return data.target === 'next-turn'
    ? { ...state, nextTurn: next, canceled }
    : { ...state, nextStep: next, canceled }
}

/**
 * Resolve one interrupted record's recovery verdict from folded state.
 *
 * Precedence is the reference's: consumed beats pending beats discarded. A
 * message canceled and later re-delivered is pending again, and one that was
 * canceled and then consumed resolves as consumed.
 * @param state - current recovery state.
 * @param messageId - the record's minted DSH message id.
 * @returns the verdict; callers perform the corresponding durable write.
 */
export function reconciliationView(
  state: ReconciliationState | undefined, messageId: string,
): ReconcileVerdict {
  if (state === undefined) return { action: 'refollowup' }
  if (state.consumed.includes(messageId)) return { action: 'enqueued', via: 'user-message' }
  if (state.nextTurn.includes(messageId) || state.nextStep.includes(messageId)) {
    return { action: 'enqueued', via: 'inbox' }
  }
  if (state.canceled.includes(messageId)) return { action: 'rejected', via: 'canceled-splice' }
  return { action: 'refollowup' }
}

/** Projection definition registered by the bridge. */
export const reconciliationProjectionDefinition = {
  key: 'feishuReconciliation',
  stateVersion: 1,
  stateSchema,
  init: (): ReconciliationState => reconciliationInit(),
  apply: (state: ReconciliationState, event: unknown): ReconciliationState =>
    reconciliationApply(state, event as ReconciliationEvent),
} satisfies {
  key: 'feishuReconciliation'
  stateVersion: number
  stateSchema: z.ZodType<ReconciliationState>
  init: () => ReconciliationState
  apply: (state: ReconciliationState, event: unknown) => ReconciliationState
}
