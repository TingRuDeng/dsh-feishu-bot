/**
 * Task-card rendering: snapshot → Feishu interactive-card JSON. Pure and
 * deterministic; the waiting placeholder, status colors, and completion
 * copy follow docs/weclaw-lessons.md (2026-08-07 single waiting hint,
 * 2026-07-07 no duplicate completion text, 2026-07-31 stopped ≠ failed).
 */
import { describe, expect, it } from 'vitest'
import { renderTaskCard } from '../src/bridge/task-card.ts'

const base = { turn: 1, toolCallCount: 0, durationMs: null, startedAt: 1000, recentTools: [] }

describe('renderTaskCard', () => {
  it('running with no tools shows the single waiting hint', () => {
    const card = renderTaskCard({ ...base, status: 'running', currentTools: [] })
    const json = JSON.stringify(card)
    expect(json).toContain('思考中')
    // Single hint: exactly one occurrence.
    expect(json.split('思考中').length - 1).toBe(1)
  })

  it('running with tools lists current tool names and appends one active thinking hint', () => {
    const card = renderTaskCard({ ...base, status: 'running', currentTools: ['Bash', 'Read'], toolCallCount: 3 })
    const json = JSON.stringify(card)
    expect(json).toContain('Bash')
    expect(json).toContain('Read')
    expect(json.split('思考中').length - 1).toBe(1)
    expect(card.elements[0]!.text.content.endsWith('思考中.....')).toBe(true)
  })

  it('completed card carries no duplicate completion body text', () => {
    const card = renderTaskCard({ ...base, status: 'completed', currentTools: [], toolCallCount: 2, durationMs: 65_000 })
    const json = JSON.stringify(card)
    expect(json).toContain('已完成')
    expect(json.split('已完成').length - 1).toBe(1)
    expect(json).toContain('1分5秒')
  })

  it('stopped renders as its own state, not failure', () => {
    const card = renderTaskCard({ ...base, status: 'stopped', currentTools: [] })
    const json = JSON.stringify(card)
    expect(json).toContain('已停止')
    expect(json).not.toContain('失败')
  })

  it('failed renders failure state', () => {
    expect(JSON.stringify(renderTaskCard({ ...base, status: 'failed', currentTools: [] }))).toContain('失败')
  })

  it('token line: usage-anchored measurements show the count, others show 未知 (design §6.3)', () => {
    const running = { ...base, status: 'running' as const, currentTools: ['Bash'], toolCallCount: 1 }
    let json = JSON.stringify(renderTaskCard(running, { totalTokens: 1234, anchored: true }))
    expect(json).toContain('1234')
    expect(json).toContain('token')
    // Estimated baseline: never show the number (no fake precision).
    json = JSON.stringify(renderTaskCard(running, { totalTokens: 999, anchored: false }))
    expect(json).not.toContain('999')
    expect(json).toContain('未知')
    // No measurement available at all: omit the line entirely.
    json = JSON.stringify(renderTaskCard(running))
    expect(json).not.toContain('token')
  })

  it('title uses the workspace name, never a round number (weclaw UX)', () => {
    const card = renderTaskCard({ ...base, status: 'running', currentTools: [] }, undefined, { title: 'dsh-feishu-bot' })
    const json = JSON.stringify(card)
    expect(json).toContain('dsh-feishu-bot')
    expect(json).not.toContain('第')
    expect(json).not.toContain('轮')
  })

  it('recent completed tools scroll in the body as progress (weclaw UX)', () => {
    const card = renderTaskCard({
      ...base, status: 'running', currentTools: ['Write'],
      recentTools: ['Bash', 'Read'], toolCallCount: 3,
    })
    const json = JSON.stringify(card)
    expect(json).toContain('✅ Bash')
    expect(json).toContain('✅ Read')
    expect(json).toContain('Write')
    expect(json.split('思考中').length - 1).toBe(1)
  })

  it('terminal cards uniformly strip the active thinking hint', () => {
    for (const status of ['completed', 'stopped', 'failed'] as const) {
      const card = renderTaskCard({ ...base, status, currentTools: [], toolCallCount: 1 })
      expect(JSON.stringify(card)).not.toContain('思考中')
    }
  })

  it('deterministic: same snapshot → identical JSON', () => {
    const snap = { ...base, status: 'running' as const, currentTools: ['Bash'] }
    expect(JSON.stringify(renderTaskCard(snap))).toBe(JSON.stringify(renderTaskCard(snap)))
  })
})
