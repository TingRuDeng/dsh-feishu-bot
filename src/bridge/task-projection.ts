/**
 * Projected Feishu task fold.
 *
 * The card path used to call `reduceFeishuTask(session.snapshotEvents(), …)` on
 * every update: a synchronous history scan that DSH deprecates
 * (`2026-09-09-deprecate-synchronous-session-event-reads`). The task itself is
 * log-derived state — `taskStartSeq` comes out of the fold, the tracker only
 * caches it — so it belongs in a Session projection, where the registry drives
 * it once per committed event and readers get an O(1) synchronous value.
 *
 * The heavy lifting lives in `foldFeishuTaskStep`, which is shared with the
 * batch `reduceFeishuTask` reference. Equivalence is therefore structural
 * rather than two implementations kept in sync by hand.
 *
 * State is JSON-serializable: `checkpoint()` runs `structuredClone` over it and
 * persisted rows re-seed the fold through `stateSchema.parse`. The batch fold's
 * `Map`/`Set` bookkeeping is stored as records and arrays here.
 */
import { z } from 'zod'
import {
  feishuTaskFoldFromState,
  foldFeishuTaskStep,
  initFeishuTaskFoldState,
  type CardEvent,
  type FeishuTaskFold,
  type FeishuTaskFoldState,
} from './task-card.ts'

/** Serialized fold bookkeeping; the `Map`/`Set` forms cannot cross a checkpoint. */
export interface FeishuTaskState {
  /** The task currently owned by this session, or null before any direct input. */
  task: FeishuTaskFoldState | null
}

const taskStateSchema = z.object({
  task: z.object({
    taskMessageId: z.string().nullable(),
    taskStartSeq: z.number(),
    scannedThrough: z.number(),
    turn: z.number(),
    openTurn: z.boolean(),
    startedAt: z.number().nullable(),
    endedAt: z.number().nullable(),
    terminal: z.enum(['completed', 'stopped', 'failed']),
    failureCode: z.string().nullable(),
    retryCount: z.number(),
    toolCallCount: z.number(),
    lastSequence: z.number(),
    lastTurnEndSeq: z.number(),
    lastEndedTurn: z.number(),
    lastTurnStartTime: z.number().nullable(),
    lastTurnStartTurn: z.number(),
    boundedByNextTask: z.boolean(),
    openTools: z.record(z.string(), z.string()),
    /**
     * Optional with a default: folds persisted before tool details existed
     * carry no such field, and a required key would make those rows fail to
     * load and silently drop a live task card across a restart.
     */
    openToolDetails: z.record(z.string(), z.string()).default({}),
    seenCalls: z.array(z.string()),
    recentTools: z.array(z.string()),
    /** Aligned with `recentTools`; defaulted for the same compatibility reason. */
    recentToolDetails: z.array(z.string()).default([]),
    startedChildren: z.array(z.string()),
    settledChildren: z.array(z.string()),
    resultCandidates: z.record(z.string(), z.object({ seq: z.number(), text: z.string() })),
    result: z.object({ seq: z.number(), text: z.string() }).optional(),
  }).nullable(),
})

/** Initial state for an empty log. */
export function feishuTaskInit(): FeishuTaskState {
  return { task: null }
}

/**
 * Advance the projection by one committed event.
 *
 * The fold observes the whole log, so the first direct input is discovered by
 * the fold itself rather than by the caller's window. A later direct input
 * starts a fresh task inside the same state, matching what a reader of the
 * live card path expects the "current task" to be.
 * @param state - state covering every prior event.
 * @param event - the next committed session event.
 * @returns the next state.
 */
export function feishuTaskApply(state: FeishuTaskState, event: CardEvent): FeishuTaskState {
  // The batch reference stops at a newer direct input so one card is one task.
  // The projection owns the session's *current* task instead, so it restarts
  // there — while the boundary rules stay shared with the reference.
  const previous = state.task
  if (previous === null) {
    const next = initFeishuTaskFoldState(0)
    // Events before the first direct input never form a task, and the fold
    // leaves `next` untouched for them, so the state reference stands.
    return foldFeishuTaskStep(next, event, 0).applied ? { task: next } : state
  }
  const step = foldFeishuTaskStep(previous, event, 0)
  // An applied event mutates `previous` in place; an irrelevant one leaves it
  // untouched, so the same reference is the correct successor signal.
  if (!step.applied) return state
  if (!step.boundsTask) return { task: previous }
  // A newer direct input begins the next task. Rebuild from the baseline of
  // the turn that opened it: the batch reference anchored at this same input
  // observed that turn/start and carried its time into the new task's
  // duration, while `previous.startedAt` is pinned to the older task's turn.
  const next = initFeishuTaskFoldState(0)
  next.turn = previous.lastTurnStartTurn
  next.startedAt = previous.lastTurnStartTime
  next.lastSequence = previous.lastSequence - 1
  foldFeishuTaskStep(next, event, 0)
  return { task: next }
}

/** Projection definition registered by the bridge. */
export const feishuTaskProjectionDefinition = {
  key: 'feishuTask',
  stateVersion: 1,
  stateSchema: taskStateSchema,
  init: (): FeishuTaskState => feishuTaskInit(),
  apply: (state: FeishuTaskState, event: unknown): FeishuTaskState =>
    feishuTaskApply(state, event as CardEvent),
} satisfies {
  key: 'feishuTask'
  stateVersion: number
  stateSchema: z.ZodType<FeishuTaskState>
  init: () => FeishuTaskState
  apply: (state: FeishuTaskState, event: unknown) => FeishuTaskState
}

/** Read the current fold out of a projection state. */
export function feishuTaskFoldOf(state: FeishuTaskState | undefined): FeishuTaskFold | undefined {
  return feishuTaskFoldFromState(state?.task ?? initFeishuTaskFoldState(0))
}
