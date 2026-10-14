/**
 * Projected approval pairing fold.
 *
 * The approval channel used to call
 * `pairApprovalId(agent.session.snapshotEvents(), …)` on every approval
 * request: a synchronous reverse scan of the whole session log that DSH
 * deprecates (`2026-09-09-deprecate-synchronous-session-event-reads`). The
 * pairing input is log-derived state, so the projection registry folds it
 * once per committed event instead.
 *
 * `claimed` deliberately stays a caller-supplied argument: it is live
 * in-memory registry state (approvalIds held by pending entries across both
 * channels), not log-derived, so the projection must not own it.
 *
 * State stays bounded: a decision removes its asks and is remembered by id,
 * so a long session retains only approvals still awaiting a decision.
 */
import { z } from 'zod'

/**
 * Log-derived pairing state; JSON-serializable for checkpoints.
 *
 * `open` holds exactly the asks that could still pair. A decision removes the
 * asks recorded *before* it, which is the reference's positional semantics:
 * it reverse-scans and evaluates each `approval/asked` against decisions seen
 * so far in that reverse walk, i.e. against decisions occurring LATER in the
 * log. A decision therefore never suppresses an ask that follows it. A
 * differential fuzz against the reference caught both mistakes here: first
 * removing only one duplicate, then wrongly suppressing later asks.
 */
export interface ApprovalPairingState {
  /** Undecided `approval/asked` records in log order (newest last). */
  open: { id: string; callId?: string }[]
}

/** Event types the pairing fold consumes. */
export const APPROVAL_PAIRING_EVENT_TYPES: ReadonlySet<string> =
  new Set(['approval/asked', 'approval/decided'])

const pairingStateSchema = z.object({
  open: z.array(z.object({
    id: z.string(),
    callId: z.string().optional(),
  })),
})

/** Initial state for an empty log. */
export function approvalPairingInit(): ApprovalPairingState {
  return { open: [] }
}

/**
 * Advance the pairing fold by one committed event.
 * @param state - state covering every prior event.
 * @param event - the next committed session event.
 * @returns the next state, or the same reference when nothing changed.
 */
export function approvalPairingApply(
  state: ApprovalPairingState, event: { type: string; data: unknown },
): ApprovalPairingState {
  if (!APPROVAL_PAIRING_EVENT_TYPES.has(event.type)) return state
  if (event.type === 'approval/asked') {
    const data = event.data as { id?: unknown; callId?: unknown }
    if (typeof data?.id !== 'string') return state
    const record = typeof data.callId === 'string'
      ? { id: data.id, callId: data.callId }
      : { id: data.id }
    return { open: [...state.open, record] }
  }
  const id = (event.data as { id?: unknown })?.id
  if (typeof id !== 'string') return state
  // Positional: this decision suppresses every ask already recorded under this
  // id, and leaves any later ask alone.
  const open = state.open.filter(record => record.id !== id)
  return open.length === state.open.length ? state : { open }
}

/**
 * Resolve this request's approvalId from folded state.
 *
 * Mirrors the reference scan exactly: newest first, undecided, unclaimed,
 * and callId-symmetric (same callId, or both callId-less).
 * @param state - current pairing state.
 * @param callId - the request's callId, when the asker had one.
 * @param claimed - approvalIds already held by pending entries.
 * @returns the paired id, or undefined (caller must delegate via next()).
 */
export function approvalPairingView(
  state: ApprovalPairingState | undefined,
  callId: string | undefined,
  claimed: ReadonlySet<string>,
): string | undefined {
  if (state === undefined) return undefined
  for (let i = state.open.length - 1; i >= 0; i -= 1) {
    const record = state.open[i]!
    if (claimed.has(record.id)) continue
    if ((callId ?? null) !== (record.callId ?? null)) continue
    return record.id
  }
  return undefined
}

/** Projection definition registered by the bridge. */
export const approvalPairingProjectionDefinition = {
  key: 'feishuApprovalPairing',
  stateVersion: 1,
  stateSchema: pairingStateSchema,
  init: (): ApprovalPairingState => approvalPairingInit(),
  apply: (state: ApprovalPairingState, event: unknown): ApprovalPairingState =>
    approvalPairingApply(state, event as { type: string; data: unknown }),
} satisfies {
  key: 'feishuApprovalPairing'
  stateVersion: number
  stateSchema: z.ZodType<ApprovalPairingState>
  init: () => ApprovalPairingState
  apply: (state: ApprovalPairingState, event: unknown) => ApprovalPairingState
}
