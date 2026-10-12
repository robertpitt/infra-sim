import { Duration, SubscriptionRef } from "effect"
import type { Fast } from "../../Component.ts"
import * as Distribution from "../../Distribution.ts"
import type * as Edge from "../../Edge.ts"
import * as Flow from "../../Flow.ts"
import type { Tally } from "../../kit/Tally.ts"
import type { CallFailure, Message } from "../../Message.ts"
import type { TimerHandle } from "../../VirtualTime.ts"
import { matches, type Settings, type StateSettings } from "./config.ts"
import { EVENTS, STANDARD_MAX_DURATION_MS } from "./limits.ts"
import type { Region, Waiter } from "./region.ts"

/**
 * The states of a workflow, each a small state machine over world timers and `link.send` (no fiber, no `Effect`): an
 * execution makes many of them, and Step Functions designs run thousands of executions a second.
 *
 * Every state is started with `start()`, which returns the function that abandons it, and reports once to its `done`.
 * Each one checks `run.over` when it wakes, so an execution that has ended (failed elsewhere, timed out, hit its history
 * quota) is never continued by a timer or a late answer, and `cancel` gives back what it waits on: its place in the
 * state transition line, its timers, the call in flight.
 */

/** What every state machine counts. Names are what the frames report; see README.md, "Metrics and state". */
export const TALLIES = [
  "started",
  "succeeded",
  "failed",
  "timedOut",
  "throttled",
  "transitions",
  "transitionsThrottled",
  "retries",
  "caught",
  "compensations",
  "duplicates",
  "historyExceeded",
  "iterations",
  "childExecutions"
] as const
export type Tallies = Record<(typeof TALLIES)[number], Tally>

/** What every execution of one state machine shares. */
export interface Machine {
  readonly id: string
  readonly fast: Fast<Settings>
  readonly region: Region
  readonly tally: Tallies
  /** Transitions of this state machine's executions waiting for a token right now. */
  waiting: number
}

/** The settings of an edge a task is called through: it carries the state's `Retry` field. */
export type TaskEdge = Edge.Config & { readonly retrier: StateSettings["retrier"] }

/** What states run inside: an execution, or one of a Distributed Map's child executions. */
export interface Run {
  readonly machine: Machine
  /** Whether its state transitions take tokens from the account's StateTransition bucket (Standard workflows). */
  readonly throttled: boolean
  /** Whether it may run Distributed Map states (Standard workflows; Express ones run them as Inline). */
  readonly distributed: boolean
  /** It has ended: whatever is still pending for it must do nothing. */
  readonly over: boolean
  /** Write events into its history. False if that ended the execution (the 25,000-event quota). */
  record(events: number): boolean
}

/**
 * Entering a state: one state transition. In a Standard workflow it takes a token from the account's StateTransition
 * bucket, waiting its turn if there is none (throttling slows an execution down; it doesn't fail it). Then the transition
 * itself takes the assumed transition time, the state's events go into the history, and the state begins.
 */
export class Entry {
  private waiter: Waiter | undefined
  private timer: TimerHandle | undefined

  constructor(
    private readonly run: Run,
    private readonly events: number,
    private readonly go: () => void
  ) {}

  start(): this {
    const { run } = this
    const m = run.machine
    if (run.throttled && !m.region.transitions.tryNow()) {
      m.tally.transitionsThrottled.add(1)
      m.waiting++
      this.waiter = m.region.transitions.enqueue(this.admitted)
      return this
    }
    this.admit()
    return this
  }

  private readonly admitted = (): void => {
    this.waiter = undefined
    this.run.machine.waiting--
    this.admit()
  }

  private admit(): void {
    if (this.run.over) return
    const m = this.run.machine
    m.tally.transitions.add(1)
    const ms = Distribution.latencyMs(m.fast.settings().transitionLatency, m.fast.random)
    if (ms > 0) this.timer = m.fast.after(ms, enterNow, this)
    else this.enter()
  }

  enter(): void {
    this.timer = undefined
    if (this.run.over) return
    if (this.run.record(this.events)) this.go()
  }

  cancel(): void {
    if (this.waiter !== undefined) {
      this.waiter.cancel()
      this.waiter = undefined
      this.run.machine.waiting--
    }
    this.timer?.cancel()
    this.timer = undefined
  }
}

const enterNow = (entry: Entry): void => entry.enter()

/** The wait before retry `n` (counting from 0), as a retrier works it out: interval × rate^n, capped, perhaps jittered. */
export const retryDelay = (r: StateSettings["retrier"], n: number, random: { readonly nextDoubleUnsafe: () => number }): number => {
  const maxDelay = Duration.toMillis(r.maxDelay)
  // Without MaxDelaySeconds the waits grow without limit; no execution outlives a year, so neither need a wait.
  const capped = Math.min(Duration.toMillis(r.interval) * r.backoffRate ** n, maxDelay > 0 ? maxDelay : STANDARD_MAX_DURATION_MS)
  return r.jitter === "FULL" ? capped * random.nextDoubleUnsafe() : capped
}

