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
import {
  foldFeishuTaskResults,
  reduceFeishuTask,
  reduceTaskCard,
} from '../src/bridge/task-card.ts'

type Ev = { seq: number; time: number; type: string; data: unknown }

let seq = 0
const ev = (type: string, data: unknown, time = 1000 + seq): Ev =>
  ({ seq: ++seq, time, type, data })

const turnStart = (turn = 1): Ev => ev('turn/start', { turn })
const stepStart = (turn = 1, step = 1): Ev => ev('step/start', { turn, step })
const toolCall = (callId: string, name: string, turn = 1, step = 1): Ev =>
  ev('tool/call', { turn, step, callId, name, arguments: '{"secret":"never-shown"}' })
/** Same event with caller-chosen arguments; `seq` is assigned on this call. */
const toolCallWithArgs = (callId: string, name: string, args: string, turn = 1, step = 1): Ev =>
  ev('tool/call', { turn, step, callId, name, arguments: args })
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

  it('carries a human detail from the arguments of an open tool call', () => {
    // The card must say WHAT a call is doing. Reading one whitelisted key is
    // how it knows; every other key stays unread (see the leak test below).
    // `ev` assigns `seq` in call order, so build the events in order.
    seq = 0
    const events = [turnStart(), stepStart(), toolCallWithArgs('c1', 'bash', '{"command":"pnpm test"}')]
    const snap = reduceTaskCard(events, 1)!
    expect(snap.currentTools).toEqual(['bash'])
    expect(snap.toolDetails).toEqual({ bash: 'pnpm test' })
  })

  it('keeps the detail with the call after it completes', () => {
    seq = 0
    const events = [
      turnStart(), stepStart(),
      toolCallWithArgs('c1', 'read', '{"file_path":"src/bridge/index.ts"}'),
      toolResult('c1'),
    ]
    const snap = reduceTaskCard(events, 1)!
    expect(snap.currentTools).toEqual([])
    expect(snap.recentToolDetails).toEqual({ read: 'src/bridge/index.ts' })
  })

  it('keeps each completed call of the SAME tool name with its own detail', () => {
    // Two `bash` calls used to collapse: the snapshot was a name-keyed record,
    // so the second call's detail overwrote the first and the card showed the
    // same line twice. Calling one tool several times in a task is the norm.
    seq = 0
    const events = [
      turnStart(), stepStart(),
      toolCallWithArgs('c1', 'bash', '{"command":"ls -la"}'),
      toolResult('c1'),
      toolCallWithArgs('c2', 'bash', '{"command":"pnpm test"}'),
      toolResult('c2'),
    ]
    const snap = reduceTaskCard(events, 1)!
    expect(snap.recentToolDetailsList).toEqual([
      { name: 'bash', detail: 'ls -la' },
      { name: 'bash', detail: 'pnpm test' },
    ])
  })

  it('keeps each OPEN call of the same tool name with its own detail', () => {
    seq = 0
    const events = [
      turnStart(), stepStart(),
      toolCallWithArgs('c1', 'bash', '{"command":"ls -la"}'),
      toolCallWithArgs('c2', 'bash', '{"command":"pnpm test"}'),
    ]
    const snap = reduceTaskCard(events, 1)!
    expect(snap.currentToolsList).toEqual([
      { name: 'bash', detail: 'ls -la' },
      { name: 'bash', detail: 'pnpm test' },
    ])
  })

  it('never reads an unrecognized argument key, even when it holds text', () => {
    // The whitelist is the privacy boundary: a tool passing a credential in an
    // unusual field must not get it rendered onto a chat card.
    seq = 0
    const events = [turnStart(), stepStart(), toolCallWithArgs('c1', 'login', '{"apiKey":"sk-do-not-render"}')]
    const snap = reduceTaskCard(events, 1)!
    expect(JSON.stringify(snap)).not.toContain('sk-do-not-render')
    expect(snap.toolDetails).toEqual({})
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

  it('keeps only the stable failure code and retry count for a failed card', () => {
    seq = 0
    const snap = reduceTaskCard([
      turnStart(),
      llmRetry('EMPTY_RESPONSE'),
      llmRetry('EMPTY_RESPONSE'),
      turnEnd({
        kind: 'error',
        error: { code: 'EMPTY_RESPONSE', message: 'provider response contained sensitive diagnostic text' },
      }),
    ], 1)!

    expect(snap.failureCode).toBe('EMPTY_RESPONSE')
    expect(snap.retryCount).toBe(2)
    expect(JSON.stringify(snap)).not.toContain('sensitive diagnostic text')
  })

  it('events after the terminal turn/end do not mutate the frozen card', () => {
    seq = 0
    const terminal = [turnStart(), turnEnd({ kind: 'completed' })]
    const frozen = reduceTaskCard(terminal, 1)!
    const withLate = reduceTaskCard([...terminal, toolCall('late', 'Bash')], 1)!
    expect(withLate).toEqual(frozen)
  })

  it('rejects an older sequence that arrives after a newer event', () => {
    const events: Ev[] = [
      { seq: 10, time: 1000, type: 'turn/start', data: { turn: 1 } },
      { seq: 12, time: 1200, type: 'tool/call', data: { turn: 1, step: 1, callId: 'new', name: 'Read' } },
      { seq: 11, time: 1100, type: 'tool/call', data: { turn: 1, step: 1, callId: 'old', name: 'Bash' } },
    ]

    const snap = reduceTaskCard(events, 1)!
    expect(snap.currentTools).toEqual(['Read'])
    expect(snap.toolCallCount).toBe(1)
  })

  it('updates progress with the same call id in place instead of appending it', () => {
    const events: Ev[] = [
      { seq: 1, time: 1000, type: 'turn/start', data: { turn: 1 } },
      { seq: 2, time: 1100, type: 'tool/call', data: { turn: 1, step: 1, callId: 'same', name: 'Read' } },
      { seq: 3, time: 1200, type: 'tool/call', data: { turn: 1, step: 1, callId: 'same', name: 'Read（重试）' } },
    ]

    const snap = reduceTaskCard(events, 1)!
    expect(snap.currentTools).toEqual(['Read（重试）'])
    expect(snap.toolCallCount).toBe(1)
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

  it('completed tools accumulate in recentTools, capped at the last 5', () => {
    seq = 0
    const events = [turnStart(), stepStart()]
    for (let i = 1; i <= 7; i++) {
      events.push(toolCall(`c${i}`, `Tool${i}`))
      events.push(toolResult(`c${i}`))
    }
    const snap = reduceTaskCard(events, 1)!
    expect(snap.recentTools).toEqual(['Tool3', 'Tool4', 'Tool5', 'Tool6', 'Tool7'])
    expect(snap.toolCallCount).toBe(7)
  })

  it('snapshots are deterministic: same input → deep-equal output', () => {
    seq = 0
    const events = [turnStart(), stepStart(), toolCall('c1', 'Bash')]
    const a = reduceTaskCard(events, 1)
    const b = reduceTaskCard(events, 1)
    expect(a).toEqual(b)
  })
})

describe('Feishu task fold', () => {
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

  it('waits for every started child and returns only the final completed text', () => {
    seq = 0
    const events = [
      turnStart(1), directUser('task-a'), assistantText(1, 'intermediate', true),
      ev('tool/code-dispatch', {
        name: 'subagent', isError: false,
        content: [{ type: 'text', text: 'started subagent child-a' }],
      }),
      turnEnd({ kind: 'error', error: { code: 'EMPTY_RESPONSE' } }, 1),
    ]
    const open = reduceFeishuTask(events, events[0]!.seq)!
    expect(open.settled).toBe(false)
    expect(open.snapshot.status).toBe('running')
    expect(open.result).toBeUndefined()

    events.push(
      turnStart(2),
      internalUser('subagent-settled', 'child-a'),
      assistantText(2, 'final answer'),
      turnEnd({ kind: 'completed' }, 2),
    )
    const settled = reduceFeishuTask(events, events[0]!.seq)!
    expect(settled.settled).toBe(true)
    expect(settled.snapshot.status).toBe('completed')
    expect(settled.result?.text).toBe('final answer')
    // The RESULT must not carry the intermediate text: that is what the model
    // and the transcript consume as this task's answer. `assistantNotes` is a
    // separate card-facing field that deliberately keeps what the agent said,
    // so the assertion is scoped to the result rather than the whole state.
    expect(settled.result?.text).not.toContain('intermediate')
  })

  it('keeps what the agent SAID, including messages that also call tools', () => {
    // Reported: the card showed only file reads and commands, so the operator
    // could not tell what any of it was for. The sentence explaining the work
    // rides on the same message that calls the tool, which is exactly the
    // message the final-result reader ignores.
    seq = 0
    const events = [
      turnStart(1),
      directUser('task-a'),
      ev('assistant/message', {
        turn: 1,
        message: { content: [
          { type: 'text', text: '先看登录相关代码。' },
          { type: 'tool-call', toolCallId: 'c1', name: 'grep' },
        ] },
      }),
      ev('tool/call', { turn: 1, callId: 'c1', name: 'grep', arguments: JSON.stringify({ pattern: 'login' }) }),
      ev('assistant/message', {
        turn: 1,
        message: { content: [{ type: 'text', text: '找到问题了。' }] },
      }),
    ]

    const fold = reduceFeishuTask(events, events[0]!.seq)!
    expect(fold.snapshot.assistantNotes).toEqual(['先看登录相关代码。', '找到问题了。'])
  })

  it('keeps the task and its progress when a follow-up arrives inside the turn', () => {
    // Reported: sending a follow-up while a task ran made the newest card start
    // blank, so the operator had to scroll back to see what had been done.
    //
    // DSH steers such a message into the OPEN turn: it is supplementary input
    // for the same task, not a new one. The task must therefore survive, with
    // only the display moving to the newest message.
    seq = 0
    const events = [
      turnStart(1),
      directUser('task-a'),
      assistantText(1, 'work so far'),
      // No turn/end: the operator replied while the task was still running.
      directUser('follow-up'),
    ]

    const fold = reduceFeishuTask(events, events[0]!.seq)!
    // The display moves to the newest message...
    expect(fold.taskMessageId).toBe('follow-up')
    // ...but the task boundary, and therefore the progress, does NOT restart.
    expect(fold.taskStartSeq).toBe(events[1]!.seq)
  })

  it('opens a second direct Feishu message as a distinct task boundary', () => {
    seq = 0
    const events = [
      turnStart(1), directUser('task-a'), assistantText(1, 'first answer'),
      turnEnd({ kind: 'completed' }, 1),
      turnStart(2), directUser('task-b'), assistantText(2, 'second answer'),
      turnEnd({ kind: 'completed' }, 2),
    ]

    const folded = foldFeishuTaskResults(events, events[0]!.seq)
    expect(folded.results.map(result => result.text)).toEqual(['first answer', 'second answer'])
    expect(new Set(folded.results.map(result => result.taskStartSeq)).size).toBe(2)
    expect(folded.results[0]!.sourceEventSeq).toBe(events[3]!.seq)
    expect(folded.cursorThrough).toBe(events.at(-1)!.seq)
  })

  it('projects a Web task while its session is bound to Feishu', () => {
    seq = 0
    const events = [
      turnStart(1),
      ev('user/message', { id: 'web', source: { kind: 'user', via: 'web' } }),
      assistantText(1, 'web-only answer'),
      turnEnd({ kind: 'completed' }, 1),
    ]
    const folded = foldFeishuTaskResults(events, events[0]!.seq)
    expect(folded.results.map(result => result.text)).toEqual(['web-only answer'])
    expect(folded.cursorThrough).toBe(events.at(-1)!.seq)
  })
})
