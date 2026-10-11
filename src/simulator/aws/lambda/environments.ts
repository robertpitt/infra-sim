/**
 * The on-demand execution environments of one function: warm ones waiting for work, and a count of every one alive.
 *
 * After an invocation Lambda keeps the environment "for some time" in case another request comes, and throws it away
 * if none does (`lambda-runtime-environment.html`); it also retires environments every few hours even when they are
 * busy. The freshest idle environment is the likeliest to still be warm, so reuse is last-used-first, and expiry by
 * idleness only ever looks at the oldest end. Both expiries are lazy: nothing wakes up to evict an environment.
 *
 * This is the same bookkeeping as `../../WarmPool.ts` plus each environment's birth time, which the maximum-lifetime
 * rule needs and a stack of idle timestamps does not keep.
 */
export class Environments {
  /** When each idle environment was last used, oldest first. */
  private readonly idleSince: Array<number> = []
  /** When each idle environment was created, in step with `idleSince`. */
  private readonly bornAt: Array<number> = []
  private head = 0
  /** Environments alive: idle ones, and ones running a request. */
  alive = 0

  /** Idle environments right now (those that have not expired by idleness). */
  idleCount(now: number, ttl: number): number {
    this.expire(now, ttl)
    return this.idleSince.length - this.head
  }

  /**
   * Take the most recently used idle environment that is still warm and within its lifetime. Returns when it was
   * created, or -1 when there is none and a new one must be made. `lifetime` is 0 for no maximum.
   */
  take(now: number, ttl: number, lifetime: number): number {
    this.expire(now, ttl)
    while (this.idleSince.length > this.head) {
      this.idleSince.pop()
      const born = this.bornAt.pop()!
      if (lifetime > 0 && now - born >= lifetime) {
        this.alive-- // too old: retired on the spot, and the next one is tried
        continue
      }
      return born
    }
    return -1
  }

  /** A new environment now exists, and is busy. */
  created(): void {
    this.alive++
  }

  /** A busy environment finished and goes back to waiting, unless it has reached its maximum lifetime. */
  release(now: number, born: number, lifetime: number): void {
    if (lifetime > 0 && now - born >= lifetime) {
      this.alive--
      return
    }
    this.idleSince.push(now)
    this.bornAt.push(born)
  }

  /** A busy environment is thrown away instead (a timeout resets it). */
  discard(): void {
    this.alive--
  }

  /** Drop environments idle for longer than `ttl`. */
  expire(now: number, ttl: number): void {
    const idle = this.idleSince
    while (this.head < idle.length && now - idle[this.head]! >= ttl) {
      this.head++
      this.alive--
    }
    // Reclaim the dead front once it is worth it.
    if (this.head > 1024 && this.head * 2 > idle.length) {
      idle.splice(0, this.head)
      this.bornAt.splice(0, this.head)
      this.head = 0
    }
  }
}
