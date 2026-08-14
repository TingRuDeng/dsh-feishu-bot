/**
 * Approval pairing scan (design §6.4): find THIS request's approvalId in the
 * session log — the newest `approval/asked` that is undecided, unclaimed,
 * and callId-symmetric (a callId-bearing ask only pairs its own call's
 * record; a callId-less ask only pairs a callId-less record). Ambiguity or
 * absence yields undefined (the caller delegates via next()).
 * Mirrors the upstream apiproxy scan; verified against its source.
 */
import { describe, expect, it } from 'vitest'
import { pairApprovalId, renderApprovalGroupCard } from '../src/bridge/approval.ts'

type Ev = { seq: number; time: number; type: string; data: unknown }
let seq = 0
const asked = (id: string, callId?: string): Ev =>
  ({ seq: ++seq, time: 0, type: 'approval/asked', data: { id, toolName: 'Bash', ...callId === undefined ? {} : { callId } } })
const decided = (id: string): Ev =>
  ({ seq: ++seq, time: 0, type: 'approval/decided', data: { id, outcome: 'allowed-once' } })

describe('renderApprovalGroupCard', () => {
  const spec = (id: string, tool = 'Bash') => ({
    pendingId: id,
    toolName: tool,
    reason: '需要执行一条命令',
    sessionTitle: '重构任务',
    webUrl: 'http://127.0.0.1:3080',
  })

  it('a single pending item carries facts, web link, and two action buttons', () => {
    const json = JSON.stringify(renderApprovalGroupCard([{ spec: spec('pc_1'), state: 'pending' }]))
    expect(json).toContain('Bash')
    expect(json).toContain('需要执行')
    expect(json).toContain('http://127.0.0.1:3080')
    expect(json).toContain('"allow"')
    expect(json).toContain('"reject"')
    expect(json).toContain('pc_1')
  })

  it('multiple pending items collapse into one card, each with its own buttons', () => {
    const json = JSON.stringify(renderApprovalGroupCard([
      { spec: spec('pc_1', 'Bash'), state: 'pending' },
      { spec: spec('pc_2', 'Write'), state: 'pending' },
    ]))
    expect(json).toContain('pc_1')
    expect(json).toContain('pc_2')
    expect(json).toContain('Bash')
    expect(json).toContain('Write')
    expect((json.match(/"allow"/g) ?? []).length).toBe(2)
  })

  it('settled items show their outcome inline and keep no buttons', () => {
    const json = JSON.stringify(renderApprovalGroupCard([
      { spec: spec('pc_1', 'Bash'), state: 'allowed' },
      { spec: spec('pc_2', 'Write'), state: 'pending' },
    ]))
    expect(json).toContain('已允许')
    expect((json.match(/"allow"/g) ?? []).length).toBe(1)  // only pc_2's
  })

  it('all-settled card renders terminal header and zero buttons', () => {
    for (const [state, copy] of [
      ['allowed', '已允许'], ['rejected', '已拒绝'],
      ['elsewhere', '已在别处决定'], ['withdrawn', '已撤回'], ['invalidated', '已失效'],
    ] as const) {
      const json = JSON.stringify(renderApprovalGroupCard([{ spec: spec('pc_1'), state }]))
      expect(json).toContain(copy)
      expect(json).not.toContain('"allow"')
      expect(json).not.toContain('"reject"')
    }
  })

  it('truncates a reason at 500 bytes (UTF-8 safe)', () => {
    const long = '长'.repeat(400)
    const json = JSON.stringify(renderApprovalGroupCard([{ spec: { ...spec('pc_1'), reason: long }, state: 'pending' }]))
    const rendered = /长+/u.exec(json)![0]
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(500)
    expect(json).toContain('…')
  })
})

describe('pairApprovalId', () => {
  it('pairs the newest undecided asked with the same callId', () => {
    seq = 0
    const events = [asked('a1', 'c1'), decided('a1'), asked('a2', 'c2')]
    expect(pairApprovalId(events, 'c2', new Set())).toBe('a2')
  })

  it('a decided asked never pairs', () => {
    seq = 0
    expect(pairApprovalId([asked('a1', 'c1'), decided('a1')], 'c1', new Set())).toBeUndefined()
  })

  it('an id claimed by another pending entry never pairs', () => {
    seq = 0
    expect(pairApprovalId([asked('a1', 'c1')], 'c1', new Set(['a1']))).toBeUndefined()
  })

  it('callId symmetry: callId-bearing ask skips callId-less records and vice versa', () => {
    seq = 0
    const events = [asked('a1'), asked('a2', 'c2')]
    expect(pairApprovalId(events, undefined, new Set())).toBe('a1')
    expect(pairApprovalId(events, 'c2', new Set())).toBe('a2')
    expect(pairApprovalId(events, 'c3', new Set())).toBeUndefined()
  })

  it('parallel asks with distinct callIds pair without cross-stealing', () => {
    seq = 0
    const events = [asked('a1', 'c1'), asked('a2', 'c2')]
    expect(pairApprovalId(events, 'c1', new Set())).toBe('a1')
    expect(pairApprovalId(events, 'c2', new Set())).toBe('a2')
  })
})
