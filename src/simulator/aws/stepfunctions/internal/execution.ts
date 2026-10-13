import { Duration, SubscriptionRef } from "effect"
import type * as Edge from "../../../Edge.ts"
import * as Flow from "../../../Flow.ts"
import { type CallFailure, Failed, type Message } from "../../../Message.ts"
import type { Sampler } from "../../../Telemetry.ts"
import type { TimerHandle } from "../../../VirtualTime.ts"
import { type FallbackEdge, matches, type StateEdge } from "./config.ts"
import { EVENTS, EXPRESS_MAX_DURATION_MS, HISTORY_LIMIT, STANDARD_MAX_DURATION_MS } from "./limits.ts"
import { MapState } from "./map.ts"
import { afterWait, Entry, type Machine, ParallelState, type Run, TaskState } from "./states.ts"

/**
 * The workflow the `out` edges describe, in the order they are wired: each edge one state, consecutive edges marked
 * `parallel` the branches of one Parallel state.
 */
export interface Plan {
  readonly steps: ReadonlyArray<ReadonlyArray<Edge.Link<StateEdge>>>
  /** The step at which each node the workflow calls is first reached: how a compensation's `undoes` is resolved. */
  readonly stepOf: ReadonlyMap<string, number>
}

/**
 * Works out the plan from the edges' settings, and again only when one of them has been edited: it is memoised on the
 * identity of each edge's settings, which change only when someone edits them.
 */
export class Planner {
  private seen: ReadonlyArray<StateEdge> = []
  private plan: Plan = { steps: [], stepOf: new Map() }

  constructor(private readonly links: ReadonlyArray<Edge.Link<StateEdge>>) {
    this.rebuild()
  }

  current(): Plan {
    const { links, seen } = this
    for (let i = 0; i < links.length; i++) {
      if (SubscriptionRef.getUnsafe(links[i]!.config) !== seen[i]) {
        this.rebuild()
        break
      }
    }
    return this.plan
  }

  private rebuild(): void {
    const steps: Array<Array<Edge.Link<StateEdge>>> = []
    const stepOf = new Map<string, number>()
    this.seen = this.links.map((link) => {
      const c = SubscriptionRef.getUnsafe(link.config)
      // The first state has nothing before it to run alongside.
      if (c.parallel && steps.length > 0) steps[steps.length - 1]!.push(link)
      else steps.push([link])
      if (!stepOf.has(link.to)) stepOf.set(link.to, steps.length - 1)
      return c
    })
    this.plan = { steps, stepOf }
  }
}

export type Outcome = "succeeded" | "failed" | "timedOut"
/** How an execution ended, for a caller waiting on it (a synchronous Express execution). */
export type Reply = (outcome: Outcome, failure: CallFailure | undefined) => void

/** What executions of one state machine need beyond the states' `Machine`. */
export interface Workflow {
  readonly machine: Machine
  readonly planner: Planner
  /** The states of the fallback path, in the order they run. */
  readonly fallbacks: ReadonlyArray<Edge.Link<FallbackEdge>>
  readonly executionTime: Sampler
  /** Executions of this state machine running right now. */
  running: number
}

/** What the tasks of an execution are sent: its input, as a call that waits for the answer, and no longer a batch. */
const taskInput = (m: Message): Message => {
  if (m.invocation === "sync" && m.batched === undefined) return m
  const { batched: _, ...plain } = m
  return { ...plain, invocation: "sync" }
}

/**
 * One execution: the states of the plan one after another, the catcher's fallback path when a state fails, and the end.
 *
 * Standard and Express differ in what bounds them: a Standard execution's transitions are throttled by the account's
 * StateTransition bucket, its history holds at most 25,000 events, and it may run for a year; an Express execution has
 * no transition quota and no history to fill, and stops at five minutes. Either fails with `States.Timeout` past the
 * state machine's own TimeoutSeconds, when it has one.
 *
 * Whatever it holds (its place in `running` and in the Region's open executions, the timeout timer, the state in
 * progress) is given back exactly once, in `end`.
 */
export class Execution implements Run {
  over = false
  readonly throttled: boolean
  readonly distributed: boolean
  private history = 0
  private timeout: TimerHandle | undefined
  private current: Flow.Cancel = Flow.noCancel
  /** Counts the states started, so a state that finished while it was being started isn't held as the current one. */
  private turn = 0
  /** The step being run, or that failed: how far the execution got, for the compensations. */
  private step = 0
  private startedAt = 0
  private plan: Plan = { steps: [], stepOf: new Map() }
  private readonly input: Message

  constructor(
    private readonly workflow: Workflow,
    message: Message,
    private readonly standard: boolean,
    private readonly reply: Reply | undefined
  ) {
    this.throttled = standard
    this.distributed = standard
    this.input = taskInput(message)
  }

  get machine(): Machine {
    return this.workflow.machine
  }

