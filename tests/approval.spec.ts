/**
 * Approval pairing scan (design §6.4): find THIS request's approvalId in the
 * session log — the newest `approval/asked` that is undecided, unclaimed,
 * and callId-symmetric (a callId-bearing ask only pairs its own call's
 * record; a callId-less ask only pairs a callId-less record). Ambiguity or
 * absence yields undefined (the caller delegates via next()).
 * Mirrors the upstream apiproxy scan; verified against its source.
 */
import { describe, expect, it } from 'vitest'
import { pairApprovalId, renderApprovalCard, renderApprovalCardFrozen } from '../src/bridge/approval.ts'

type Ev = { seq: number; time: number; type: string; data: unknown }
let seq = 0
const asked = (id: string, callId?: string): Ev =>
  ({ seq: ++seq, time: 0, type: 'approval/asked', data: { id, toolName: 'Bash', ...callId === undefined ? {} : { callId } } })
const decided = (id: string): Ev =>
  ({ seq: ++seq, time: 0, type: 'approval/decided', data: { id, outcome: 'allowed-once' } })

describe('renderApprovalCard', () => {
  const spec = {
    pendingId: 'pc_1',
    toolName: 'Bash',
    reason: '需要执行 rm -rf 之外的一条命令',
    sessionTitle: '重构任务',
    webUrl: 'http://127.0.0.1:3080',
  }

  it('carries tool name, reason, title, web link, and two action buttons', () => {
    const json = JSON.stringify(renderApprovalCard(spec))
    expect(json).toContain('Bash')
    expect(json).toContain('需要执行')
    expect(json).toContain('重构任务')
    expect(json).toContain('http://127.0.0.1:3080')
    expect(json).toContain('"allow"')
    expect(json).toContain('"reject"')
    expect(json).toContain('pc_1')
  })

  it('truncates the reason at 500 bytes (UTF-8 safe)', () => {
    const long = '长'.repeat(400) // 1200 UTF-8 bytes
    const json = JSON.stringify(renderApprovalCard({ ...spec, reason: long }))
    const rendered = /长+/u.exec(json)![0]
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(500)
    expect(json).toContain('…')
  })

  it('frozen variants render terminal copy without buttons', () => {
    for (const [state, copy] of [
      ['decided-allow', '已允许'], ['decided-reject', '已拒绝'],
      ['elsewhere', '已在别处决定'], ['withdrawn', '已撤回'], ['invalidated', '已失效'],
    ] as const) {
      const json = JSON.stringify(renderApprovalCardFrozen(spec, state))
      expect(json).toContain(copy)
      expect(json).not.toContain('"allow"')
      expect(json).not.toContain('"reject"')
    }
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
