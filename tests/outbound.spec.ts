/**
 * Outbound projection (design §6.3): assistant text → deterministic segments
 * keyed by `chatId:sessionId:sourceEventSeq:segmentIndex`; identical inputs
 * always produce identical rows, so a crash-resend duplicates at most the
 * one in-flight segment (honest one-resend window).
 */
import { describe, expect, it } from 'vitest'
import { segmentText } from '../src/bridge/outbound.ts'

describe('segmentText', () => {
  it('short text yields one segment', () => {
    expect(segmentText('hello', 100)).toEqual(['hello'])
  })

  it('empty or whitespace-only text yields no segments', () => {
    expect(segmentText('', 100)).toEqual([])
    expect(segmentText('   \n  ', 100)).toEqual([])
  })

  it('splits on paragraph boundaries before hard-splitting', () => {
    const text = 'para one\n\npara two\n\npara three'
    expect(segmentText(text, 12)).toEqual(['para one', 'para two', 'para three'])
  })

  it('hard-splits an oversized single paragraph deterministically', () => {
    const text = 'a'.repeat(25)
    expect(segmentText(text, 10)).toEqual(['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)])
  })

  it('is deterministic: same input, same output', () => {
    const text = `mixed ${'x'.repeat(40)}\n\nshort tail`
    expect(segmentText(text, 16)).toEqual(segmentText(text, 16))
  })

  it('never emits a segment above the limit', () => {
    const text = 'word '.repeat(100) + '\n\n' + 'y'.repeat(90)
    for (const segment of segmentText(text, 30)) {
      expect(segment.length).toBeLessThanOrEqual(30)
    }
  })
})
