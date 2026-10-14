/**
 * Equivalence contract for the projected approval pairing fold.
 *
 * `pairApprovalId(events, callId, claimed)` is the batch reference: it
 * reverse-scans the session log for the newest `approval/asked` that is not
 * decided and not claimed, matching the request's callId symmetry. The
 * projection unit must maintain the same outcome incrementally.
 *
 * `claimed` stays a caller-supplied filter: it is live in-memory registry
 * state, not log-derived, so the projection cannot and must not own it.
 *
 * Written before the projection exists: the module import is expected to
 * fail until the implementation lands.
 */
import { describe, expect, it } from 'vitest'
import { pairApprovalId } from '../src/bridge/approval.ts'
import {
  approvalPairingApply,
  approvalPairingInit,
  approvalPairingView,
  type ApprovalPairingState,
} from '../src/bridge/approval-projection.ts'

type Ev = { seq: number; time: number; type: string; data: unknown }

let seq = 0
const asked = (id: string, callId?: string): Ev =>
  ({ seq: ++seq, time: 0, type: 'approval/asked', data: { id, toolName: 'Bash', ...callId === undefined ? {} : { callId } } })
const decided = (id: string): Ev =>
  ({ seq: ++seq, time: 0, type: 'approval/decided', data: { id, outcome: 'allowed-once' } })
const unrelated = (): Ev => ({ seq: ++seq, time: 0, type: 'tool/call', data: { callId: 'c9', name: 'Bash' } })

/** Drive the projection over the whole log, one event at a time. */
function stepFold(events: readonly Ev[], callId: string | undefined, claimed: ReadonlySet<string> = new Set()): string | undefined {
  let state: ApprovalPairingState = approvalPairingInit()
  for (const event of events) state = approvalPairingApply(state, event as never)
  return approvalPairingView(state, callId, claimed)
}

/** Both implementations must agree on every scenario. */
function expectSame(
  events: readonly Ev[], callId: string | undefined, claimed?: ReadonlySet<string>,
): void {
  const batch = pairApprovalId(events, callId, claimed ?? new Set())
  const incremental = stepFold(events, callId, claimed)
  expect(incremental).toBe(batch)
}

describe('projected approval pairing · equivalence with the batch reference', () => {
  it('pairs the newest undecided asked with the same callId', () => {
    seq = 0
    const events = [asked('a1', 'c1'), decided('a1'), asked('a2', 'c2')]
    expectSame(events, 'c2')
  })

  it('a decided asked never pairs', () => {
    seq = 0
    expectSame([asked('a1', 'c1'), decided('a1')], 'c1')
  })

  it('an id claimed by another pending entry never pairs', () => {
    seq = 0
    expectSame([asked('a1', 'c1')], 'c1', new Set(['a1']))
  })

  it('callId symmetry: skips callId-less records and vice versa', () => {
    seq = 0
    const events = [asked('a1'), asked('a2', 'c2')]
    expectSame(events, undefined)
    expectSame(events, 'c2')
    expectSame(events, 'c3')
  })

  it('parallel asks with distinct callIds pair without cross-stealing', () => {
    seq = 0
    const events = [asked('a1', 'c1'), asked('a2', 'c2')]
    expectSame(events, 'c1')
    expectSame(events, 'c2')
  })

  it('newest wins when several asks share one callId', () => {
    seq = 0
    const events = [asked('a1', 'c1'), asked('a2', 'c1')]
    expectSame(events, 'c1')
  })

  it('a decided older ask does not hide a newer live one', () => {
    seq = 0
    const events = [asked('a1', 'c1'), decided('a1'), asked('a2', 'c1')]
    expectSame(events, 'c1')
  })

  it('deciding the newest ask falls back to the older live one', () => {
    seq = 0
    const events = [asked('a1', 'c1'), asked('a2', 'c1'), decided('a2')]
    expectSame(events, 'c1')
  })

  it('a decided event for an unknown id changes nothing', () => {
    seq = 0
    const events = [asked('a1', 'c1'), decided('never-asked')]
    expectSame(events, 'c1')
  })

  it('unrelated events do not disturb the fold', () => {
    seq = 0
    const events = [unrelated(), asked('a1', 'c1'), unrelated()]
    expectSame(events, 'c1')
  })

  it('an empty log pairs nothing', () => {
    seq = 0
    expectSame([], 'c1')
    expectSame([], undefined)
  })

  // Found by a differential fuzz against the reference: a decision suppresses
  // EVERY ask carrying that id, not just one of them, because the reference
  // collects decisions across the whole log before pairing anything.
  it('one decision suppresses every duplicate ask of the same id', () => {
    seq = 0
    const events = [asked('a1', 'c1'), asked('a1', 'c1'), decided('a1')]
    expectSame(events, 'c1')
  })

  it('a decision before the ask does not suppress it (positional semantics)', () => {
    seq = 0
    const events = [decided('a1'), asked('a1', 'c1')]
    expectSame(events, 'c1')
    expect(pairApprovalId(events, 'c1', new Set())).toBe('a1')
  })

  it('a decision leaves asks that follow it alone', () => {
    seq = 0
    const events = [asked('a1', 'c1'), decided('a1'), asked('a1', 'c1')]
    expectSame(events, 'c1')
    expect(pairApprovalId(events, 'c1', new Set())).toBe('a1')
  })

  it('duplicate asks under different callIds are all suppressed together', () => {
    seq = 0
    const events = [asked('a1', 'c1'), asked('a1', 'c2'), decided('a1')]
    expectSame(events, 'c1')
    expectSame(events, 'c2')
  })
})

