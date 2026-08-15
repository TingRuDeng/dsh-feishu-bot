/** Pure M4 reliability decisions shared by startup recovery and tests. */

export interface RetentionConfig {
  inboundRetentionMs: number
  inboundMaxRecords: number
  outboundRetentionMs: number
  outboundPendingTtlMs: number
  outboundMaxRecords: number
}

type BindingLike = { status: string; sessionId: string }
type InboundLike = { status: string; receivedAt: number }
type OutboundLike = {
  status: string
  createdAt: number
  chatId?: string
  sessionId?: string
  sourceEventSeq?: number
  segmentIndex?: number
}

export interface RetentionPlan {
  inboundDelete: string[]
  outboundAbandon: string[]
  outboundDelete: string[]
  /** True when protected recoverable rows still exceed the configured limit. */
  inboundOverCapacity: boolean
  /** True when protected pending rows still exceed the configured limit. */
  outboundOverCapacity: boolean
}

export interface DurableRetentionConfig {
  deliveryRetentionMs: number
  deliveryPendingTtlMs: number
  deliveryMaxRecords: number
  approvalPendingTtlMs: number
  approvalMaxRecords: number
  projectionCursorRetentionMs: number
  projectionCursorMaxRecords: number
}

type DeliveryLike = { status: string; createdAt: number }
type ApprovalLike = { createdAt: number }
type CursorLike = { sourceEventSeq: number; updatedAt?: number }

export interface DurableRetentionPlan {
  deliveryAbandon: string[]
  deliveryDelete: string[]
  approvalDelete: string[]
  cursorDelete: string[]
  deliveryOverCapacity: boolean
  approvalOverCapacity: boolean
  projectionCursorOverCapacity: boolean
}

/** A recovery item is valid through the exact TTL boundary. */
export function isRecoveryExpired(receivedAt: number, now: number, ttlMs: number): boolean {
  return now - receivedAt > ttlMs
}

/** Return active binding keys that do not point at a known live/persisted session. */
export function danglingActiveBindings<K extends string>(
  bindings: Iterable<readonly [K, BindingLike]>, knownSessionIds: ReadonlySet<string>,
): K[] {
  const dangling: K[] = []
  for (const [key, binding] of bindings) {
    if (binding.status === 'active' && !knownSessionIds.has(binding.sessionId)) dangling.push(key)
  }
  return dangling
}

/** Collision-safe key for one chat's projection position in one session. */
export function watermarkKey(chatId: string, sessionId: string): string {
  return JSON.stringify([chatId, sessionId])
}

/** True when a replay has already been durably projected for this destination. */
export function isAtOrBelowWatermark(
  watermarks: Readonly<Record<string, number>>, chatId: string, sessionId: string, sequence: number,
): boolean {
  return sequence <= (watermarks[watermarkKey(chatId, sessionId)] ?? -1)
}

/**
 * Keep projection positions that still have an owner or protect retryable
 * delivery work. Every other cursor can be rebuilt from the session log.
 */
export function pruneProjectionCursors(
  cursors: Readonly<Record<string, number>>,
  activeKeys: ReadonlySet<string>,
  pendingKeys: ReadonlySet<string>,
): Record<string, number> {
  return Object.fromEntries(Object.entries(cursors)
    .filter(([key]) => activeKeys.has(key) || pendingKeys.has(key)))
}

/**
 * Plan cleanup for the canonical delivery path and its adjacent state.
 * Live approvals, active bindings, and cursors protecting pending deliveries
 * are never evicted merely to satisfy a capacity limit.
 */
