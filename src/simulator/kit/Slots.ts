/**
 * A number of slots and a line of work waiting for one, first come first served: workers in a service, the one thread
 * of an actor, connections in a pool.
 *
 * Both numbers are read when they matter, so a live change applies at once: more slots start waiting work straight away
 * (`kick`), fewer let the running work finish and start nothing until it drops below. Work that gives up while it waits
 * is skipped when its turn comes, so cancelling is O(1).
 */
export class Slots {
  /** Work holding a slot. */
  running = 0
  private readonly line: Array<Waiter> = []
  private head = 0
  /** Waiters in the line that haven't given up. */
  private live = 0

  constructor(
    /** How many slots there are right now. */
    private readonly capacity: () => number,
    /** How long the line may get. */
    private readonly limit: () => number
  ) {}

  /** Work waiting for a slot. */
  get queued(): number {
    return this.live
  }

  /**
   * Run `start` once a slot is free: at once if one is, otherwise when its turn comes. `undefined` if there is no slot
   * and the line is full (nothing was queued); otherwise a function that gives up the place in the line. Whoever was
   * started must call `release` when done.
   */
  acquire(start: () => void): (() => void) | undefined {
    if (this.running < this.capacity() && this.live === 0) {
      this.running++
      start()
      return noop
    }
    if (this.live >= this.limit()) return undefined
    const waiter: Waiter = { start, gone: false }
    this.line.push(waiter)
    this.live++
    return () => {
      if (waiter.gone) return
      waiter.gone = true
      this.live--
    }
  }

  /** A slot is free again: give it to the next in line. */
  release(): void {
    this.running = Math.max(0, this.running - 1)
    this.kick()
  }

  /** Start waiting work while there are free slots (after the number of slots grew, say). */
  kick(): void {
    while (this.live > 0 && this.running < this.capacity()) {
      const waiter = this.line[this.head++]!
      if (waiter.gone) continue
      waiter.gone = true
      this.live--
      this.running++
      waiter.start()
    }
    // Reclaim the consumed front of the line once it is worth it.
    if (this.head > 1024 && this.head * 2 > this.line.length) {
      this.line.splice(0, this.head)
      this.head = 0
    }
    if (this.live === 0) {
      this.line.length = 0
      this.head = 0
    }
  }
}

interface Waiter {
  readonly start: () => void
  gone: boolean
}

const noop = (): void => {}
