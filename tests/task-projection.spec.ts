/**
 * Equivalence contract for the projected Feishu task fold.
 *
 * `reduceFeishuTask(events, fromSeq)` is the batch reference: it scans a range
 * and discovers the task boundary itself. The projection unit must maintain
 * the same state incrementally, one committed event at a time. These tests
 * hold the two implementations against each other field-for-field, which is
 * the only defence against a silent semantic drift that a card-update symptom
 * would not reliably surface.
 *
 * Written before the projection exists: `stepFeishuTask` is expected to be
 * absent, so this file fails until the implementation lands.
 */
import { describe, expect, it } from 'vitest'
import {
  feishuTaskFoldFromState,
  initFeishuTaskFoldState,
  reduceFeishuTask,
  type FeishuTaskFold,
} from '../src/bridge/task-card.ts'
import {
  feishuTaskInit,
  feishuTaskApply,
  type FeishuTaskState,
} from '../src/bridge/task-projection.ts'

type Ev = { seq: number; time: number; type: string; data: unknown }

let seq = 0
const ev = (type: string, data: unknown, time = 1000 + seq): Ev =>
  ({ seq: ++seq, time, type, data })

const turnStart = (turn = 1): Ev => ev('turn/start', { turn })
const toolCall = (callId: string, name: string, turn = 1, step = 1): Ev =>
  ev('tool/call', { turn, step, callId, name, arguments: '{"secret":"never-shown"}' })
const toolResult = (callId: string, turn = 1, step = 1): Ev =>
  ev('tool/result', {
    turn, step,
    message: {
      role: 'user', id: 'm', source: { kind: 'tool' },
      content: [{ type: 'tool-result', toolCallId: callId, content: [] }],
    },
  })
const llmRetry = (code: string, turn = 1, step = 1): Ev =>
  ev('llm/retry', {
    turn, step, retry: 1, maxRetries: 2,
    failure: { code, message: 'provider response contained sensitive diagnostic text' },
  })
const turnEnd = (reason: unknown, turn = 1): Ev => ev('turn/end', { turn, reason })
const directUser = (id: string): Ev => ev('user/message', {
  id,
  source: { kind: 'user', via: 'feishu' },
  content: [{ type: 'text', text: 'private input' }],
})
const internalUser = (kind: string, senderSessionId: string): Ev => ev('user/message', {
  id: `${kind}-${senderSessionId}`,
  source: { kind, senderSessionId },
  content: [{ type: 'text', text: 'internal input' }],
})
const assistantText = (turn: number, text: string, withToolCall = false): Ev =>
  ev('assistant/message', {
    turn,
    message: {
      content: [
        { type: 'text', text },
        ...(withToolCall ? [{ type: 'tool-call', id: 'c', name: 'run', arguments: '{}' }] : []),
      ],
    },
  })

/** Fold `events` through the projection one event at a time. */
function stepFold(events: readonly Ev[]): FeishuTaskFold | undefined {
  let state: FeishuTaskState = feishuTaskInit()
  for (const event of events) state = feishuTaskApply(state, event as never)
  return feishuTaskFoldFromState(state.task ?? initFeishuTaskFoldState(0))
}

/** Compare every observable field of the two folds. */
function expectSameFold(
  incremental: FeishuTaskFold | undefined,
  batch: FeishuTaskFold | undefined,
): void {
  if (batch === undefined) {
    expect(incremental).toBeUndefined()
    return
  }
  expect(incremental).toBeDefined()
  const left = incremental!
  expect(left.taskMessageId).toBe(batch.taskMessageId)
  expect(left.taskStartSeq).toBe(batch.taskStartSeq)
  expect(left.scannedThrough).toBe(batch.scannedThrough)
  expect(left.settled).toBe(batch.settled)
  expect(left.result).toEqual(batch.result)
  expect(left.snapshot).toEqual(batch.snapshot)
}

