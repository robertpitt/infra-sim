/**
 * Warm environments waiting for work, with a lifetime for being idle.
 *
 * A serverless platform keeps an execution environment around after a request finishes, in case another comes, and
 * throws it away if none does. This is that: last-used-first (the freshest environment is the likeliest to still be
 * warm), expiry by idle time, counting how many exist. It replaces a general-purpose resource pool, whose scopes,
 * semaphores and finalizers cost far more than the bookkeeping here needs: a stack of timestamps.
 *
 * Expiry is lazy. Idle environments are stored oldest first, so asking "what has expired" only ever looks at the
 * front, and nothing has to wake up to evict them.
 */
export class WarmPool {
  /** When each idle environment was last used, oldest first. */
  private readonly idle: Array<number> = []
  private head = 0
  /** Environments alive: idle ones, and ones running a request. */
  alive = 0

  /** Idle environments right now (those that have not expired). */
  idleCount(now: number, ttl: number): number {
    this.expire(now, ttl)
    return this.idle.length - this.head
  }

  /** Take the most recently used idle environment, if one is still warm. */
  take(now: number, ttl: number): boolean {
    this.expire(now, ttl)
    if (this.idle.length === this.head) return false
    this.idle.pop()
    return true
  }

  /** A new environment now exists, and is busy. */
  created(): void {
    this.alive++
  }

  /** A busy environment finished and goes back to waiting. */
  release(now: number): void {
    this.idle.push(now)
  }

  /** A busy environment is thrown away instead (a timeout). */
  discard(): void {
    this.alive--
  }

  /** Drop environments idle for longer than `ttl`. */
  expire(now: number, ttl: number): void {
    const idle = this.idle
    while (this.head < idle.length && now - idle[this.head]! >= ttl) {
      this.head++
      this.alive--
    }
    // Reclaim the dead front once it is worth it.
    if (this.head > 1024 && this.head * 2 > idle.length) {
      idle.splice(0, this.head)
      this.head = 0
    }
  }
}
