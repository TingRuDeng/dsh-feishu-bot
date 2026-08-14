/**
 * Task-card rendering: snapshot → Feishu interactive-card JSON. Pure and
 * deterministic; the waiting placeholder, status colors, and completion
 * copy follow docs/weclaw-lessons.md (2026-08-07 single waiting hint,
 * 2026-07-07 no duplicate completion text, 2026-07-31 stopped ≠ failed).
 */
import { describe, expect, it } from 'vitest'
import { renderTaskCard } from '../src/bridge/task-card.ts'

const base = { turn: 1, toolCallCount: 0, durationMs: null, startedAt: 1000 }

describe('renderTaskCard', () => {
  it('running with no tools shows the single waiting hint', () => {
    const card = renderTaskCard({ ...base, status: 'running', currentTools: [] })
    const json = JSON.stringify(card)
    expect(json).toContain('思考中')
    // Single hint: exactly one occurrence.
    expect(json.split('思考中').length - 1).toBe(1)
  })

  it('running with tools lists current tool names and drops the waiting hint', () => {
    const card = renderTaskCard({ ...base, status: 'running', currentTools: ['Bash', 'Read'], toolCallCount: 3 })
    const json = JSON.stringify(card)
    expect(json).toContain('Bash')
    expect(json).toContain('Read')
    expect(json).not.toContain('思考中')
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

  it('deterministic: same snapshot → identical JSON', () => {
    const snap = { ...base, status: 'running' as const, currentTools: ['Bash'] }
    expect(JSON.stringify(renderTaskCard(snap))).toBe(JSON.stringify(renderTaskCard(snap)))
  })
})