export function planDurableRetention(
  deliveryRows: Iterable<readonly [string, DeliveryLike]>,
  approvalRows: Iterable<readonly [string, ApprovalLike]>,
  cursorRows: Iterable<readonly [string, CursorLike]>,
  now: number,
  config: DurableRetentionConfig,
  activeApprovalKeys: ReadonlySet<string>,
  activeCursorKeys: ReadonlySet<string>,
  pendingCursorKeys: ReadonlySet<string>,
): DurableRetentionPlan {
  const deliveries = [...deliveryRows]
  const approvals = [...approvalRows]
  const cursors = [...cursorRows]
  const deliveryAbandon = new Set<string>()
  const deliveryDelete = new Set<string>()
  const approvalDelete = new Set<string>()
  const cursorDelete = new Set<string>()

  for (const [key, row] of deliveries) {
    if (row.status === 'pending' && now - row.createdAt > config.deliveryPendingTtlMs) {
      deliveryAbandon.add(key)
    } else if (row.status !== 'pending' && now - row.createdAt > config.deliveryRetentionMs) {
      deliveryDelete.add(key)
    }
  }
  let deliveryExcess = deliveries.length - deliveryDelete.size - config.deliveryMaxRecords
  if (deliveryExcess > 0) {
    const deletable = deliveries
      .filter(([key, row]) => !deliveryDelete.has(key)
        && (row.status !== 'pending' || deliveryAbandon.has(key)))
      .sort(([, left], [, right]) => left.createdAt - right.createdAt)
    for (const [key] of deletable) {
      if (deliveryExcess-- <= 0) break
      deliveryDelete.add(key)
    }
  }

  for (const [key, row] of approvals) {
    if (!activeApprovalKeys.has(key)
      && now - row.createdAt > config.approvalPendingTtlMs) approvalDelete.add(key)
  }
  // A fresh inactive row can represent an ambiguous card create. Capacity
  // pressure must not erase that recovery fact before its TTL; callers apply
  // backpressure until an expired row becomes safely removable.

  const cursorProtected = (key: string): boolean =>
    activeCursorKeys.has(key) || pendingCursorKeys.has(key)
  for (const [key, row] of cursors) {
    const updatedAt = row.updatedAt ?? 0
    if (!cursorProtected(key)
      && now - updatedAt > config.projectionCursorRetentionMs) cursorDelete.add(key)
  }
  let cursorExcess = cursors.length - cursorDelete.size - config.projectionCursorMaxRecords
  if (cursorExcess > 0) {
    const deletable = cursors
      .filter(([key]) => !cursorProtected(key) && !cursorDelete.has(key))
      .sort(([leftKey, left], [rightKey, right]) =>
        (left.updatedAt ?? 0) - (right.updatedAt ?? 0) || leftKey.localeCompare(rightKey))
    for (const [key] of deletable) {
      if (cursorExcess-- <= 0) break
      cursorDelete.add(key)
    }
  }

  return {
    deliveryAbandon: [...deliveryAbandon],
    deliveryDelete: [...deliveryDelete],
    approvalDelete: [...approvalDelete],
    cursorDelete: [...cursorDelete],
    deliveryOverCapacity: deliveries.length - deliveryDelete.size > config.deliveryMaxRecords,
    approvalOverCapacity: approvals.length - approvalDelete.size > config.approvalMaxRecords,
    projectionCursorOverCapacity:
      cursors.length - cursorDelete.size > config.projectionCursorMaxRecords,
  }
}

/** Stable restart order: destination FIFO, creation order, then same-session event order. */
export function sortPendingOutbox<K extends string, V extends OutboundLike>(
  rows: Iterable<readonly [K, V]>,
): [K, V][] {
  return [...rows]
    .filter((entry): entry is [K, V] => entry[1].status === 'pending')
    .sort(([leftKey, left], [rightKey, right]) =>
      (left.chatId ?? '').localeCompare(right.chatId ?? '')
      || left.createdAt - right.createdAt
      || (left.sessionId === right.sessionId
        ? (left.sourceEventSeq ?? 0) - (right.sourceEventSeq ?? 0)
          || (left.segmentIndex ?? 0) - (right.segmentIndex ?? 0)
        : 0)
      || leftKey.localeCompare(rightKey))
}

/**
 * Plan deterministic cleanup. Recoverable inbound rows and fresh pending
 * outbox rows are never deleted merely to satisfy a capacity limit.
 */
export function planRetention(
  inboundRows: Iterable<readonly [string, InboundLike]>,
  outboundRows: Iterable<readonly [string, OutboundLike]>,
  now: number,
  config: RetentionConfig,
): RetentionPlan {
  const inbound = [...inboundRows]
  const outbound = [...outboundRows]
  const inboundDelete = new Set<string>()
  const outboundAbandon = new Set<string>()
  const outboundDelete = new Set<string>()

  const inboundTerminal = ([, row]: readonly [string, InboundLike]): boolean =>
    row.status !== 'received' && row.status !== 'recovering'
  for (const [key, row] of inbound) {
    if (inboundTerminal([key, row]) && now - row.receivedAt > config.inboundRetentionMs) {
      inboundDelete.add(key)
    }
  }
  let inboundExcess = inbound.length - inboundDelete.size - config.inboundMaxRecords
  if (inboundExcess > 0) {
    for (const [key] of inbound
      .filter(entry => inboundTerminal(entry) && !inboundDelete.has(entry[0]))
      .sort(([, left], [, right]) => left.receivedAt - right.receivedAt)) {
      if (inboundExcess-- <= 0) break
      inboundDelete.add(key)
    }
  }

  for (const [key, row] of outbound) {
    if (row.status === 'pending' && now - row.createdAt > config.outboundPendingTtlMs) {
      outboundAbandon.add(key)
    } else if (row.status !== 'pending' && now - row.createdAt > config.outboundRetentionMs) {
      outboundDelete.add(key)
    }
  }
  let outboundExcess = outbound.length - outboundDelete.size - config.outboundMaxRecords
  if (outboundExcess > 0) {
    const deletable = outbound
      .filter(([key, row]) => !outboundDelete.has(key)
        && (row.status !== 'pending' || outboundAbandon.has(key)))
      .sort(([, left], [, right]) => left.createdAt - right.createdAt)
    for (const [key] of deletable) {
      if (outboundExcess-- <= 0) break
      outboundDelete.add(key)
    }
  }

  return {
    inboundDelete: [...inboundDelete],
    outboundAbandon: [...outboundAbandon],
    outboundDelete: [...outboundDelete],
    inboundOverCapacity: inbound.length - inboundDelete.size > config.inboundMaxRecords,
    outboundOverCapacity: outbound.length - outboundDelete.size > config.outboundMaxRecords,
  }
}
