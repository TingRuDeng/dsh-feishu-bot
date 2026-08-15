import { describe, expect, it } from 'vitest'
import * as reliability from '../src/bridge/reliability.ts'
import {
  danglingActiveBindings,
  isAtOrBelowWatermark,
  isRecoveryExpired,
  planDurableRetention,
  planRetention,
  sortPendingOutbox,
  watermarkKey,
} from '../src/bridge/reliability.ts'

describe('M4 reliability decisions', () => {
  it('expires received work only after the recovery TTL', () => {
    expect(isRecoveryExpired(1_000, 2_000, 1_000)).toBe(false)
    expect(isRecoveryExpired(1_000, 2_001, 1_000)).toBe(true)
  })

  it('finds only active bindings whose session is absent', () => {
    const bindings = [
      ['oc_ok', { status: 'active', sessionId: 's1' }],
      ['oc_missing', { status: 'active', sessionId: 's2' }],
      ['oc_unavailable', { status: 'unavailable', sessionId: 's3' }],
    ] as const
    expect(danglingActiveBindings(bindings, new Set(['s1'])))
      .toEqual(['oc_missing'])
  })

  it('sorts pending outbox rows by chat creation order, then same-session segment order', () => {
    const rows = [
      ['new-low-seq', {
        chatId: 'a', sessionId: 'new', sourceEventSeq: 1, segmentIndex: 0,
        createdAt: 20, status: 'pending',
      }],
      ['other-chat', {
        chatId: 'b', sessionId: 'old', sourceEventSeq: 1, segmentIndex: 0,
        createdAt: 1, status: 'pending',
      }],
      ['old-segment-1', {
        chatId: 'a', sessionId: 'old', sourceEventSeq: 50, segmentIndex: 1,
        createdAt: 10, status: 'pending',
      }],
      ['old-segment-0', {
        chatId: 'a', sessionId: 'old', sourceEventSeq: 50, segmentIndex: 0,
        createdAt: 10, status: 'pending',
      }],
      ['sent', {
        chatId: 'a', sessionId: 'old', sourceEventSeq: 1, segmentIndex: 0,
        createdAt: 1, status: 'sent',
      }],
    ] as const
    expect(sortPendingOutbox(rows).map(([key]) => key))
      .toEqual(['old-segment-0', 'old-segment-1', 'new-low-seq', 'other-chat'])
  })

  it('uses a per-chat/session watermark and rejects replay at or below it', () => {
    const key = watermarkKey('oc_a', 's:1')
    const watermarks = { [key]: 7 }
    expect(isAtOrBelowWatermark(watermarks, 'oc_a', 's:1', 7)).toBe(true)
    expect(isAtOrBelowWatermark(watermarks, 'oc_a', 's:1', 8)).toBe(false)
    expect(isAtOrBelowWatermark(watermarks, 'oc_b', 's:1', 7)).toBe(false)
  })

  it('plans TTL and capacity cleanup without deleting recoverable work', () => {
    const now = 10_000
    const inbound = [
      ['received', { status: 'received', receivedAt: 1 }],
      ['old-terminal', { status: 'enqueued', receivedAt: 1 }],
      ['newer-terminal', { status: 'rejected', receivedAt: 9_500 }],
    ] as const
    const outbound = [
      ['old-pending', { status: 'pending', createdAt: 1 }],
      ['fresh-pending', { status: 'pending', createdAt: 9_500 }],
      ['old-sent', { status: 'sent', createdAt: 1 }],
      ['new-sent', { status: 'sent', createdAt: 9_000 }],
    ] as const

    expect(planRetention(inbound, outbound, now, {
      inboundRetentionMs: 5_000,
      inboundMaxRecords: 2,
      outboundRetentionMs: 5_000,
      outboundPendingTtlMs: 5_000,
      outboundMaxRecords: 2,
    })).toEqual({
      inboundDelete: ['old-terminal'],
      outboundAbandon: ['old-pending'],
      outboundDelete: ['old-sent', 'old-pending'],
      inboundOverCapacity: false,
      outboundOverCapacity: false,
    })
  })

  it('signals hard backpressure when every over-capacity row is still recoverable', () => {
    const plan = planRetention(
      [['in-flight', { status: 'received', receivedAt: 9_999 }]],
      [['pending', { status: 'pending', createdAt: 9_999 }]],
      10_000,
      {
        inboundRetentionMs: 5_000,
        inboundMaxRecords: 0,
        outboundRetentionMs: 5_000,
        outboundPendingTtlMs: 5_000,
        outboundMaxRecords: 0,
      },
    )

    expect(plan.inboundOverCapacity).toBe(true)
    expect(plan.outboundOverCapacity).toBe(true)
  })

  it('prunes only cursors whose binding is gone and whose deliveries are terminal', () => {
    const prune = (reliability as unknown as {
      pruneProjectionCursors?: (
        cursors: Readonly<Record<string, number>>,
        activeKeys: ReadonlySet<string>,
        pendingKeys: ReadonlySet<string>,
      ) => Record<string, number>
    }).pruneProjectionCursors

    expect(prune).toBeTypeOf('function')
    expect(prune!(
      { active: 3, pending: 5, obsolete: 7 },
      new Set(['active']),
      new Set(['pending']),
    )).toEqual({ active: 3, pending: 5 })
  })

  it('plans bounded delivery, approval, and cursor cleanup without evicting live work', () => {
    const plan = planDurableRetention(
      [
        ['expired-pending', { status: 'pending', createdAt: 1 }],
        ['fresh-pending', { status: 'pending', createdAt: 9_900 }],
        ['old-sent', { status: 'sent', createdAt: 1 }],
        ['new-sent', { status: 'sent', createdAt: 9_500 }],
      ],
      [
        ['active-approval', { createdAt: 1 }],
        ['stale-approval', { createdAt: 1 }],
        ['fresh-approval', { createdAt: 9_900 }],
      ],
      [
        ['active-cursor', { sourceEventSeq: 3, updatedAt: 1 }],
        ['pending-cursor', { sourceEventSeq: 5, updatedAt: 1 }],
        ['obsolete-cursor', { sourceEventSeq: 7, updatedAt: 1 }],
        ['new-cursor', { sourceEventSeq: 9, updatedAt: 9_900 }],
      ],
      10_000,
      {
        deliveryRetentionMs: 5_000,
        deliveryPendingTtlMs: 5_000,
        deliveryMaxRecords: 2,
        approvalPendingTtlMs: 5_000,
        approvalMaxRecords: 2,
        projectionCursorRetentionMs: 5_000,
        projectionCursorMaxRecords: 3,
      },
      new Set(['active-approval']),
      new Set(['active-cursor']),
      new Set(['pending-cursor']),
    )

    expect(plan).toEqual({
      deliveryAbandon: ['expired-pending'],
      deliveryDelete: ['old-sent', 'expired-pending'],
      approvalDelete: ['stale-approval'],
      cursorDelete: ['obsolete-cursor'],
      deliveryOverCapacity: false,
      approvalOverCapacity: false,
      projectionCursorOverCapacity: false,
    })
  })

  it('signals backpressure when only protected durable rows exceed hard limits', () => {
    const plan = planDurableRetention(
      [['delivery', { status: 'pending', createdAt: 10_000 }]],
      [['approval', { createdAt: 10_000 }]],
      [['cursor', { sourceEventSeq: 1, updatedAt: 10_000 }]],
      10_000,
      {
        deliveryRetentionMs: 5_000,
        deliveryPendingTtlMs: 5_000,
        deliveryMaxRecords: 0,
        approvalPendingTtlMs: 5_000,
        approvalMaxRecords: 0,
        projectionCursorRetentionMs: 5_000,
        projectionCursorMaxRecords: 0,
      },
      new Set(['approval']),
      new Set(['cursor']),
      new Set(['cursor']),
    )

    expect(plan.deliveryOverCapacity).toBe(true)
    expect(plan.approvalOverCapacity).toBe(true)
    expect(plan.projectionCursorOverCapacity).toBe(true)
  })
})
