/**
 * A keyed family: one logical node that is really many instances, one per key, made the first time a key is used and
 * forgotten once it has been idle long enough.
 *
 * It is the shape of a Durable Object class (one single-threaded object per id), an actor system, a DynamoDB table's
 * partitions, a FIFO queue's message groups, a Kafka topic's partitions. What they share, and what this keeps, is the
 * bookkeeping: which instances exist, which are in use, which have sat idle past their lifetime, and whether a call found
 * its instance warm or had to make it (a cold start). What an instance *is* belongs to the component.
 *
 * Eviction is lazy, so nothing has to wake up to do it: an instance that has been idle too long is treated as gone the
 * next time its key is used (it is made afresh, cold), and `sweep` forgets every such instance at once, which a component
 * calls before it reports how many exist.
 *
 *   const objects = new Family({ now: fast.now, create: (key) => new RoomState(key), idleMs: () => settings().idle })
 *   const { instance, cold } = objects.enter(key)   // ...work...   objects.leave(key)
 */

export interface Options<I> {
  readonly now: () => number
  /** Make the instance for a key. */
  readonly create: (key: string) => I
  /** How long an instance may sit with nothing in progress before it is evicted. Read each time, so edits apply. */
  readonly idleMs: () => number
  /** Hears an instance being evicted. */
  readonly evicted?: (key: string, instance: I) => void
}

interface Entry<I> {
  readonly instance: I
  /** Work in progress on it. Busy instances are never evicted. */
  active: number
  /** When it last finished something (or was made). */
  idleSince: number
}

/** How often, at most, a busy family checks all its instances for idle ones when instances are added. */
const SWEEP_EVERY_MS = 1_000

export class Family<I> {
  private readonly entries = new Map<string, Entry<I>>()
  private swept = 0
  /** Instances made, ever: each one a cold start. */
  created = 0
  /** Instances evicted for being idle, ever. */
  evictions = 0

  constructor(private readonly options: Options<I>) {}

  /** Instances that exist right now (after forgetting the idle ones). */
  get size(): number {
    this.sweep()
    return this.entries.size
  }

  /** The instance for `key` if it exists and is warm, without using it. */
  peek(key: string): I | undefined {
    const e = this.entries.get(key)
    if (e === undefined) return undefined
    if (this.expired(e, this.options.now())) {
      this.evict(key, e)
      return undefined
    }
    return e.instance
  }

  /**
   * Start some work on `key`'s instance, making it if it doesn't exist or has been idle past its lifetime. `cold` says
   * which. Every `enter` must be matched by a `leave`.
   */
  enter(key: string): { readonly instance: I; readonly cold: boolean } {
    const now = this.options.now()
    let e = this.entries.get(key)
    let cold = false
    if (e !== undefined && this.expired(e, now)) {
      this.evict(key, e)
      e = undefined
    }
    if (e === undefined) {
      e = { instance: this.options.create(key), active: 0, idleSince: now }
      this.entries.set(key, e)
      this.created++
      cold = true
      if (now - this.swept >= SWEEP_EVERY_MS) this.sweep()
    }
    e.active++
    return { instance: e.instance, cold }
  }

  /** Work on `key`'s instance has finished. */
  leave(key: string): void {
    const e = this.entries.get(key)
    if (e === undefined) return
    e.active = Math.max(0, e.active - 1)
    if (e.active === 0) e.idleSince = this.options.now()
  }

  /** Forget every instance that has been idle past its lifetime. */
  sweep(): void {
    const now = this.options.now()
    this.swept = now
    for (const [key, e] of this.entries) if (this.expired(e, now)) this.evict(key, e)
  }

  /** Each instance that exists, with its key. */
  forEach(visit: (instance: I, key: string) => void): void {
    this.sweep()
    for (const [key, e] of this.entries) visit(e.instance, key)
  }

  private expired(e: Entry<I>, now: number): boolean {
    return e.active === 0 && now - e.idleSince >= this.options.idleMs()
  }

  private evict(key: string, e: Entry<I>): void {
    this.entries.delete(key)
    this.evictions++
    this.options.evicted?.(key, e.instance)
  }
}

/** Which of `count` keys a message's partition key (a hash in [0, 1)) falls on: the same message key, the same instance. */
export const keyOf = (hash: number, count: number): string => String(Math.min(count - 1, Math.max(0, Math.floor(hash * count))))
