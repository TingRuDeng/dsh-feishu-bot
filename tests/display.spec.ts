import { describe, expect, it } from 'vitest'
import { formatSessionDisplayTitle, normalizeProgressDetail } from '../src/bridge/display.ts'

describe('Feishu display policy', () => {
  it('prefixes session titles with workspace and avoids duplicate prefixes', () => {
    expect(formatSessionDisplayTitle('ds-pro开发', 'dsh-feishu-bot')).toBe('【dsh-feishu-bot】ds-pro开发')
    expect(formatSessionDisplayTitle('【dsh-feishu-bot】ds-pro开发', 'dsh-feishu-bot'))
      .toBe('【dsh-feishu-bot】ds-pro开发')
  })

  it('normalizes configurable progress detail tiers with summary as default', () => {
    expect(normalizeProgressDetail(undefined)).toBe('summary')
    expect(normalizeProgressDetail('concise')).toBe('concise')
    expect(normalizeProgressDetail('summary')).toBe('summary')
    expect(normalizeProgressDetail('full')).toBe('full')
    expect(normalizeProgressDetail('verbose')).toBe('summary')
  })
})