  start(): void {
    const w = this.workflow
    const { fast, region, tally } = w.machine
    const c = fast.settings()
    w.running++
    if (this.standard) region.openStandard++
    tally.started.add(1)
    this.startedAt = fast.now()
    this.history = EVENTS.execution
    const most = this.standard ? STANDARD_MAX_DURATION_MS : EXPRESS_MAX_DURATION_MS
    const own = Duration.toMillis(c.timeout)
    this.timeout = fast.after(own > 0 ? Math.min(own, most) : most, timedOut, this)
    this.plan = w.planner.current()
    this.runStep(0)
  }

  record(events: number): boolean {
    if (this.over) return false
    if (!this.standard) return true
    // Event 25,000 may only be ExecutionSucceeded: anything else that would reach it fails the execution instead.
    if (this.history + events > HISTORY_LIMIT - 1) {
      this.machine.tally.historyExceeded.add(1)
      this.end("failed", Failed({ node: this.machine.id, reason: `execution history reached its ${HISTORY_LIMIT.toLocaleString("en-US")}-event quota` }))
      return false
    }
    this.history += events
    return true
  }

  private runStep(i: number): void {
    if (this.over) return
    const steps = this.plan.steps
    if (i >= steps.length) return this.end("succeeded", undefined)
    this.step = i
    const branches = steps[i]!
    if (branches.length === 1) {
      const link = branches[0]!
      const turn = ++this.turn
      return this.hold(turn, this.state(link, (failure) => (failure === undefined ? this.runStep(i + 1) : this.stateFailed(link, failure))))
    }
    const turn = ++this.turn
    this.hold(
      turn,
      new ParallelState(this, branches.map((link) => (done: Flow.Done) => this.state(link, done)), (failure, branch) =>
        failure === undefined ? this.runStep(i + 1) : this.stateFailed(branches[branch]!, failure)).start()
    )
  }

  /**
   * Hold on to the state just started, so that `end` can abandon it, unless it already finished while being started and
   * the execution has moved on (or ended): then what it handed back is stale.
   */
  private hold(turn: number, cancel: Flow.Cancel): void {
    if (!this.over && turn === this.turn) this.current = cancel
  }

  /** One state of the plan, with its Wait state in front if it has one. Settings are read as the state is entered. */
  private state(link: Edge.Link<StateEdge>, done: Flow.Done): Flow.Cancel {
    const c = SubscriptionRef.getUnsafe(link.config)
    const body = (): Flow.Cancel =>
      c.state === "map" ? new MapState(this, link, c, this.input, done).start() : new TaskState(this, link, this.input, done).start()
    return afterWait(this, Duration.toMillis(c.wait), body)
  }

  /** A state failed for good (its retrier, if any, has given up): its catcher, or the end of the execution. */
  private stateFailed(link: Edge.Link<StateEdge>, failure: CallFailure): void {
    if (this.over) return
    const catcher = SubscriptionRef.getUnsafe(link.config).catcher
    if (catcher.enabled && matches(catcher.errorEquals, failure)) return this.fallback(failure)
    this.end("failed", failure)
  }

  /**
   * The fallback path: the states on the `catch` port, in order, each a task with its own retrier. A compensation that
   * names the state it undoes runs only if the execution had reached that state. The path ends in a Fail or a Succeed
   * state; a compensation that fails for good fails the execution.
   */
  private fallback(caught: CallFailure): void {
    const { fallbacks } = this.workflow
    const { tally } = this.machine
    tally.caught.add(1)
    let i = 0
    const next = (failure?: CallFailure): void => {
      if (this.over) return
      if (failure !== undefined) return this.end("failed", failure)
      while (i < fallbacks.length) {
        const link = fallbacks[i++]!
        const c = SubscriptionRef.getUnsafe(link.config)
        const undoes = c.undoes === "" ? undefined : this.plan.stepOf.get(c.undoes)
        if (undoes !== undefined && undoes > this.step) continue
        tally.compensations.add(1)
        const body = (): Flow.Cancel => new TaskState(this, link, this.input, next).start()
        const turn = ++this.turn
        return this.hold(turn, afterWait(this, Duration.toMillis(c.wait), body))
      }
      const fails = this.machine.fast.settings().afterCatch === "fail"
      const turn = ++this.turn
      const entry = new Entry(this, fails ? EVENTS.fail : EVENTS.succeed, () => this.end(fails ? "failed" : "succeeded", fails ? caught : undefined)).start()
      this.hold(turn, () => entry.cancel())
    }
    next()
  }

  timedOut(): void {
    this.timeout = undefined
    this.end("timedOut", Failed({ node: this.machine.id, reason: "States.Timeout: the execution ran past its timeout" }))
  }

  /** The execution is over: give back everything it holds, count it, and answer whoever waits on it. */
  private end(outcome: Outcome, failure: CallFailure | undefined): void {
    if (this.over) return
    this.over = true
    this.timeout?.cancel()
    this.timeout = undefined
    this.current()
    this.current = Flow.noCancel
    const w = this.workflow
    const { fast, region, tally } = w.machine
    w.running--
    if (this.standard) region.openStandard--
    w.executionTime.add(fast.now() - this.startedAt)
    tally[outcome].add(1)
    this.reply?.(outcome, failure)
  }
}

const timedOut = (execution: Execution): void => execution.timedOut()