describe('projected Feishu task fold · equivalence with the batch reference', () => {
  it('no direct user message yet → both undefined', () => {
    seq = 0
    const events = [turnStart(1), toolCall('c1', 'Bash')]
    expectSameFold(
      stepFold(events),
      reduceFeishuTask(events, events[0]!.seq),
    )
  })

  it('open task: tools, retry and unresolved calls agree', () => {
    seq = 0
    const events = [
      turnStart(1), directUser('task-a'),
      toolCall('c1', 'Bash'), toolCall('c2', 'Read'),
      toolResult('c1'),
      llmRetry('EMPTY_RESPONSE'),
    ]
    expectSameFold(
      stepFold(events),
      reduceFeishuTask(events, events[0]!.seq),
    )
  })

  it('settled task with a final answer agrees', () => {
    seq = 0
    const events = [
      turnStart(1), directUser('task-a'),
      assistantText(1, 'intermediate', true),
      turnEnd({ kind: 'completed' }, 1),
    ]
    expectSameFold(
      stepFold(events),
      reduceFeishuTask(events, events[0]!.seq),
    )
  })

  it('waits for every started child before settling', () => {
    seq = 0
    const events = [
      turnStart(1), directUser('task-a'), assistantText(1, 'intermediate', true),
      ev('tool/code-dispatch', {
        name: 'subagent', isError: false,
        content: [{ type: 'text', text: 'started subagent child-a' }],
      }),
      turnEnd({ kind: 'error', error: { code: 'EMPTY_RESPONSE' } }, 1),
    ]
    expectSameFold(
      stepFold(events),
      reduceFeishuTask(events, events[0]!.seq),
    )
    events.push(
      turnStart(2),
      internalUser('subagent-settled', 'child-a'),
      assistantText(2, 'final answer'),
      turnEnd({ kind: 'completed' }, 2),
    )
    expectSameFold(
      stepFold(events),
      reduceFeishuTask(events, events[0]!.seq),
    )
  })

  it('a second direct message rolls the boundary to the newer task', () => {
    seq = 0
    const events = [
      turnStart(1), directUser('task-a'), assistantText(1, 'first answer'),
      turnEnd({ kind: 'completed' }, 1),
      turnStart(2), directUser('task-b'), assistantText(2, 'second answer'),
      turnEnd({ kind: 'completed' }, 2),
    ]
    // The projection tracks the session's current task, so it must match the
    // batch fold anchored at the SECOND direct input. The batch reference
    // invoked from events[0] deliberately stops at the boundary and describes
    // task-a instead: that difference is the documented one-card-per-task
    // contract, asserted separately below.
    const secondStart = events[4]!.seq
    expectSameFold(stepFold(events), reduceFeishuTask(events, secondStart))
    expect(stepFold(events)!.taskMessageId).toBe('task-b')
    expect(reduceFeishuTask(events, events[0]!.seq)!.taskMessageId).toBe('task-a')
  })

  it('a stopped turn maps to the stopped snapshot on both sides', () => {
    seq = 0
    const events = [
      turnStart(1), directUser('task-a'), toolCall('c1', 'Bash'),
      turnEnd({ kind: 'aborted' }, 1),
    ]
    expectSameFold(
      stepFold(events),
      reduceFeishuTask(events, events[0]!.seq),
    )
  })

  it('re-derives the same state when replayed from the start (resume path)', () => {
    seq = 0
    const events = [
      turnStart(1), directUser('task-a'), toolCall('c1', 'Bash'), toolResult('c1'),
      assistantText(1, 'answer', true), turnEnd({ kind: 'completed' }, 1),
    ]
    const once = stepFold(events)
    const twice = stepFold(events)
    expect(once).toEqual(twice)
  })
})

describe('projected Feishu task fold · projection contract', () => {
  it('returns the same state reference for unrelated events', () => {
    seq = 0
    const state = feishuTaskInit()
    const unrelated = ev('session/title', { title: 'unrelated' })
    expect(feishuTaskApply(state, unrelated as never)).toBe(state)
  })

  it('keeps state JSON-serializable so it can be checkpointed', () => {
    seq = 0
    const events = [
      turnStart(1), directUser('task-a'),
      toolCall('c1', 'Bash'), toolCall('c2', 'Read'), toolResult('c1'),
      ev('tool/code-dispatch', {
        name: 'subagent', isError: false,
        content: [{ type: 'text', text: 'started subagent child-a' }],
      }),
      llmRetry('EMPTY_RESPONSE'),
    ]
    let state = feishuTaskInit()
    for (const event of events) state = feishuTaskApply(state, event as never)
    expect(() => structuredClone(state)).not.toThrow()
  })
})
