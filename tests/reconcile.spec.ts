/**
 * M1 gate, layer 1: the five-row reconciliation table (design §6.1) over
 * folded `agent/inbox/spliced` logs. Event payloads mirror the durable
 * format asserted by upstream `packages/core/agent/src/types.ts:19-34`
 * and inbox.ts splice logging; the assembled-runtime replay of the same
 * verdicts is the layer-2 experiment.
 */
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { foldInbox, reconcileMessageFromLog } from '../src/bridge/inbound.ts'

let seq = 0
function spliced(data: {
  target: 'next-turn' | 'next-step'
  start: number
  removedCount: number
  inserted: { id: string }[]
  outcome?: string
}): SessionEvent {
  return { type: 'agent/inbox/spliced', seq: seq++, time: Date.now(), data } as unknown as SessionEvent
}
function userMessage(id: string): SessionEvent {
  return {
    type: 'user/message', seq: seq++, time: Date.now(),
    data: { id, role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } },
  } as unknown as SessionEvent
}

describe('foldInbox', () => {
  it('replays splices into current lists and collects canceled ids', () => {
    const events = [
      spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: 'a' }, { id: 'b' }] }),
      spliced({ target: 'next-turn', start: 0, removedCount: 1, inserted: [] }), // claim of 'a'
      spliced({ target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' }), // cancel 'b'
      spliced({ target: 'next-step', start: 0, removedCount: 0, inserted: [{ id: 'c' }] }),
    ]
    const folded = foldInbox(events)
    expect(folded.nextTurn).toEqual([])
    expect(folded.nextStep).toEqual(['c'])
    expect(folded.canceledIds).toEqual(new Set(['b']))
  })
})

describe('reconcileMessageFromLog: the five-row table', () => {
  it('row 1: no messageId — followup provably never ran — reroute', () => {
    expect(reconcileMessageFromLog({}, [])).toEqual({ action: 'reroute' })
  })

  it('row 2: user/message hit — consumed — enqueued', () => {
    const events = [
      spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: 'm1' }] }),
      spliced({ target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
      userMessage('m1'),
    ]
    expect(reconcileMessageFromLog({ messageId: 'm1' as never }, events))
      .toEqual({ action: 'enqueued', via: 'user-message' })
  })

  it('row 3: still in folded inbox — accepted — enqueued', () => {
    const events = [
      spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: 'm2' }] }),
    ]
    expect(reconcileMessageFromLog({ messageId: 'm2' as never }, events))
      .toEqual({ action: 'enqueued', via: 'inbox' })
  })

  it('row 4: canceled splice discarded it — rejected', () => {
    const events = [
      spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: 'm3' }] }),
      spliced({ target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' }),
    ]
    expect(reconcileMessageFromLog({ messageId: 'm3' as never }, events))
      .toEqual({ action: 'rejected', via: 'canceled-splice' })
  })

  it('row 5: no trace — followup never spliced — refollowup', () => {
    expect(reconcileMessageFromLog({ messageId: 'm4' as never }, [userMessage('other')]))
      .toEqual({ action: 'refollowup' })
  })

  it('user/message wins over a same-id inbox residue (claim already logged)', () => {
    const events = [
      spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: 'm5' }] }),
      userMessage('m5'),
    ]
    expect(reconcileMessageFromLog({ messageId: 'm5' as never }, events))
      .toEqual({ action: 'enqueued', via: 'user-message' })
  })
})
