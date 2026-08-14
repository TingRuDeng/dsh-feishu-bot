/**
 * Task-card reducer (design §6.3): a pure fold from session events to one
 * turn's card snapshot. Rendering consumes snapshots; it never appends.
 *
 * Contracts under test (weclaw-informed, docs/weclaw-lessons.md):
 * - snapshot, not increments: same events → same snapshot, replayable;
 * - waiting state until the first tool call: status 'running', no tool rows;
 * - current tool = called but no result yet; results retire the row;
 * - terminal states are three-valued: completed | stopped | failed —
 *   a user cancel is 'stopped', never 'failed' (weclaw 2026-07-31);
 * - tool arguments never enter the snapshot (audit discipline);
 * - events after the terminal turn/end are ignored (frozen card).
 */
import { describe, expect, it } from 'vitest'
import { reduceTaskCard, type TaskCardSnapshot } from '../src/bridge/task-card.ts'

type Ev = { seq: number; time: number; type: string; data: unknown }

let seq = 0
const ev = (type: string, data: unknown, time = 1000 + seq): Ev =>
  ({ seq: ++seq, time, type, data })

const turnStart = (turn = 1): Ev => ev('turn/start', { turn })
const stepStart = (turn = 1, step = 1): Ev => ev('step/start', { turn, step })
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
const turnEnd = (reason: unknown, turn = 1): Ev => ev('turn/end', { turn, reason })

describe('reduceTaskCard', () => {
  it('no events for the turn → undefined (no card to show)', () => {
    seq = 0
    expect(reduceTaskCard([], 1)).toBeUndefined()
  })

  it('turn started, no tool yet → running with zero tools (waiting state)', () => {
    seq = 0
    const snap = reduceTaskCard([turnStart(), stepStart()], 1)!
    expect(snap.status).toBe('running')
    expect(snap.currentTools).toEqual([])
    expect(snap.toolCallCount).toBe(0)
  })

  it('called-but-unresolved tools are current; results retire them in order', () => {
    seq = 0
    const events = [
      turnStart(), stepStart(),
      toolCall('c1', 'Bash'), toolCall('c2', 'Read'),
    ]
    let snap = reduceTaskCard(events, 1)!
    expect(snap.currentTools).toEqual(['Bash', 'Read'])
    expect(snap.toolCallCount).toBe(2)

    // Pairing is exact: tool/result carries the callId inside its
    // ToolResultBlock (message.content[0].toolCallId).
    snap = reduceTaskCard([...events, toolResult('c1')], 1)!
    expect(snap.currentTools).toEqual(['Read'])
    // Out-of-order result: retiring c2 first leaves only c1 current.
    snap = reduceTaskCard([...events, toolResult('c2')], 1)!
    expect(snap.currentTools).toEqual(['Bash'])
    expect(snap.toolCallCount).toBe(2)
  })

  it('tool arguments never appear anywhere in the snapshot', () => {
    seq = 0
    const snap = reduceTaskCard([turnStart(), stepStart(), toolCall('c1', 'Bash')], 1)!
    expect(JSON.stringify(snap)).not.toContain('never-shown')
  })

  it('completed turn → completed status with duration from turn boundaries', () => {
    seq = 0
    const events = [
      { seq: 1, time: 1000, type: 'turn/start', data: { turn: 1 } },
      { seq: 2, time: 1100, type: 'step/start', data: { turn: 1, step: 1 } },
      { seq: 3, time: 9000, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const snap = reduceTaskCard(events, 1)!
    expect(snap.status).toBe('completed')
    expect(snap.durationMs).toBe(8000)
  })

  it('user-cancel abort is stopped, not failed (weclaw 2026-07-31)', () => {
    seq = 0
    const snap = reduceTaskCard(
      [turnStart(), turnEnd({ kind: 'aborted', reason: { kind: 'user' } })], 1)!
    expect(snap.status).toBe('stopped')
  })

  it('error reason is failed; unknown reason kinds degrade to failed', () => {
    seq = 0
    let snap = reduceTaskCard(
      [turnStart(), turnEnd({ kind: 'error', error: { message: 'x', code: 'UNKNOWN' } })], 1)!
    expect(snap.status).toBe('failed')
    seq = 0
    snap = reduceTaskCard([turnStart(), turnEnd({ kind: 'some-future-kind' })], 1)!
    expect(snap.status).toBe('failed')
  })

  it('events after the terminal turn/end do not mutate the frozen card', () => {
    seq = 0
    const terminal = [turnStart(), turnEnd({ kind: 'completed' })]
    const frozen = reduceTaskCard(terminal, 1)!
    const withLate = reduceTaskCard([...terminal, toolCall('late', 'Bash')], 1)!
    expect(withLate).toEqual(frozen)
  })

  it('only the requested turn folds; other turns are invisible', () => {
    seq = 0
    const events = [
      turnStart(1), turnEnd({ kind: 'completed' }, 1),
      turnStart(2), stepStart(2), toolCall('c9', 'Write', 2),
    ]
    const one = reduceTaskCard(events, 1)!
    const two = reduceTaskCard(events, 2)!
    expect(one.status).toBe('completed')
    expect(two.status).toBe('running')
    expect(two.currentTools).toEqual(['Write'])
  })

  it('snapshots are deterministic: same input → deep-equal output', () => {
    seq = 0
    const events = [turnStart(), stepStart(), toolCall('c1', 'Bash')]
    const a = reduceTaskCard(events, 1)
    const b = reduceTaskCard(events, 1)
    expect(a).toEqual(b)
  })
})
