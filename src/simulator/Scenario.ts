import { Duration, Effect, Schema } from "effect"
import * as Alarm from "./Alarm.ts"
import { type Assertion, clientIds, parseDuration, within } from "./Check.ts"
import * as Design from "./Design.ts"
import * as Fault from "./Fault.ts"
import { Registry } from "./Registry.ts"
import * as ScenarioSpec from "./ScenarioSpec.ts"
import * as Simulation from "./Simulation.ts"
import type { Frame } from "./Telemetry.ts"
import { VirtualTime } from "./VirtualTime.ts"
import * as internal from "./internal/scenario.ts"

/**
 * Scenarios: a design plus what happens to it.
 *
 * A design says what the system is; a scenario says how long to run it, with what traffic, which settings changed,
 * what breaks and when, and what must hold. A design carries the scenarios written for it (`scenarios` in the design);
 * a scenario can also be a file of its own that names its design, as below. Running one gives a plain-data `Result` (per-node and per-edge summaries,
 * the faults that happened, every assertion with its measured value), so the same scenario can be run from the
 * browser, a command line, a test or a CI job, and its result read by a person or a program.
 *
 *   version: 1
 *   name: Lose us-east-1 at peak
 *   design: ./orders.yaml
 *   duration: 10m
 *   warmup: 30s
 *   traffic: { scale: 3 }
 *   timeline:
 *     - { at: 4m, inject: { target: "region:aws:us-east-1", fault: Outage, for: 2m } }
 *   assert:
 *     - api.errorRatio < 1%
 *     - { check: "web.latency.p99 < 800ms", from: 7m }
 */

// Durations and assertions are written in the check language, which lives in `Check.ts` and is shared with alarms.
export { type Aggregate, ASSERTION_SYNTAX, type Assertion, parseAssertion, parseDuration } from "./Check.ts"

// ---------------------------------------------------------------------------------------------------------
// The scenario document
// ---------------------------------------------------------------------------------------------------------

/**
 * A scenario file: the scenario's fields (`ScenarioSpec.ts`, the same ones a design carries under `scenarios`) plus the
 * format version and the design it is for.
 */
export const Scenario = Schema.Struct({
  /** The JSON Schema the file follows, for editors. */
  $schema: Schema.optionalKey(Schema.String),
  version: Schema.Literal(1),
  /** A path to a design file (resolved by whoever loads the scenario), or the design itself. */
  design: Schema.optionalKey(Schema.Union([Schema.String, Design.Doc])),
  ...ScenarioSpec.fields
})
export type Scenario = typeof Scenario.Type

/** A scenario wherever it is written: in a file of its own, or in a design under `scenarios`. */
export type Spec = ScenarioSpec.Spec
export type TimelineEvent = ScenarioSpec.TimelineEvent

/** The scenarios a design carries, by id, in the order it lists them. */
export const ofDesign = (design: Design.Doc): ReadonlyArray<readonly [id: string, scenario: Spec]> => Object.entries(design.scenarios ?? {})

/** Something is wrong with the scenario, the design or the way they fit together. Every problem is listed. */
export class ScenarioError extends Error {
  override readonly name = "ScenarioError"
  constructor(readonly issues: ReadonlyArray<string>) {
    super(issues.join("\n"))
  }
}

// ---------------------------------------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------------------------------------

export interface DistSummary {
  readonly n: number
  readonly mean: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly max: number
}

/** What one node or edge did over the measured window. Rates are per second; latencies are milliseconds. */
export interface Summary {
  readonly type?: string
  readonly name?: string
  readonly rates: Readonly<Record<string, number>>
  readonly gauges: Readonly<Record<string, { readonly mean: number; readonly max: number; readonly last: number }>>
  readonly dist: Readonly<Record<string, DistSummary>>
  /** Events counted in the window. */
  readonly totals: { readonly in: number; readonly ok: number; readonly fail: number }
  /** fail / (ok + fail) over the window. */
  readonly errorRatio: number
}

export interface AssertionResult {
  readonly check: string
  readonly name: string | undefined
  readonly passed: boolean
  /** What was measured, or `undefined` if the subject doesn't exist. */
  readonly actual: number | undefined
  readonly expected: { readonly op: string; readonly value: number }
  readonly window: { readonly from: number; readonly to: number }
  /** Why it couldn't be checked, if it couldn't. */
  readonly problem?: string
}

export interface FaultSpan {
  readonly id: string
  readonly target: string
  readonly fault: Fault.Fault["_tag"]
  readonly from: number
  readonly to: number | undefined
}

