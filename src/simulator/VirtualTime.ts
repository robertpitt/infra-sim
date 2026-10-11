import { Clock, Context, Duration, Effect, Layer, Scheduler, type Fiber } from "effect"

/**
 * Virtual time.
 *
 * A `World` is a small Effect runtime that has its own `Clock` and its own `Scheduler`. `Effect.sleep` inside
 * it never waits on the wall clock: sleeping pushes a timer onto a heap, and the world jumps from timer to
 * timer when asked to `advanceTo`. Because the scheduler is synchronous and the heap is ordered by
 * (time, insertion), a run is deterministic and as fast as the CPU allows.
 *
 * Everything inside a world is ordinary Effect code (`Effect.sleep`, `Schedule`, `Effect.timeout` ...). The
 * only thing special about it is who owns time: whoever holds the `World` decides how far it moves.
 */
export interface World {
  /** Current virtual time, in milliseconds since the world was created. */
  readonly now: Effect.Effect<number>
  readonly nowUnsafe: () => number
  /**
   * Run `fire(arg)` after `ms` of virtual time. The cheapest way to wait: no fiber, no `Effect`, and `arg` lets a
   * caller pass shared state instead of allocating a closure per timer. Cancelling removes the timer immediately.
   */
  readonly after: <A>(ms: number, fire: (arg: A) => void, arg: A) => TimerHandle
  /**
   * Called with whatever a timer callback throws, so one broken callback is reported instead of ending the run.
   * Without a handler the error propagates out of `advanceTo`.
   */
  onError: ((error: unknown) => void) | undefined
  /** A context holding this world's `Clock` and `Scheduler`. Fibers started with it live in this world. */
  readonly context: Context.Context<never>
  /**
   * Start a fiber in the world with a ready-made context (`world.context` plus whatever the work needs, such as a
   * node's `Random`). No wrapper effects are built: the fiber just starts.
   */
  readonly spawn: <A, E>(effect: Effect.Effect<A, E>, context: Context.Context<never>) => Fiber.Fiber<A, E>
  /** Start an effect inside the world. It runs until it first has to wait, then hands back its fiber. */
  readonly fork: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<Fiber.Fiber<A, E>>
  /** Run every timer due at or before `target`, in order, then set the clock to `target`. */
  readonly advanceTo: (target: number) => Effect.Effect<void>
  /** Timers still armed. */
  readonly timers: Effect.Effect<number>
  /**
   * Stop the world for good: drop every timer, so nothing inside ever wakes again. Effect's own finalizers (a `Pool`
   * waits for its in-use items) would block forever on fibers sleeping through time that will never pass, and a
   * world that is being thrown away has no reason to unwind them.
   */
  readonly dispose: Effect.Effect<void>
}

/** An armed timer. `cancel` removes it from the queue at once, so abandoned timeouts never pile up. */
export interface TimerHandle {
  readonly cancel: () => void
}

export class VirtualTime extends Context.Service<VirtualTime, World>()("simulator/VirtualTime") {
  /** A fresh world, starting at t = 0. */
  static readonly layer: Layer.Layer<VirtualTime> = Layer.sync(VirtualTime, () => make())
}

/**
 * The timer queue: a binary min-heap ordered by (time, insertion) that knows where each timer sits, so cancelling is
 * a removal rather than a tombstone. A simulation arms a timeout for every call and cancels almost all of them; with
 * tombstones the heap fills with dead timers, with removal it holds only the ones that can still fire.
 */
class Timer implements TimerHandle {
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

class TimerQueue {
  readonly items: Array<Timer> = []

  get size(): number {
    return this.items.length
  }

  peek(): Timer | undefined {
    return this.items[0]
  }

  clear(): void {
    for (const t of this.items) t.index = -1
    this.items.length = 0
  }

  push(timer: Timer): void {
    const items = this.items
    items.push(timer)
    this.up(timer, items.length - 1)
  }

  pop(): Timer | undefined {
    const items = this.items
    const top = items[0]
    if (top === undefined) return undefined
    top.index = -1
    const last = items.pop()!
    if (items.length > 0) this.down(last, 0)
    return top
  }

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

export const make = (): World => {
  let now = 0
  let onError: ((error: unknown) => void) | undefined
  let seq = 0
  let disposed = false
  const timers = new TimerQueue()
  const arm = <A>(ms: number, fire: (arg: A) => void, arg: A): Timer => {
    const timer = new Timer(now + (ms > 0 ? ms : 0), seq++, fire as (arg: never) => void, arg, timers)
    timers.push(timer)
    return timer
  }

  // FIFO run queue with a moving head; reset when drained.
  let tasks: Array<() => void> = []
  let head = 0
  let draining = false
  const drain = () => {
    if (draining) return
    draining = true
    try {
      while (head < tasks.length) tasks[head++]!()
    } finally {
      tasks = []
      head = 0
      draining = false
    }
  }

  const scheduler: Scheduler.Scheduler = {
    executionMode: "sync",
    shouldYield: () => false,
    makeDispatcher: () => ({ scheduleTask: (task) => void tasks.push(task), flush: drain })
  }

  const nanos = () => BigInt(Math.round(now * 1e6))
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: nanos,
    monotonicTimeNanos: Effect.sync(nanos),
    sleep: (duration) =>
      Effect.callback<void>((resume) => {
        const timer = arm(Duration.toMillis(duration), resume as (arg: Effect.Effect<void>) => void, Effect.void)
        return Effect.sync(timer.cancel)
      })
  }
  const context = Context.make(Clock.Clock, clock).pipe(Context.add(Scheduler.Scheduler, scheduler))
  const runFork = Effect.runForkWith(context)

  const advance = (target: number) => {
    if (disposed) return
    drain()
    for (;;) {
      const next = timers.peek()
      if (next === undefined || next.at > target) break
      timers.pop()
      if (next.at > now) now = next.at
      if (onError === undefined) next.fire(next.arg as never)
      else {
        try {
          next.fire(next.arg as never)
        } catch (error) {
          onError(error)
        }
      }
      drain()
    }
    if (target > now) now = target
  }

  return {
    get onError() {
      return onError
    },
    set onError(handler) {
      onError = handler
    },
    now: Effect.sync(() => now),
    nowUnsafe: () => now,
    after: arm,
    context,
    spawn: (effect, ctx) => {
      const fiber = Effect.runForkWith(ctx)(effect)
      drain()
      return fiber
    },
    fork: (effect) =>
      Effect.sync(() => {
        const fiber = runFork(effect)
        drain()
        return fiber
      }),
    advanceTo: (target) => Effect.sync(() => advance(target)),
    timers: Effect.sync(() => timers.size),
    dispose: Effect.sync(() => {
      disposed = true
      timers.clear()
      tasks = []
      head = 0
    })
  }
}
