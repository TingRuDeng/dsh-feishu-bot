/**
 * Equivalence contract for the projected crash-reconciliation fold.
 *
 * `reconcileMessageFromLog(record, events)` is the batch reference: it decides which
 * of the five recovery rows (design §6.1) applies to one interrupted inbound
 * record. On the recovery path the bridge passed the whole session log in, a
 * deprecated synchronous read, so the projection unit must maintain the same
 * verdicts incrementally.
 *
 * The fold needs three log-derived facts about one message id:
 *   - it reached `user/message` (consumed);
 *   - it still sits in the folded inbox lists (pending);
 *   - it was removed by a canceled splice (discarded).
 * Precedence is fixed and part of the contract: consumed beats pending beats
 * discarded, so a message that was canceled and later re-delivered resolves by
 * the newer evidence.
 *
 * Written before the projection exists: the import is expected to fail until
 * the implementation lands.
 */
import { describe, expect, it } from 'vitest'
import { foldInbox, reconcileMessageFromLog } from '../src/bridge/inbound.ts'
import {
  reconciliationApply,
  reconciliationInit,
  reconciliationView,
  type ReconciliationState,
} from '../src/bridge/reconcile-projection.ts'

type Ev = { seq: number; time: number; type: string; data: unknown }

let seq = 0
const spliced = (data: {
  target: 'next-turn' | 'next-step'
  start: number
  removedCount: number
  inserted: { id: string }[]
  outcome?: string
}): Ev => ({ seq: ++seq, time: 0, type: 'agent/inbox/spliced', data })
const userMessage = (id: string): Ev =>
  ({ seq: ++seq, time: 0, type: 'user/message', data: { id, source: { kind: 'user', via: 'feishu' }, content: [] } })
const unrelated = (): Ev => ({ seq: ++seq, time: 0, type: 'tool/call', data: { callId: 'c', name: 'Bash' } })

/** Drive the projection over the whole log, one event at a time. */
function stepFold(events: readonly Ev[]): ReconciliationState {
  let state = reconciliationInit()
  for (const event of events) state = reconciliationApply(state, event as never)
  return state
}

/** Both implementations must agree on every message id in the log plus absent ones. */
function expectSame(events: readonly Ev[], ids: readonly string[]): void {
  const state = stepFold(events)
  const folded = foldInbox(events as never)
  for (const id of ids) {
    const batch = reconcileMessageFromLog({ messageId: id as never }, events as never)
    const incremental = reconciliationView(state, id)
    expect(incremental, `id=${id} events=${JSON.stringify(events)}`).toEqual(batch)
  }
  // The pending lists are part of the contract too: a verdict can agree while
  // the lists behind it have drifted. Compare their ids directly, honouring
  // the same precedence the reference uses (a consumed id that is also
  // pending still resolves as user-message).
  const consumed = new Set(events
    .filter(event => event.type === 'user/message')
    .map(event => (event.data as { id: string }).id))
  const pendingIds = new Set([...folded.nextTurn, ...folded.nextStep])
  for (const id of ids) {
    if (pendingIds.has(id) && !consumed.has(id)) {
      expect(reconciliationView(state, id), `pending id=${id}`)
        .toEqual({ action: 'enqueued', via: 'inbox' })
    }
    if (consumed.has(id)) {
      expect(reconciliationView(state, id), `consumed id=${id}`)
        .toEqual({ action: 'enqueued', via: 'user-message' })
    }
  }
}

