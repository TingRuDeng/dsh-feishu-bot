/**
 * Projected model-selection fold.
 *
 * `/status`, the model card, and the binding display used to re-scan the
 * session log for the newest `request/header` on every read
 * (`session.snapshotEvents()`, deprecated by DSH
 * `2026-09-09-deprecate-synchronous-session-event-reads`). The selection is
 * log-derived state, so the registry folds it once per committed event.
 *
 * State must distinguish three cases that a bare `ModelSelection | undefined`
 * would collapse:
 *   - no `request/header` has been logged yet (fail back to the bridge's
 *     in-memory selection ref);
 *   - the newest header is unusable (authoritative "no selection");
 *   - a usable selection.
 * `seen` carries that distinction, because the reference deliberately does
 * NOT fall back to an older valid header when the newest one is malformed.
 */
import { z } from 'zod'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import {
  MODEL_SELECTION_EVENT_TYPES,
  readRequestHeaderSelection,
  type ModelSelectionEvent,
} from './model-selection-fold.ts'

/** Log-derived selection state; JSON-serializable for checkpoints. */
export interface ModelSelectionState {
  /** True once any `request/header` has been logged. */
  seen: boolean
  /** The newest header's selection; absent when that header was unusable. */
  selection: ModelSelection | null
}

const selectionSchema = z.object({
  provider: z.string(),
  model: z.string(),
  // reasoningEffort is a branded id, so parse must re-apply the brand for a
  // restored checkpoint row to satisfy ModelSelection.
  reasoningEffort: z.string().transform(value => ReasoningEffortId(value)).optional(),
})

const stateSchema = z.object({
  seen: z.boolean(),
  selection: selectionSchema.nullable(),
})

/** Initial state for an empty log. */
export function modelSelectionInit(): ModelSelectionState {
  return { seen: false, selection: null }
}

/**
 * Advance the selection fold by one committed event.
 *
 * The newest `request/header` always replaces the previous one, including
 * when it is malformed: the reference stops at the newest record, so a broken
 * latest header clears the selection rather than falling back.
 * @param state - state covering every prior event.
 * @param event - the next committed session event.
 * @returns the next state, or the same reference when nothing changed.
 */
export function modelSelectionApply(
  state: ModelSelectionState, event: ModelSelectionEvent,
): ModelSelectionState {
  if (!MODEL_SELECTION_EVENT_TYPES.has(event.type)) return state
  const selection = readRequestHeaderSelection(event.data)
  if (selection === undefined) {
    return state.seen && state.selection === null ? state : { seen: true, selection: null }
  }
  return {
    seen: true,
    selection: {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(String(selection.reasoningEffort)) }),
    },
  }
}

/**
 * Read the folded selection.
 * @param state - current selection state.
 * @returns the selection, or undefined when no header was logged or the
 * newest one was unusable. Callers fall back to their in-memory ref on
 * undefined, which is why `seen` is not part of this result.
 */
export function modelSelectionView(state: ModelSelectionState | undefined): ModelSelection | undefined {
  return state?.selection ?? undefined
}

/** Projection definition registered by the bridge. */
export const modelSelectionProjectionDefinition = {
  key: 'feishuModelSelection',
  stateVersion: 1,
  stateSchema,
  init: (): ModelSelectionState => modelSelectionInit(),
  apply: (state: ModelSelectionState, event: unknown): ModelSelectionState =>
    modelSelectionApply(state, event as ModelSelectionEvent),
} satisfies {
  key: 'feishuModelSelection'
  stateVersion: number
  stateSchema: z.ZodType<ModelSelectionState>
  init: () => ModelSelectionState
  apply: (state: ModelSelectionState, event: unknown) => ModelSelectionState
}
