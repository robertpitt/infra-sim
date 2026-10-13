import type { Fast } from "../../../Component.ts"
import type { TimerHandle } from "../../../VirtualTime.ts"

/**
 * Refresh: an indexed document is not searchable until its shard next refreshes, every `index.refresh_interval` (1 s by
 * default). Every shard refreshes on the same clock here, at whole multiples of the interval, so a document waits for
 * the next tick: half an interval on average, a whole one at worst. This is the "near real-time" in OpenSearch's
 * search, and the indexing lag a writer that reads its own writes sees. With refresh off nothing new becomes searchable
 * until it is turned on again.
 */
export class Refresh {
  /** When the next refresh happens; `Infinity` while refresh is off. */
  nextAt = Infinity
  /** Documents indexed since the last refresh. */
  unrefreshed = 0
  /** When the oldest of them was created (the message's `bornAt`). */
  private oldest = Infinity
  private interval = 0
  private timer: TimerHandle | undefined
  /** Writes waiting to be answered at the next refresh (`refresh=wait_for`). */
  private readonly waiters: Array<() => void> = []

  constructor(private readonly fast: Pick<Fast<unknown>, "after" | "now">) {}

  /** Follow a change of the interval (ms; 0 is off). The current cycle is cut short so the new interval applies at once. */
  setInterval(ms: number): void {
    if (ms === this.interval) return
    this.interval = ms
    this.timer?.cancel()
    this.timer = undefined
    this.nextAt = Infinity
    if (ms > 0) this.schedule()
    else this.release()
  }

  /** `docs` documents created at `bornAt` were just indexed. Returns when they become searchable (`Infinity` while off). */
  indexed(docs: number, bornAt: number): number {
    this.unrefreshed += docs
    if (bornAt < this.oldest) this.oldest = bornAt
    return this.nextAt
  }

  /** Age of the oldest document indexed but not yet searchable, in ms: 0 when everything is. */
  lag(): number {
    return this.unrefreshed > 0 ? Math.max(0, this.fast.now() - this.oldest) : 0
  }

  /** Call `done` at the next refresh, or at once while refresh is off (there is no refresh to wait for). */
  wait(done: () => void): void {
    if (this.nextAt === Infinity) done()
    else this.waiters.push(done)
  }

  private schedule(): void {
    const now = this.fast.now()
    this.nextAt = (Math.floor(now / this.interval) + 1) * this.interval
    this.timer = this.fast.after(this.nextAt - now, tick, this)
  }

  /** @internal The refresh: everything indexed so far becomes searchable. */
  refresh(): void {
    this.timer = undefined
    this.unrefreshed = 0
    this.oldest = Infinity
    this.schedule()
    this.release()
  }

  private release(): void {
    const waiting = this.waiters.splice(0)
    for (const done of waiting) done()
  }
}

const tick = (refresh: Refresh): void => refresh.refresh()