/**
 * A Task state: call the resource, and on an error the state's retrier matches, wait and try again, each retry a state
 * transition of its own (`concepts-error-handling.html`: "Retries are treated as state transitions"). An error it doesn't
 * match, or one left when the retries are used up, is the state's failure, for its catcher to look at.
 */
export class TaskState<C extends TaskEdge = TaskEdge> {
  private retries = 0
  private open = true
  private entry: Entry | undefined
  private timer: TimerHandle | undefined
  private call: Flow.Cancel = Flow.noCancel

  constructor(
    private readonly run: Run,
    private readonly link: Edge.Link<C>,
    private readonly message: Message,
    private readonly done: Flow.Done
  ) {}

  start(): Flow.Cancel {
    this.entry = new Entry(this.run, EVENTS.taskState + EVENTS.taskAttempt, this.attempt).start()
    return this.cancel
  }

  private readonly attempt = (): void => {
    this.entry = undefined
    if (!this.open) return
    this.call = this.link.send(this.message, this.answered)
  }

  private readonly answered = (failure: CallFailure | undefined): void => {
    this.call = Flow.noCancel
    if (!this.open || this.run.over) return
    if (failure === undefined) {
      this.open = false
      return this.done(undefined)
    }
    const r = SubscriptionRef.getUnsafe(this.link.config).retrier
    if (r.enabled && this.retries < r.maxAttempts && matches(r.errorEquals, failure)) {
      const m = this.run.machine
      const wait = retryDelay(r, this.retries, m.fast.random)
      this.retries++
      m.tally.retries.add(1)
      this.timer = m.fast.after(wait, retryNow, this)
      return
    }
    this.open = false
    this.done(failure)
  }

  retry(): void {
    this.timer = undefined
    if (!this.open || this.run.over) return
    this.entry = new Entry(this.run, EVENTS.taskAttempt, this.attempt).start()
  }

  readonly cancel = (): void => {
    if (!this.open) return
    this.open = false
    this.entry?.cancel()
    this.timer?.cancel()
    this.call()
  }
}

const retryNow = (task: { readonly retry: () => void }): void => task.retry()

/** A Wait state, then whatever comes after it. */
export class WaitState {
  private open = true
  private entry: Entry | undefined
  private timer: TimerHandle | undefined
  private next: Flow.Cancel | undefined

  constructor(
    private readonly run: Run,
    private readonly ms: number,
    private readonly then: () => Flow.Cancel
  ) {}

  start(): Flow.Cancel {
    this.entry = new Entry(this.run, EVENTS.wait, this.waiting).start()
    return this.cancel
  }

  private readonly waiting = (): void => {
    this.entry = undefined
    this.timer = this.run.machine.fast.after(this.ms, resumeWait, this)
  }

  resume(): void {
    this.timer = undefined
    if (!this.open || this.run.over) return
    this.next = this.then()
  }

  readonly cancel = (): void => {
    if (!this.open) return
    this.open = false
    this.entry?.cancel()
    this.timer?.cancel()
    this.next?.()
  }
}

const resumeWait = (state: WaitState): void => state.resume()

/**
 * A Parallel state: its branches at once, waiting for all of them. The first to fail stops the others and fails the
 * state (`state-parallel.html`); the Lambda invocations they started run on.
 */
export class ParallelState {
  private open = true
  private entry: Entry | undefined
  private readonly running: Array<Flow.Cancel> = []

  constructor(
    private readonly run: Run,
    private readonly branches: ReadonlyArray<(done: Flow.Done) => Flow.Cancel>,
    /** Hears the outcome, and which branch failed. */
    private readonly done: (failure: CallFailure | undefined, branch: number) => void
  ) {}

  start(): Flow.Cancel {
    this.entry = new Entry(this.run, EVENTS.parallel, this.begin).start()
    return this.cancel
  }

  private readonly begin = (): void => {
    this.entry = undefined
    let remaining = this.branches.length
    this.branches.forEach((branch, i) => {
      if (!this.open) return
      this.running.push(branch((failure) => {
        if (!this.open) return
        if (failure !== undefined) {
          this.open = false
          for (const cancel of this.running) cancel()
          return this.done(failure, i)
        }
        if (--remaining === 0) {
          this.open = false
          this.done(undefined, -1)
        }
      }))
    })
  }

  readonly cancel = (): void => {
    if (!this.open) return
    this.open = false
    this.entry?.cancel()
    for (const cancel of this.running) cancel()
  }
}
