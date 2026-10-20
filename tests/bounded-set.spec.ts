/**
 * Bounded membership set: an in-memory guard that must never grow without
 * limit. Used for "already consumed" bookkeeping, where only recent entries
 * can still be re-delivered by Feishu.
 */
import { describe, expect, it } from 'vitest'
import { BoundedIdSet } from '../src/bridge/bounded-set.ts'

describe('BoundedIdSet', () => {
  it('remembers what was added', () => {
    const set = new BoundedIdSet(3)
    set.add('a')
    expect(set.has('a')).toBe(true)
    expect(set.has('b')).toBe(false)
  })

  it('stays at its ceiling and forgets the oldest first', () => {
    const set = new BoundedIdSet(3)
    for (const id of ['a', 'b', 'c', 'd']) set.add(id)
    expect(set.size).toBe(3)
    // 'a' was evicted; the three most recent survive.
    expect(set.has('a')).toBe(false)
    expect(set.has('b')).toBe(true)
    expect(set.has('d')).toBe(true)
  })

  it('re-adding an existing id does not evict anything', () => {
    const set = new BoundedIdSet(2)
    set.add('a')
    set.add('b')
    set.add('a')
    expect(set.size).toBe(2)
    expect(set.has('a')).toBe(true)
    expect(set.has('b')).toBe(true)
  })

  it('rejects a non-positive ceiling instead of silently behaving unbounded', () => {
    expect(() => new BoundedIdSet(0)).toThrow(/positive/u)
  })
})