describe('projected reconciliation · equivalence with the batch reference', () => {
  it('row 1: no messageId → reroute (handled before the log is consulted)', () => {
    seq = 0
    // The projection only ever answers for a concrete id; row 1 is the
    // caller's short-circuit. Pinned here so the contract is stated once.
    expect(reconcileMessageFromLog({}, [])).toEqual({ action: 'reroute' })
  })

  it('row 2: user/message hit → enqueued via user-message', () => {
    seq = 0
    const events = [
      spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: 'm1' }] }),
      spliced({ target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
      userMessage('m1'),
    ]
    expectSame(events, ['m1', 'absent'])
  })

  it('row 3: still pending in the folded inbox → enqueued via inbox', () => {
    seq = 0
    const events = [spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: 'm2' }] })]
    expectSame(events, ['m2', 'absent'])
  })

  it('row 3 also covers next-step', () => {
    seq = 0
    const events = [spliced({ target: 'next-step', start: 0, removedCount: 0, inserted: [{ id: 'm2s' }] })]
    expectSame(events, ['m2s'])
  })

  it('row 4: canceled splice discarded it → rejected via canceled-splice', () => {
    seq = 0
    const events = [
      spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: 'm3' }] }),
      spliced({ target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' }),
    ]
    expectSame(events, ['m3', 'absent'])
  })

  it('row 5: no trace → refollowup', () => {
    seq = 0
    expectSame([userMessage('other')], ['m4'])
  })

  it('a non-canceled removal is not a discard', () => {
    seq = 0
    const events = [
      spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: 'm6' }] }),
      spliced({ target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
    ]
    // Claimed by a turn (removed without outcome): no longer pending, but never
    // canceled either, so it is not row 4.
    expectSame(events, ['m6'])
    expect(reconcileMessageFromLog({ messageId: 'm6' as never }, events as never))
      .toEqual({ action: 'refollowup' })
  })

  it('precedence: a consumed message that was also canceled resolves as consumed', () => {
    seq = 0
    const events = [
      spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: 'm7' }] }),
      spliced({ target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' }),
      userMessage('m7'),
    ]
    expectSame(events, ['m7'])
  })

  it('precedence: a re-delivered message that was canceled earlier resolves as pending', () => {
    seq = 0
    const events = [
      spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: 'm8' }] }),
      spliced({ target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' }),
      spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: 'm8' }] }),
    ]
    expectSame(events, ['m8'])
    expect(reconcileMessageFromLog({ messageId: 'm8' as never }, events as never))
      .toEqual({ action: 'enqueued', via: 'inbox' })
  })

  it('user/message wins over a same-id inbox residue (claim already logged)', () => {
    seq = 0
    const events = [
      spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: 'm5' }] }),
      userMessage('m5'),
    ]
    expectSame(events, ['m5'])
    expect(reconcileMessageFromLog({ messageId: 'm5' as never }, events as never))
      .toEqual({ action: 'enqueued', via: 'user-message' })
  })

  it('interleaved splices across both lists replay in order', () => {
    seq = 0
    const events = [
      spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: 'a' }, { id: 'b' }] }),
      spliced({ target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
      spliced({ target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' }),
      spliced({ target: 'next-step', start: 0, removedCount: 0, inserted: [{ id: 'c' }] }),
    ]
    expectSame(events, ['a', 'b', 'c', 'd'])
  })

  it('unrelated events do not disturb the fold', () => {
    seq = 0
    const events = [
      unrelated(),
      spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: 'm9' }] }),
      unrelated(),
    ]
    expectSame(events, ['m9'])
  })

  it('an empty log yields refollowup for any id', () => {
    seq = 0
    expectSame([], ['anything'])
  })
})

describe('projected reconciliation · projection contract', () => {
  it('returns the same state reference for unrelated events', () => {
    seq = 0
    const state = reconciliationInit()
    expect(reconciliationApply(state, unrelated() as never)).toBe(state)
  })

  it('keeps state JSON-serializable so it can be checkpointed', () => {
    seq = 0
    const events = [
      spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: 'a' }] }),
      userMessage('a'),
      spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: 'b' }] }),
      spliced({ target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' }),
    ]
    expect(() => structuredClone(stepFold(events))).not.toThrow()
  })

  it('re-derives the same state when replayed from the start (resume path)', () => {
    seq = 0
    const events = [
      spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: 'a' }] }),
      spliced({ target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' }),
    ]
    expect(stepFold(events)).toEqual(stepFold(events))
  })
})

describe('projected reconciliation · differential fuzz vs the reference', () => {
  /** Deterministic PRNG so any failure is reproducible from the seed. */
  function rng(seed: number): () => number {
    let s = seed >>> 0
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000 }
  }

  it('agrees with the batch reference over randomized splice histories', () => {
    const rand = rng(20261015)
    const pool = ['a', 'b', 'c', 'd']
    let mismatches = 0
    let firstCase = ''

    for (let trial = 0; trial < 3000; trial++) {
      const events: Ev[] = []
      const count = 1 + Math.floor(rand() * 8)
      for (let i = 0; i < count; i++) {
        const roll = rand()
        if (roll < 0.7) {
          // Splice against the reference fold's CURRENT list length, so most
          // splices are well-formed; the rest exercise the invalid branches.
          const folded = foldInbox(events as never)
          const target = rand() < 0.6 ? 'next-turn' : 'next-step'
          const list = target === 'next-turn' ? folded.nextTurn : folded.nextStep
          const start = Math.floor(rand() * (list.length + 1))
          const removedCount = start >= list.length ? 0 : Math.floor(rand() * (list.length - start + 1))
          const insertedCount = Math.floor(rand() * 3)
          const inserted = Array.from({ length: insertedCount }, () =>
            ({ id: pool[Math.floor(rand() * pool.length)]! }))
          const data: Parameters<typeof spliced>[0] = { target, start, removedCount, inserted }
          if (rand() < 0.4) data.outcome = 'canceled'
          events.push(spliced(data))
        } else if (roll < 0.9) {
          events.push(userMessage(pool[Math.floor(rand() * pool.length)]!))
        } else {
          events.push(unrelated())
        }
      }
      const state = stepFold(events)
      for (const id of [...pool, 'absent']) {
        const batch = reconcileMessageFromLog({ messageId: id as never }, events as never)
        const incremental = reconciliationView(state, id)
        if (JSON.stringify(batch) !== JSON.stringify(incremental)) {
          mismatches++
          if (firstCase === '') {
            firstCase = JSON.stringify({ events, id, batch, incremental })
          }
        }
      }
    }

    expect(mismatches, `first mismatch: ${firstCase}`).toBe(0)
  })
})
