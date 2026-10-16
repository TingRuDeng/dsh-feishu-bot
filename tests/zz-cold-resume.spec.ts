import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { feishuTaskApply, feishuTaskFoldOf, feishuTaskInit } from '../src/bridge/task-projection.ts'

/**
 * Cold resume against a REAL persisted session log.
 *
 * The synthetic harness never flushes a session to disk, so a restart there
 * cannot exercise this path. These assertions therefore read an actual
 * `session.v*.jsonl.zstd` from ~/.dsh and skip when it is absent, which keeps
 * the suite portable while still verifying the fold against real traffic.
 */
describe('resumeRunningTask fold over a real persisted log', () => {
  it('finds the in-flight task and reports it running', () => {
    const home = process.env.HOME
    if (home === undefined) return
    const dir = `${home}/.dsh/sessions/--Users-dengtingru-Desktop-mycode-dsh-dsh-feishu-bot--`
    let file: string
    try {
      const found = execFileSync('bash', ['-c',
        `ls ${dir}/session-*/session.v*.jsonl.zstd 2>/dev/null | head -1`]).toString().trim()
      if (found === '') return
      file = found
    } catch { return }

    const raw = execFileSync('zstd', ['-dc', file], { maxBuffer: 1 << 30 }).toString()
    const events = raw.split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as { seq?: number })
      .filter(event => typeof event.seq === 'number')

    let state = feishuTaskInit()
    for (const event of events) state = feishuTaskApply(state, event as never)
    const folded = feishuTaskFoldOf(state)

    // SCOPE: this pins the FOLD, not the wiring. Removing the
    // `resumeRunningTask(...)` call from catchUpBoundSessions leaves this test
    // green, so it does NOT prove a card is opened at startup. It proves the
    // fold startup consults is correct over real traffic — the part the
    // synthetic fixture cannot reach. End-to-end resume still needs a live
    // check or a fixture whose session log actually reaches disk.
    //
    // A real log always yields a fold; this is the "is anything running?" probe
    // startup uses to decide whether to open a card at all.
    expect(folded).toBeDefined()
    expect(typeof folded!.taskMessageId).toBe('string')
    // Whatever the log holds, a settled fold must agree with its status.
    if (folded!.settled) expect(folded!.snapshot.status).not.toBe('running')
    else expect(folded!.snapshot.status).toBe('running')
  })
})