export interface Result {
  readonly scenario: string | undefined
  readonly seed: number
  /** Virtual milliseconds run, and measured (after the warm-up). */
  readonly duration: number
  readonly warmup: number
  /** Real milliseconds the run took. */
  readonly wallMs: number
  readonly frameMs: number
  readonly passed: boolean
  /** Every client together: what users saw. */
  readonly system: Summary
  readonly nodes: Readonly<Record<string, Summary>>
  readonly edges: Readonly<Record<string, Summary>>
  readonly timeline: ReadonlyArray<{ readonly at: number; readonly what: string }>
  readonly faults: ReadonlyArray<FaultSpan>
  readonly assertions: ReadonlyArray<AssertionResult>
  /** Alarms that went off during the run, as a monitoring system would have raised them. */
  readonly alerts: ReadonlyArray<Alarm.Alert>
  /** Components that threw instead of failing a call. */
  readonly defects: ReadonlyArray<{ readonly t: number; readonly node: string; readonly message: string }>
  readonly diagnostics: ReadonlyArray<{ readonly level: string; readonly code: string; readonly message: string; readonly node?: string; readonly edge?: string }>
  /** Every frame, when asked for. */
  readonly frames?: ReadonlyArray<Frame>
}

// ---------------------------------------------------------------------------------------------------------
// Preparing and running
// ---------------------------------------------------------------------------------------------------------

type Bag = Record<string, unknown>

/** Deep merge: objects merge key by key, anything else replaces. */
export const merge = (base: Bag | undefined, over: Bag): Bag => internal.merge(base, over)

/** A fault as written in a scenario, as the fault schema's own JSON form. */
export const parseFault = (input: string | Bag): Bag | string => internal.parseFault(input)

/** What a scenario needs from outside: how long to run. The CLI supplies defaults for flags. */
export interface RunOptions {
  /** Return every frame in the result (large). */
  readonly keepFrames?: boolean
  readonly frameMs?: number
}

/**
 * Check a scenario against a design without running it: every problem, listed, in one go. Assertions are parsed, events
 * are checked for ids that exist and times inside the run.
 */
export const check = (design: Design.Doc, scenario: Spec): ReadonlyArray<string> => internal.check(design, scenario)

/**
 * Apply the scenario's traffic scale and starting overrides to the design's own settings. The design is not changed:
 * a new document comes back.
 */
export const prepare = (design: Design.Doc, scenario: Spec, registry: { readonly get: (type: string) => { readonly type: string } | undefined }): Design.Doc =>
  internal.prepare(design, scenario, registry)

// ---------------------------------------------------------------------------------------------------------
// Playing a scenario
// ---------------------------------------------------------------------------------------------------------

const EventKind = Schema.Literals(["inject", "clear", "set", "account", "note"])

/** Where a check stands: before its window opens, measuring (and so far holding or breaking), or decided. */
export const CheckState = Schema.Literals(["waiting", "holding", "breaking", "passed", "failed"])
export type CheckState = typeof CheckState.Type

export const CheckProgress = Schema.Struct({
  check: Schema.String,
  name: Schema.optionalKey(Schema.String),
  window: Schema.Struct({ from: Schema.Number, to: Schema.Number }),
  expected: Schema.Struct({ op: Schema.String, value: Schema.Number }),
  unit: Schema.Literals(["ratio", "ms", "count", "rate", "number"]),
  state: CheckState,
  /** What it measures over its window so far; absent while waiting. */
  actual: Schema.optionalKey(Schema.Number)
})
export type CheckProgress = typeof CheckProgress.Type

/** A scenario part-way through: what has happened, what is coming, and how each assertion is doing. Plain data. */
export const Progress = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  duration: Schema.Number,
  warmup: Schema.Number,
  t: Schema.Number,
  /** The run has reached its duration and every check is decided. */
  finished: Schema.Boolean,
  /** Once finished: did every check pass. */
  passed: Schema.optionalKey(Schema.Boolean),
  timeline: Schema.Array(Schema.Struct({ at: Schema.Number, what: Schema.String, kind: EventKind, done: Schema.Boolean })),
  checks: Schema.Array(CheckProgress)
})
export type Progress = typeof Progress.Type

/**
 * A scenario being played against a running simulation. Whoever drives time (`run` below, as fast as it can; the engine,
 * paced against the clock) asks where to stop next, advances there, records the frames and applies what is due, so an
 * event lands at exactly its time however fast the run. The checks are measured from the recorded frames, at any moment
 * (for a live view) or once the end is reached (for the verdict), the same way either way.
 */
