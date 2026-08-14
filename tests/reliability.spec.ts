import { describe, expect, it } from 'vitest'
import {
  danglingActiveBindings,
  isAtOrBelowWatermark,
  isRecoveryExpired,
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

  it('sorts pending outbox rows by chat, source sequence, then segment index', () => {
    const rows = [
      ['c', { chatId: 'b', sourceEventSeq: 1, segmentIndex: 0, status: 'pending' }],
      ['b', { chatId: 'a', sourceEventSeq: 2, segmentIndex: 0, status: 'pending' }],
      ['a', { chatId: 'a', sourceEventSeq: 1, segmentIndex: 1, status: 'pending' }],
      ['z', { chatId: 'a', sourceEventSeq: 1, segmentIndex: 0, status: 'sent' }],
    ] as const
    expect(sortPendingOutbox(rows).map(([key]) => key)).toEqual(['a', 'b', 'c'])
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
    })
  })
})
