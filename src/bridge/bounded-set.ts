/**
 * A membership set with a hard ceiling and FIFO eviction.
 *
 * In-memory guards like "this Feishu message was already consumed as a
 * question answer" only need to remember RECENT ids: the platform re-delivers a
 * message within a short window, and a long-lived process would otherwise keep
 * one string per answer forever. Retention is deliberately dumb — the oldest
 * entry leaves when the ceiling is reached, which is correct for the
 * at-least-once delivery window this guards.
 */
export class BoundedIdSet {
  /** Insertion-ordered, so the first entry is always the oldest. */
  private readonly ids = new Set<string>()

  /**
   * @param limit - maximum entries retained; must be positive.
   */
  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError('BoundedIdSet limit must be a positive integer')
    }
  }

  /** Whether `id` is currently retained. */
  has(id: string): boolean {
    return this.ids.has(id)
  }

  /**
   * Retain `id`, evicting the oldest entry when the ceiling is exceeded.
   *
   * Re-adding a retained id is a no-op: it keeps its original position, so a
   * repeatedly redelivered message cannot displace everything else.
   * @param id - the value to retain.
   */
  add(id: string): void {
    if (this.ids.has(id)) return
    this.ids.add(id)
    while (this.ids.size > this.limit) {
      const oldest = this.ids.values().next()
      if (oldest.done === true) break
      this.ids.delete(oldest.value)
    }
  }

  /** Current number of retained ids, never above the limit. */
  get size(): number {
    return this.ids.size
  }
}
