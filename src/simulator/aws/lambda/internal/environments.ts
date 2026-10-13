import { WarmPool } from "../../../WarmPool.ts"

/**
 * The on-demand execution environments of one function: warm ones waiting for work, and a count of every one alive.
 *
 * After an invocation Lambda keeps the environment "for some time" in case another request comes, and throws it away
 * if none does (`lambda-runtime-environment.html`); it also retires environments every few hours even when they are
 * busy. The freshest idle environment is the likeliest to still be warm, so reuse is last-used-first, and expiry by
 * idleness only ever looks at the oldest end. Both expiries are lazy: nothing wakes up to evict an environment.
 *
 * The reuse and idle expiry are `../../WarmPool.ts`'s. This adds each environment's birth time, which the
 * maximum-lifetime rule needs: a stack kept in step with the pool's idle environments, oldest first.
 */
export class Environments {
  private readonly pool = new WarmPool()
  /** When each idle environment was created, in step with the pool's idle ones; those before `head` have expired. */
  private readonly bornAt: Array<number> = []
  private head = 0

  /** Environments alive: idle ones, and ones running a request. */
  get alive(): number {
    return this.pool.alive
  }

  /** Idle environments right now (those that have not expired by idleness). */
  idleCount(now: number, ttl: number): number {
    this.expire(now, ttl)
    return this.bornAt.length - this.head
  }

  /**
   * Take the most recently used idle environment that is still warm and within its lifetime. Returns when it was
   * created, or -1 when there is none and a new one must be made. `lifetime` is 0 for no maximum.
   */
  take(now: number, ttl: number, lifetime: number): number {
    this.expire(now, ttl)
    while (this.pool.take(now, ttl)) {
      const born = this.bornAt.pop()!
      if (lifetime > 0 && now - born >= lifetime) {
        this.pool.discard() // too old: retired on the spot, and the next one is tried
        continue
      }
      return born
    }
    return -1
  }

  /** A new environment now exists, and is busy. */
  created(): void {
    this.pool.created()
  }

  /** A busy environment finished and goes back to waiting, unless it has reached its maximum lifetime. */
  release(now: number, born: number, lifetime: number): void {
    if (lifetime > 0 && now - born >= lifetime) {
      this.pool.discard()
      return
    }
    this.pool.release(now)
    this.bornAt.push(born)
  }

  /** A busy environment is thrown away instead (a timeout resets it). */
  discard(): void {
    this.pool.discard()
  }

  /** Drop environments idle for longer than `ttl`. */
  expire(now: number, ttl: number): void {
    const born = this.bornAt
    this.head = born.length - this.pool.idleCount(now, ttl)
    // The live birth times are always the last `idleCount` entries, so `head` is recomputed rather than tracked, and
    // the dead front can be reclaimed whenever it is worth it, independently of the pool's own reclaiming.
    if (this.head > 1024 && this.head * 2 > born.length) {
      born.splice(0, this.head)
      this.head = 0
    }
  }
}
