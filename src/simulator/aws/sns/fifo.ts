/**
 * The bookkeeping a FIFO topic needs, each piece bounded so a long run or a hostile key space cannot grow it without end.
 */

/**
 * Per-message-group publish limit: a token bucket per group, 300 messages a second. Groups come from the publisher and
 * there is no limit to how many ids it may use, so a bucket that has refilled completely (which is what a new one
 * looks like) is forgotten: the map holds only groups that published within the last second or so.
 */
export class GroupRates {
  private readonly buckets = new Map<string, { tokens: number; at: number }>()
  /** Sweep when the map grows past this, so the cost of sweeping is spread over the inserts that caused it. */
  private sweepAt = SWEEP_FLOOR

  constructor(private readonly rate: number) {}

  /** Take `tokens` from the group's bucket, or report that the group is over its rate. Never waits. */
  take(group: string, tokens: number, now: number): boolean {
    let bucket = this.buckets.get(group)
    if (bucket === undefined) {
      if (this.buckets.size >= this.sweepAt) this.sweep(now)
      bucket = { tokens: this.rate, at: now }
      this.buckets.set(group, bucket)
    } else if (now > bucket.at) {
      bucket.tokens = Math.min(this.rate, bucket.tokens + ((now - bucket.at) * this.rate) / 1000)
      bucket.at = now
    }
    // A request bigger than the whole bucket could never succeed; let it have the bucket.
    const needed = tokens > this.rate ? this.rate : tokens
    if (bucket.tokens < needed) return false
    bucket.tokens -= needed
    return true
  }

  /** Groups currently remembered. */
  get size(): number {
    return this.buckets.size
  }

  private sweep(now: number): void {
    for (const [group, bucket] of this.buckets) {
      if (bucket.tokens + ((now - bucket.at) * this.rate) / 1000 >= this.rate) this.buckets.delete(group)
    }
    this.sweepAt = Math.max(SWEEP_FLOOR, this.buckets.size * 2)
  }
}

const SWEEP_FLOOR = 1_024

/**
 * Serial lanes: work added under the same key runs one at a time, in the order it was added; different keys run side
 * by side. This is what ordering by message group means. A lane exists only while it has work, so finished groups leave
 * nothing behind. (`Flow.Lanes` does the same; this one can say how many lanes are open, which a probe needs.)
 */
export class SerialLanes {
  private readonly waiting = new Map<string, Array<(release: () => void) => void>>()

  run(key: string, task: (release: () => void) => void): void {
    const queue = this.waiting.get(key)
    if (queue !== undefined) {
      queue.push(task)
      return
    }
    this.waiting.set(key, [])
    this.start(key, task)
  }

  /** Lanes that currently have work running or waiting. */
  get open(): number {
    return this.waiting.size
  }

  private start(key: string, task: (release: () => void) => void): void {
    let released = false
    task(() => {
      if (released) return
      released = true
      const next = this.waiting.get(key)?.shift()
      if (next !== undefined) this.start(key, next)
      else this.waiting.delete(key)
    })
  }
}

/**
 * What a FIFO topic remembers to drop duplicates: ids accepted in the last `windowMs`. A `Map` iterates in insertion
 * order, which is time order because an id is stored once, so expiry only looks at the front. At most `capacity` ids are
 * kept; past that the oldest go first, which shortens the window rather than growing memory.
 */
export class DeduplicationWindow {
  private readonly seen = new Map<number, number>()

  constructor(private readonly windowMs: number, private readonly capacity: number) {}

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
