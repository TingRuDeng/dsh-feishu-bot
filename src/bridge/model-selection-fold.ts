/**
 * Model-selection fold: the session's current provider/model/effort.
 *
 * The bridge reads a session's current selection for `/status`, the model
 * card, and the binding display. That selection is a durable consequence of
 * the log — the newest `request/header` records exactly what the last request
 * was sent with — so a projection unit folds it once per committed event
 * instead of each read re-scanning the history.
 *
 * The batch form below is kept as the reference oracle for the projection's
 * equivalence tests; the live path reads the projection.
 */
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'

/** The event fields the fold reads; structurally satisfied by SessionEvent. */
export interface ModelSelectionEvent {
  type: string
  data: unknown
}

/** Event types the fold consumes. */
export const MODEL_SELECTION_EVENT_TYPES: ReadonlySet<string> = new Set(['request/header'])

/**
 * Read one `request/header` event's selection.
 *
 * Returns `undefined` for a malformed record rather than skipping it: the
 * caller treats the newest record as authoritative, so a broken latest header
 * means "no selection", never a fall-back to an older one.
 * @param data - the event's `data` field.
 * @returns the selection, or undefined when the record is unusable.
 */
export function readRequestHeaderSelection(data: unknown): ModelSelection | undefined {
  const config = (data as { header?: { config?: unknown } } | null | undefined)?.header?.config
  if (typeof config !== 'object' || config === null) return undefined
  const value = config as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
  if (typeof value.provider !== 'string' || typeof value.model !== 'string') return undefined
  return {
    provider: value.provider,
    model: value.model,
    ...(typeof value.reasoningEffort === 'string' ? { reasoningEffort: ReasoningEffortId(value.reasoningEffort) } : {}),
  }
}

/**
 * Find the newest `request/header`'s selection in a log.
 *
 * Reference oracle for the projection: the newest record wins outright, and a
 * malformed newest record yields `undefined` instead of an older valid one.
 * @param events - session events in log order.
 * @returns the selection, or undefined when no usable header exists.
 */
export function latestModelSelection(
  events: readonly ModelSelectionEvent[],
): ModelSelection | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type !== 'request/header') continue
    return readRequestHeaderSelection(event.data)
  }
  return undefined
}
