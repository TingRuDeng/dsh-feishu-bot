/**
 * Equivalence contract for the projected model-selection fold.
 *
 * `latestModelSelection(events)` is the batch reference: it walks the log
 * backwards to the newest `request/header` and reads that request's config.
 * The projection unit must maintain the same outcome incrementally.
 *
 * The subtle part is what happens to the newest record when its config is
 * malformed: the reference returns `undefined` there rather than continuing
 * to an older valid header. That is "latest wins, malformed latest means no
 * selection" — not "latest valid wins". These tests pin that behaviour down.
 *
 * Written before the projection exists: the import is expected to fail until
 * the implementation lands.
 */
import { describe, expect, it } from 'vitest'
import { latestModelSelection, type ModelSelection } from '../src/bridge/model-selection-fold.ts'
import {
  modelSelectionApply,
  modelSelectionInit,
  modelSelectionProjectionDefinition,
  modelSelectionView,
  type ModelSelectionState,
} from '../src/bridge/model-selection-projection.ts'

type Ev = { seq: number; time: number; type: string; data: unknown }

let seq = 0
const header = (config: unknown, extra?: Record<string, unknown>): Ev =>
  ({ seq: ++seq, time: 0, type: 'request/header', data: { header: { config, ...extra }, reason: 'change' } })
const brokenHeader = (data: unknown): Ev =>
  ({ seq: ++seq, time: 0, type: 'request/header', data })
const unrelated = (): Ev => ({ seq: ++seq, time: 0, type: 'tool/call', data: { callId: 'c1', name: 'Bash' } })

/** Drive the projection over the whole log, one event at a time. */
function stepFold(events: readonly Ev[]): ModelSelection | undefined {
  let state: ModelSelectionState = modelSelectionInit()
  for (const event of events) state = modelSelectionApply(state, event as never)
  return modelSelectionView(state)
}

function expectSame(events: readonly Ev[]): void {
  expect(stepFold(events)).toEqual(latestModelSelection(events))
}

describe('projected model selection · equivalence with the batch reference', () => {
  it('no request/header at all → both undefined', () => {
    seq = 0
    expectSame([])
    expectSame([unrelated()])
  })

  it('a single header with provider and model', () => {
    seq = 0
    expectSame([header({ provider: 'anthropic', model: 'claude-sonnet-4' })])
  })

  it('carries reasoningEffort when present', () => {
    seq = 0
    expectSame([header({ provider: 'p', model: 'm', reasoningEffort: 'high' })])
  })

  it('the newest header wins over older ones', () => {
    seq = 0
    expectSame([
      header({ provider: 'old', model: 'm1' }),
      unrelated(),
      header({ provider: 'new', model: 'm2' }),
    ])
  })

  it('a malformed newest header yields undefined, not an older valid one', () => {
    seq = 0
    // "latest wins": a broken latest record must not fall back to m1.
    const events = [
      header({ provider: 'anthropic', model: 'm1' }),
      header({ provider: 'anthropic' }),
    ]
    expect(stepFold(events)).toBeUndefined()
    expectSame(events)
  })

  it('an empty config object yields undefined', () => {
    seq = 0
    expectSame([header({ provider: 'a', model: 'b' }), header({})])
  })

  it('a non-object config yields undefined', () => {
    seq = 0
    expectSame([header({ provider: 'a', model: 'b' }), header('not-an-object')])
    seq = 0
    expectSame([header({ provider: 'a', model: 'b' }), header(null)])
  })

  it('a header without a config field yields undefined', () => {
    seq = 0
    expectSame([header({ provider: 'a', model: 'b' }), brokenHeader({ header: {} })])
  })

  it('a header whose data is not an object yields undefined', () => {
    seq = 0
    expectSame([header({ provider: 'a', model: 'b' }), brokenHeader(undefined)])
    seq = 0
    expectSame([header({ provider: 'a', model: 'b' }), brokenHeader('nope')])
  })

  it('a non-string reasoningEffort is dropped, not rejected', () => {
    seq = 0
    expectSame([header({ provider: 'p', model: 'm', reasoningEffort: 42 })])
  })

  it('unrelated events between headers do not disturb the fold', () => {
    seq = 0
    expectSame([
      header({ provider: 'a', model: 'm1' }),
      unrelated(), unrelated(),
      header({ provider: 'b', model: 'm2' }),
      unrelated(),
    ])
  })

  it('re-derives the same state when replayed from the start (resume path)', () => {
    seq = 0
    const events = [header({ provider: 'a', model: 'm1' }), header({ provider: 'b', model: 'm2' })]
    expect(stepFold(events)).toEqual(stepFold(events))
  })
})

