/**
 * The timer queue behind `VirtualTime.ts`: every timer a world has armed, ordered by when it is due. On the hot path
 * (a simulation arms and cancels a timeout for every call), so it is a plain mutable heap.
 */
import type { TimerHandle } from "../VirtualTime.ts"

/**
 * The timer queue: a binary min-heap ordered by (time, insertion) that knows where each timer sits, so cancelling is
 * a removal rather than a tombstone. A simulation arms a timeout for every call and cancels almost all of them; with
 * tombstones the heap fills with dead timers, with removal it holds only the ones that can still fire.
 */
export class Timer implements TimerHandle {
  index = -1
  constructor(
    readonly at: number,
    readonly seq: number,
    readonly fire: (arg: never) => void,
    readonly arg: unknown,
    readonly queue: TimerQueue
  ) {}
  readonly cancel = (): void => this.queue.remove(this)
}

/** The heap itself. Each timer records its own position in it, which is what makes `remove` a removal. */
export class TimerQueue {
  readonly items: Array<Timer> = []

  /** Timers armed. */
  get size(): number {
    return this.items.length
  }

  /** The next timer due, without taking it. */
  peek(): Timer | undefined {
    return this.items[0]
  }

  /** Drop every timer. */
  clear(): void {
    for (const t of this.items) t.index = -1
    this.items.length = 0
  }

  /** Arm a timer. */
  push(timer: Timer): void {
    const items = this.items
    items.push(timer)
    this.up(timer, items.length - 1)
  }

  /** Take the next timer due. */
  pop(): Timer | undefined {
    const items = this.items
    const top = items[0]
    if (top === undefined) return undefined
    top.index = -1
    const last = items.pop()!
    if (items.length > 0) this.down(last, 0)
    return top
  }

  /** Disarm a timer, wherever it sits; nothing happens if it has already fired or been removed. */
  remove(timer: Timer): void {
    const i = timer.index
    if (i < 0) return
    timer.index = -1
    const items = this.items
    const last = items.pop()!
    if (i === items.length) return // it was the last element
    // Move the last element into the hole, then restore the heap in whichever direction it needs.
    if (i > 0 && this.less(last, items[(i - 1) >> 1]!)) this.up(last, i)
    else this.down(last, i)
  }

  private less(a: Timer, b: Timer): boolean {
    return a.at < b.at || (a.at === b.at && a.seq < b.seq)
  }

  private up(timer: Timer, from: number): void {
    const items = this.items
    let i = from
    while (i > 0) {
      const parent = (i - 1) >> 1
      const p = items[parent]!
      if (!this.less(timer, p)) break
      items[i] = p
      p.index = i
      i = parent
    }
    items[i] = timer
    timer.index = i
  }

  private down(timer: Timer, from: number): void {
    const items = this.items
    const n = items.length
    let i = from
    const half = n >> 1
    while (i < half) {
      let child = 2 * i + 1
      const right = child + 1
      if (right < n && this.less(items[right]!, items[child]!)) child = right
      if (!this.less(items[child]!, timer)) break
      const c = items[child]!
      items[i] = c
      c.index = i
      i = child
    }
    items[i] = timer
    timer.index = i
  }
}