export interface Playback {
  /** The design the scenario runs: its traffic scale and overrides applied over the design's own settings. */
  readonly design: Design.Doc
  readonly seed: number
  readonly duration: number
  readonly warmup: number
  /** Where the run has to stop next: the next event, or the end. Infinity once it has ended. */
  readonly nextStop: () => number
  /** Apply every event due by `now`, in order. */
  readonly apply: (sim: Simulation.Service, now: number) => Effect.Effect<void, ScenarioError>
  /** Keep what the checks will measure from new frames. */
  readonly record: (frames: ReadonlyArray<Frame>) => void
  /** Mark the end of the scenario. Time may go on (a live run can be played further), but nothing more happens. */
  readonly end: () => void
  readonly ended: () => boolean
  readonly progress: (now: number) => Progress
  /** Every assertion's verdict. Final once the end is reached. */
  readonly results: () => ReadonlyArray<AssertionResult>
  /** What happened, as it happened. */
  readonly log: ReadonlyArray<{ readonly at: number; readonly what: string }>
  readonly spans: ReadonlyArray<FaultSpan>
}

/**
 * Get a scenario ready to play against a design: checked (every problem reported, by id), its overrides applied, its
 * timeline in order and its assertions parsed.
 */
export const playback = (
  design: Design.Doc,
  scenario: Spec,
  registry: { readonly get: (type: string) => { readonly type: string; readonly inputs: boolean } | undefined }
): Effect.Effect<Playback, ScenarioError> =>
  Effect.gen(function*() {
    const problems = check(design, scenario)
    if (problems.length > 0) return yield* Effect.fail(new ScenarioError(problems))
    const duration = parseDuration(scenario.duration)
    if (duration === undefined) return yield* Effect.fail(new ScenarioError(["duration: a scenario needs one (for example 5m)"]))
    const warmup = parseDuration(scenario.warmup ?? 0) ?? 0
    const prepared = prepare(design, scenario, registry)
    const events = (scenario.timeline ?? [])
      .map((event, index) => ({ event, at: parseDuration(event.at)!, index }))
      .sort((a, b) => a.at - b.at || a.index - b.index)
    // `check` has parsed every assertion already.
    const assertions = (scenario.assert ?? []).map((a) => internal.parseAssertionInput(a) as Assertion)
    const checks = new internal.Checks(assertions, clientIds(prepared, registry), warmup, duration)

    const spans: Array<{ id: string; target: string; fault: Fault.Fault["_tag"]; from: number; to: number | undefined }> = []
    const log: Array<{ at: number; what: string }> = []
    const named = new Map<string, string>()
    let applied = 0
    let ended = false
    const fail = (message: string) => Effect.fail(new ScenarioError([message]))

    const applyOne = (sim: Simulation.Service, event: TimelineEvent, at: number) =>
      Effect.gen(function*() {
        log.push({ at, what: internal.describe(event) })
        if (event.inject !== undefined) {
          const target = internal.parseTarget(event.inject.target, prepared) as Fault.Target
          const encoded = internal.parseFault(event.inject.fault as string | Bag) as Bag
          const fault = yield* Schema.decodeUnknownEffect(Fault.Fault)(encoded).pipe(Effect.mapError((e) => new ScenarioError([`timeline: ${e.message}`])))
          const lasts = event.inject.for === undefined ? undefined : parseDuration(event.inject.for)
          const active = yield* sim.faults.inject(target, fault, lasts).pipe(Effect.mapError(() => new ScenarioError([`timeline: nothing to inject into at ${event.inject!.target}`])))
          spans.push({ id: active.id, target: event.inject.target, fault: fault._tag, from: at, to: lasts === undefined ? undefined : at + lasts })
          if (event.inject.id !== undefined) named.set(event.inject.id, active.id)
        } else if (event.clear !== undefined) {
          const open = yield* sim.faults.active
          const ids = event.clear === "all" ? open.map((f) => f.id) : [named.get(event.clear) ?? event.clear]
          for (const id of ids) {
            yield* sim.faults.clear(id)
            const span = spans.find((s) => s.id === id)
            if (span !== undefined && span.to === undefined) span.to = at
          }
        } else if (event.set !== undefined) {
          // Over what is live: a person's edit, an earlier set, an autoscaler's decision all stay.
          const { node, edge, settings } = event.set
          if (node !== undefined) {
            yield* sim.patchNode(node, settings).pipe(Effect.catch((e) => fail(`timeline: ${node}: ${internal.messageOf(e)}`)))
          } else if (edge !== undefined) {
            yield* sim.patchEdge(edge, settings).pipe(Effect.catch((e) => fail(`timeline: ${edge}: ${internal.messageOf(e)}`)))
          }
        } else if (event.account !== undefined) {
          const { placement, settings } = event.account
          yield* sim.patchAccount(placement, settings).pipe(Effect.catch((e) => fail(`timeline: ${placement}: ${internal.messageOf(e)}`)))
        }
      })

    return {
      design: prepared,
      seed: scenario.seed ?? prepared.seed ?? 1,
      duration,
      warmup,
      nextStop: () => (ended ? Infinity : Math.min(events[applied]?.at ?? Infinity, duration)),
      apply: (sim, now) =>
        Effect.gen(function*() {
          while (applied < events.length && events[applied]!.at <= now) {
            const { event, at } = events[applied]!
            applied++
            yield* applyOne(sim, event, at)
          }
        }),
      record: (frames) => checks.record(frames),
      end: () => {
        ended = true
      },
      ended: () => ended,
      progress: (now) => {
        const progress = checks.progress(now)
        const finished = ended || now >= duration
        return {
          ...(scenario.name === undefined ? {} : { name: scenario.name }),
          ...(scenario.description === undefined ? {} : { description: scenario.description }),
          duration,
          warmup,
          t: now,
          finished,
          ...(finished ? { passed: progress.every((c) => c.state === "passed") } : {}),
          timeline: events.map(({ event, at }, i) => ({ at, what: internal.describe(event), kind: internal.kindOf(event), done: i < applied })),
          checks: progress
        }
      },
      results: () => checks.results(),
      log,
      spans
    }
  })

