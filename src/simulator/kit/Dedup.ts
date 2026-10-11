/**
 * FIFO deduplication, for SNS and SQS alike: remember the ids accepted in the last `windowMs`, so a repeat is acknowledged and dropped. A `Map` iterates in insertion
 * order, which is time order because an id is stored once, so expiry only looks at the front. At most `capacity` ids are
 * kept; past that the oldest go first, which shortens the window rather than growing memory.
 */
export class DedupWindow {
  private readonly seen = new Map<number, number>()

  constructor(private readonly windowMs: number, private readonly capacity = Infinity) {}

  /** True if `id` was accepted within the window (a duplicate); otherwise remembers it and returns false. */
  isDuplicate(id: number, now: number): boolean {
    this.expire(now)
    if (this.seen.has(id)) return true
    this.seen.set(id, now)
    if (this.seen.size > this.capacity) this.seen.delete(this.seen.keys().next().value as number)
    return false
  }

  get size(): number {
    return this.seen.size
  }

  private expire(now: number): void {
    for (const [id, at] of this.seen) {
      if (now - at < this.windowMs) return
      this.seen.delete(id)
    }
  }
}