describe('projected model selection · projection contract', () => {
  it('returns the same state reference for unrelated events', () => {
    seq = 0
    const state = modelSelectionInit()
    expect(modelSelectionApply(state, unrelated() as never)).toBe(state)
  })

  it('keeps state JSON-serializable so it can be checkpointed', () => {
    seq = 0
    let state = modelSelectionInit()
    for (const event of [unrelated(), header({ provider: 'a', model: 'm', reasoningEffort: 'high' })]) {
      state = modelSelectionApply(state, event as never)
    }
    expect(() => structuredClone(state)).not.toThrow()
  })

  it('keeps state bounded regardless of how many headers a session logs', () => {
    seq = 0
    let state = modelSelectionInit()
    for (let i = 0; i < 500; i++) {
      state = modelSelectionApply(state, header({ provider: 'p', model: `m${i}`, reasoningEffort: 'high' }) as never)
    }
    // Only the latest selection is retained: a long session must not grow.
    expect(JSON.stringify(state).length).toBeLessThan(300)
    expect(modelSelectionView(state)?.model).toBe('m499')
  })
})

describe('projected model selection · differential fuzz vs the reference', () => {
  /** Deterministic PRNG so any failure is reproducible from the seed. */
  function rng(seed: number): () => number {
    let s = seed >>> 0
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000 }
  }

  it('agrees with latestModelSelection over randomized logs', () => {
    const rand = rng(40900409)
    // Config shapes that exercise every branch of readRequestHeaderSelection.
    const configs: unknown[] = [
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2', reasoningEffort: 'high' },
      { provider: 'p3', model: 'm3', reasoningEffort: 42 },
      { provider: 'p4' },
      { model: 'm5' },
      {},
      null,
      'not-an-object',
      7,
    ]
    const dataShapes: unknown[] = [
      ...configs.map(config => ({ header: { config }, reason: 'change' })),
      { header: {} },
      { header: { config: undefined } },
      {},
      undefined,
      'nope',
    ]
    let mismatches = 0
    let firstCase = ''

    for (let trial = 0; trial < 2000; trial++) {
      const events: Ev[] = []
      const count = 1 + Math.floor(rand() * 6)
      for (let i = 0; i < count; i++) {
        const roll = rand()
        if (roll < 0.7) {
          events.push({ seq: events.length, time: 0, type: 'request/header', data: dataShapes[Math.floor(rand() * dataShapes.length)] })
        } else {
          events.push({ seq: events.length, time: 0, type: 'tool/call', data: { callId: 'c', name: 'Bash' } })
        }
      }
      let state = modelSelectionInit()
      for (const event of events) state = modelSelectionApply(state, event as never)
      const batch = latestModelSelection(events)
      const incremental = modelSelectionView(state)
      if (JSON.stringify(batch) !== JSON.stringify(incremental)) {
        mismatches++
        if (firstCase === '') {
          firstCase = JSON.stringify({ events, batch, incremental })
        }
      }
    }

    expect(mismatches, `first mismatch: ${firstCase}`).toBe(0)
  })
})

describe('projected model selection · checkpoint round-trip', () => {
  it('a parsed state re-applies the reasoningEffort brand', () => {
    seq = 0
    let state = modelSelectionInit()
    for (const event of [header({ provider: 'p', model: 'm', reasoningEffort: 'high' })]) {
      state = modelSelectionApply(state, event as never)
    }
    // The registry re-seeds restored rows through stateSchema.parse, so the
    // round-trip must reproduce an equal selection, brand included.
    const restored = modelSelectionProjectionDefinition.stateSchema.parse(
      JSON.parse(JSON.stringify(state)),
    )
    expect(restored).toEqual(state)
    expect(restored.selection?.reasoningEffort).toBe('high')
  })
})
