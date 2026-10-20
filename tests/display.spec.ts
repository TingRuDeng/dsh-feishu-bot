import { describe, expect, it } from 'vitest'
import {
  formatSessionDisplayTitle,
  normalizeProgressDetail,
  sessionChoiceTitle,
} from '../src/bridge/display.ts'

describe('Feishu display policy', () => {
  it('prefixes session titles with workspace and avoids duplicate prefixes', () => {
    expect(formatSessionDisplayTitle('ds-pro开发', 'dsh-feishu-bot')).toBe('【dsh-feishu-bot】ds-pro开发')
    expect(formatSessionDisplayTitle('【dsh-feishu-bot】ds-pro开发', 'dsh-feishu-bot'))
      .toBe('【dsh-feishu-bot】ds-pro开发')
  })

  it('omits the workspace from a session button inside that workspace', () => {
    // The card is already titled with the workspace, so repeating it on every
    // row only pushes the session name — the thing being chosen — out of view.
    expect(sessionChoiceTitle('修复登录', 'dsh-feishu-bot', 'dsh-feishu-bot')).toBe('修复登录')
  })

  it('keeps the workspace prefix when the list spans several workspaces', () => {
    // Outside a single-workspace page the prefix is what tells two identically
    // named sessions apart.
    expect(sessionChoiceTitle('修复登录', 'dsh-feishu-bot', undefined)).toBe('【dsh-feishu-bot】修复登录')
    expect(sessionChoiceTitle('修复登录', 'dsh-feishu-bot', 'other-repo'))
      .toBe('【dsh-feishu-bot】修复登录')
  })

  it('strips a prefix the choice ALREADY carries, which is how the real pipeline passes it', () => {
    // The bridge stores each `/ls` choice already prefixed by
    // `formatSessionDisplayTitle`, so the list card hands this function a
    // title that starts with 【workspace】. Testing only clean titles made the
    // first version of this helper look correct while the shipped card still
    // repeated the workspace on every row.
    const stored = formatSessionDisplayTitle('修复登录', 'dsh-feishu-bot')
    expect(stored).toBe('【dsh-feishu-bot】修复登录')
    expect(sessionChoiceTitle(stored, 'dsh-feishu-bot', 'dsh-feishu-bot')).toBe('修复登录')
    // A stale prefix from a different workspace is not this page's to strip.
    expect(sessionChoiceTitle('【other-repo】修复登录', 'dsh-feishu-bot', 'dsh-feishu-bot'))
      .toBe('【other-repo】修复登录')
  })

  it('normalizes configurable progress detail tiers with summary as default', () => {
    expect(normalizeProgressDetail(undefined)).toBe('summary')
    expect(normalizeProgressDetail('concise')).toBe('concise')
    expect(normalizeProgressDetail('summary')).toBe('summary')
    expect(normalizeProgressDetail('full')).toBe('full')
    expect(normalizeProgressDetail('verbose')).toBe('summary')
  })
})