describe('projected approval pairing · projection contract', () => {
  it('returns the same state reference for unrelated events', () => {
    seq = 0
    const state = approvalPairingInit()
    expect(approvalPairingApply(state, unrelated() as never)).toBe(state)
  })

  it('keeps state JSON-serializable so it can be checkpointed', () => {
    seq = 0
    const events = [asked('a1', 'c1'), asked('a2'), decided('a1'), unrelated()]
    let state = approvalPairingInit()
    for (const event of events) state = approvalPairingApply(state, event as never)
    expect(() => structuredClone(state)).not.toThrow()
  })

  it('keeps state bounded: decided asks are dropped, not accumulated', () => {
    seq = 0
    // A long session with many settled approvals must not retain them all.
    let state = approvalPairingInit()
    for (let i = 0; i < 200; i++) {
      state = approvalPairingApply(state, asked(`a${i}`, `c${i}`) as never)
      state = approvalPairingApply(state, decided(`a${i}`) as never)
    }
    expect(JSON.stringify(state).length).toBeLessThan(200)
    expect(approvalPairingView(state, 'c199', new Set())).toBeUndefined()
  })
})

describe('projected approval pairing · differential fuzz vs the reference', () => {
  /** Deterministic PRNG so any failure is reproducible from the seed. */
  function rng(seed: number): () => number {
    let s = seed >>> 0
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000 }
  }

  it('agrees with pairApprovalId over randomized logs', () => {
    const rand = rng(20261014)
    const ids = ['a1', 'a2', 'a3']
    const callIds = [undefined, 'c1', 'c2']
    const claimedSets = [[], ['a1'], ['a2'], ['a1', 'a2', 'a3']]
    let mismatches = 0
    let firstCase = ''

    for (let trial = 0; trial < 2000; trial++) {
      const events: Ev[] = []
      const count = 1 + Math.floor(rand() * 8)
      for (let i = 0; i < count; i++) {
        const roll = rand()
        const id = ids[Math.floor(rand() * ids.length)]!
        if (roll < 0.5) {
          const callId = callIds[Math.floor(rand() * callIds.length)]
          events.push(asked(id, callId))
        } else if (roll < 0.85) {
          events.push(decided(id))
        } else {
          events.push(unrelated())
        }
      }
      let state = approvalPairingInit()
      for (const event of events) state = approvalPairingApply(state, event as never)
      for (const callId of [undefined, 'c1', 'c2', 'c3']) {
        for (const claimedList of claimedSets) {
          const claimed = new Set(claimedList)
          const batch = pairApprovalId(events, callId, claimed)
          const incremental = approvalPairingView(state, callId, claimed)
          if (batch !== incremental) {
            mismatches++
            if (firstCase === '') {
              firstCase = JSON.stringify({ events, callId, claimed: claimedList, batch, incremental })
            }
          }
        }
      }
    }

    expect(mismatches, `first mismatch: ${firstCase}`).toBe(0)
  })
})