/**
 * Run a scenario against a design, as fast as it goes. The design is checked first (every problem reported, by id),
 * then run on a fresh virtual-time world, stopping at each timeline event to apply it. The result is plain data.
 */
export const run = (design: Design.Doc, scenario: Spec, options: RunOptions = {}): Effect.Effect<Result, ScenarioError, Registry> =>
  Effect.gen(function*() {
    const registry = yield* Registry
    const play = yield* playback(design, scenario, registry)
    const { duration, warmup, seed } = play
    const prepared = play.design

    const decoded = yield* Schema.decodeUnknownEffect(Design.codec(registry))(prepared, { errors: "all" }).pipe(
      Effect.mapError((e) => new ScenarioError(e.message.split("\n").map((l) => l.trim()).filter(Boolean)))
    )
    const started = Date.now()

    const body = Effect.gen(function*() {
      const sim = yield* Simulation.make(decoded, { seed, ...(options.frameMs === undefined ? {} : { frameMs: options.frameMs }) }).pipe(
        Effect.provide(VirtualTime.layer),
        Effect.mapError((e) => new ScenarioError([e.message]))
      )
      const frames: Array<Frame> = []
      const alarms = Alarm.monitor(prepared, registry)
      yield* play.apply(sim, 0)
      while ((yield* sim.now) < duration) {
        const stop = play.nextStop()
        const advanced = yield* sim.advanceTo(stop)
        frames.push(...advanced)
        play.record(advanced)
        alarms.observe(advanced)
        yield* play.apply(sim, stop)
      }
      play.end()
      const defects = yield* sim.defects
      return { frames, defects, alerts: alarms.alerts() }
    })

    const { frames, defects, alerts } = yield* Effect.scoped(body)

    const { system, nodes, edges } = internal.summaries(within(frames, warmup, duration), prepared, registry)
    const assertions = play.results()

    const result: Result = {
      scenario: scenario.name,
      seed,
      duration,
      warmup,
      wallMs: Date.now() - started,
      frameMs: frames.length > 1 ? frames[1]!.t - frames[0]!.t : 250,
      passed: assertions.every((a) => a.passed) && defects.length === 0,
      system,
      nodes,
      edges,
      timeline: play.log,
      faults: play.spans,
      assertions,
      alerts,
      defects: defects.map((d) => ({ t: d.t, node: d.node, message: d.message })),
      diagnostics: [],
      ...(options.keepFrames === true ? { frames } : {})
    }
    return result
  })

/** Seconds helper for callers that format durations. */
export const toSeconds = (ms: number): number => Duration.toSeconds(Duration.millis(ms))
