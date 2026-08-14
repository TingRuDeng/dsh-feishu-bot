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
  sourceEventSeq?: number
  segmentIndex?: number
}

export interface RetentionPlan {
  inboundDelete: string[]
  outboundAbandon: string[]
  outboundDelete: string[]
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

/** Stable restart order: destination FIFO, then event and segment order. */
export function sortPendingOutbox<K extends string, V extends OutboundLike>(
  rows: Iterable<readonly [K, V]>,
): [K, V][] {
  return [...rows]
    .filter((entry): entry is [K, V] => entry[1].status === 'pending')
    .sort(([, left], [, right]) =>
      (left.chatId ?? '').localeCompare(right.chatId ?? '')
      || (left.sourceEventSeq ?? 0) - (right.sourceEventSeq ?? 0)
      || (left.segmentIndex ?? 0) - (right.segmentIndex ?? 0))
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
  }
}
