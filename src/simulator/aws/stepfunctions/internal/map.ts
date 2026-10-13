import type * as Edge from "../../../Edge.ts"
import * as Flow from "../../../Flow.ts"
import type { CallFailure, Message } from "../../../Message.ts"
import type { StateEdge, StateSettings } from "./config.ts"
import { DISTRIBUTED_DISPATCH_PER_SECOND, DISTRIBUTED_MAP_CONCURRENCY, EVENTS, INLINE_MAP_CONCURRENCY } from "./limits.ts"
import { Entry, type Machine, type Run, Step, TaskState } from "./states.ts"

/**
 * Run `count` tasks, at most `concurrency` at once, tolerating up to `budget` failures: the one past the budget ends it
 * and abandons the others (their work carries on: Step Functions doesn't stop a running Lambda invocation). With a
 * budget of 0 this is an Inline Map, which fails on its first failed iteration. `stopped` ends the launching early: the
 * execution may end while tasks are being started (its history quota), before anyone holds the function that cancels.
 */
export const forEachTolerating = (
  count: number,
  concurrency: number,
  budget: number,
  task: (index: number, done: Flow.Done) => Flow.Cancel,
  done: Flow.Done,
  stopped: () => boolean
): Flow.Cancel => {
  if (count <= 0) {
    done(undefined)
    return Flow.noCancel
  }
  const running = new Set<Flow.Cancel>()
  let started = 0
  let finished = 0
  let failed = 0
  let open = true
  const launch = (): void => {
    while (open && started < count && running.size < concurrency && !stopped()) {
      started++
      let cancel: Flow.Cancel | undefined
      let settled = false
      cancel = task(started - 1, (failure) => {
        if (!open || settled) return
        settled = true
        if (cancel !== undefined) running.delete(cancel)
        if (failure !== undefined && ++failed > budget) {
          open = false
          for (const c of running) c()
          running.clear()
          return done(failure)
        }
        if (++finished === count) {
          open = false
          return done(undefined)
        }
        launch()
      })
      // A task that answered before returning is already counted; only one still running holds a place.
      if (!settled) running.add(cancel)
    }
  }
  launch()
  return () => {
    if (!open) return
    open = false
    for (const c of running) c()
    running.clear()
  }
}

/** One of a Distributed Map's child executions: a history of its own, and the parent's end is its end. */
class ChildRun implements Run {
  readonly distributed = false
  constructor(
    private readonly parent: Run,
    readonly throttled: boolean
  ) {}
  get machine(): Machine {
    return this.parent.machine
  }
  get over(): boolean {
    return this.parent.over
  }
  record(): boolean {
    return !this.parent.over
  }
}

/**
 * A Map state: the task once per item of the input, several at a time.
 *
 * Inline, the iterations run inside the execution: at most 40 at once (`state-map-inline.html`), each one's states are
 * the execution's own transitions and history events, and the first failed iteration fails the state. Distributed, each
 * item is a child workflow execution with a history of its own, up to 10,000 at once, started at most 1,000 a second
 * (Express children) or 100 (Standard ones), and the Map Run fails once more than the tolerated share of items has
 * failed. The edge's retrier is the item task's own `Retry`, inside the item processor: a `Retry` on the Map state itself
 * would run every item again.
 */
export class MapState extends Step {
  private work: Flow.Cancel = Flow.noCancel
  /** Distributed: when the next child execution may start. */
  private nextAt = 0
  private readonly distributed: boolean

  constructor(
    private readonly run: Run,
    private readonly link: Edge.Link<StateEdge>,
    private readonly settings: StateSettings,
    private readonly message: Message,
    private readonly done: Flow.Done
  ) {
    super()
    this.distributed = settings.map.mode === "distributed" && run.distributed
  }

  start(): Flow.Cancel {
    this.entry = new Entry(this.run, this.distributed ? EVENTS.distributedMap : EVENTS.map, this.begin).start()
    return this.cancel
  }

  private readonly begin = (): void => {
    this.entry = undefined
    const { map } = this.settings
    const m = this.message
    const items = map.items > 0 ? map.items : m.count >= 1 ? m.count : 1
    // Each iteration's input is one item: its share of the input's bytes.
    const item: Message = items === 1 && m.count <= 1 ? m : { ...m, count: 1, bytes: Math.max(1, Math.round(m.bytes / items)) }
    const finish = (failure: CallFailure | undefined): void => {
      if (!this.open) return
      this.open = false
      this.done(failure)
    }
    if (!this.distributed) {
      const concurrency = Math.min(map.maxConcurrency > 0 ? map.maxConcurrency : INLINE_MAP_CONCURRENCY, INLINE_MAP_CONCURRENCY)
      this.work = forEachTolerating(items, concurrency, 0, (_, d) => this.iteration(item, d), finish, this.stopped)
      return
    }
    const concurrency = Math.min(map.maxConcurrency > 0 ? map.maxConcurrency : DISTRIBUTED_MAP_CONCURRENCY, DISTRIBUTED_MAP_CONCURRENCY)
    const standard = map.childType === "standard"
    const child = new ChildRun(this.run, standard)
    const gapMs = 1000 / (standard ? DISTRIBUTED_DISPATCH_PER_SECOND.standard : DISTRIBUTED_DISPATCH_PER_SECOND.express)
    this.nextAt = this.run.machine.fast.now()
    this.work = forEachTolerating(items, concurrency, Math.floor(map.toleratedFailure * items), (_, d) => this.child(child, gapMs, item, d), finish, this.stopped)
  }

  private readonly stopped = (): boolean => !this.open || this.run.over

  private iteration(item: Message, done: Flow.Done): Flow.Cancel {
    if (!this.run.record(EVENTS.iteration)) return Flow.noCancel
    this.run.machine.tally.iterations.add(1)
    return new TaskState(this.run, this.link, item, done).start()
  }

  /** Start one child execution, no sooner than the dispatch rate allows. */
  private child(run: ChildRun, gapMs: number, item: Message, done: Flow.Done): Flow.Cancel {
    const { fast, tally } = this.run.machine
    const now = fast.now()
    const at = Math.max(now, this.nextAt)
    this.nextAt = at + gapMs
    const go = (): Flow.Cancel => {
      tally.iterations.add(1)
      tally.childExecutions.add(1)
      return new TaskState(run, this.link, item, done).start()
    }
    if (at <= now) return go()
    let inner: Flow.Cancel | undefined
    const timer = fast.after(at - now, () => {
      if (!run.over) inner = go()
    }, undefined)
    return () => {
      timer.cancel()
      inner?.()
    }
  }

  protected release(): void {
    this.work()
  }
}
