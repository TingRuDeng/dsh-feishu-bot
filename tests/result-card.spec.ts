import { describe, expect, it } from 'vitest'
import {
  resultCardEnvelopeBytes,
  segmentResultCards,
} from '../src/bridge/result-card.ts'

describe('result-card capacity preflight', () => {
  it('packs whole lines first and measures the full create-message envelope', () => {
    const first = '甲'.repeat(200)
    const second = '乙'.repeat(200)
    const segments = segmentResultCards('oc_test', 'workspace', `${first}\n${second}`, 1_024)

    expect(segments.map(segment => segment.text)).toEqual([first, second])
    expect(segments.map(segment => segment.card.header.title.content)).toEqual([
      'workspace · 最终结果 · 1/2',
      'workspace · 最终结果 · 2/2',
    ])
    for (const segment of segments) {
      expect(resultCardEnvelopeBytes('oc_test', segment.card)).toBeLessThanOrEqual(1_024)
    }
  })

  it('binary-splits one oversized Unicode line without losing content', () => {
    const text = `前缀${'🚀'.repeat(400)}后缀`
    const segments = segmentResultCards('oc_test', 'workspace', text, 700)

    expect(segments.length).toBeGreaterThan(1)
    expect(segments.map(segment => segment.text).join('')).toBe(text)
    for (const segment of segments) {
      expect(segment.text).not.toBe('')
      expect(resultCardEnvelopeBytes('oc_test', segment.card)).toBeLessThanOrEqual(700)
    }
  })

  it('keeps every default-budget card below the 24KB soft limit', () => {
    const segments = segmentResultCards('oc_test', 'workspace', 'x'.repeat(30_000))

    expect(segments.length).toBeGreaterThan(1)
    for (const segment of segments) {
      expect(resultCardEnvelopeBytes('oc_test', segment.card)).toBeLessThanOrEqual(24 * 1_024)
    }
  })
})
