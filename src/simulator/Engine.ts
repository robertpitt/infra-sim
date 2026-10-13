import { Cause, Clock, Context, Effect, Exit, Fiber, Layer, PubSub, Queue, Ref, Schema, Scope, Stream } from "effect"
import * as Alarm from "./Alarm.ts"
import { type Manifest } from "./Component.ts"
import type * as Connector from "./Connector.ts"
import type * as Controller from "./Controller.ts"
import type * as Describe from "./Describe.ts"
import { Diagnostic, hasErrors } from "./Diagnostic.ts"
import * as Design from "./Design.ts"
import { diagnose } from "./Diagnostics.ts"
import * as Fault from "./Fault.ts"
import { Registry } from "./Registry.ts"
import * as Scenario from "./Scenario.ts"
import * as Simulation from "./Simulation.ts"
import { Frame } from "./Telemetry.ts"
import { VirtualTime } from "./VirtualTime.ts"
import * as internal from "./internal/engine.ts"
import { firstLine, issues } from "./internal/simulation.ts"

/**
 * The engine: what a UI (or a worker, or a server) talks to.
 *
 * It is an actor. Commands go into a queue and are handled one at a time, in order; events come out of a
 * `PubSub` as a `Stream`. Both are `Schema`s, and commands are accepted in their encoded (JSON) form and decoded
 * at the door, so the same protocol works across a function call, a `postMessage`, or a socket.
 *
 * The engine also does the one thing a deterministic simulation can't do for itself: pace virtual time against
 * the real clock, so "play at 5x" is just a loop that sleeps and advances.
 */

// ---------------------------------------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------------------------------------

export const Command = Schema.Union([
  /** Build a fresh simulation from the document, paused at t = 0. */
  Schema.TaggedStruct("load", { design: Design.Doc, seed: Schema.optionalKey(Schema.Int) }),
  Schema.TaggedStruct("play", {}),
  Schema.TaggedStruct("pause", {}),
  /** Rewind to t = 0 with the same document and seed. Faults are cleared. */
  Schema.TaggedStruct("reset", {}),
  /** Virtual seconds per wall-clock second. */
  Schema.TaggedStruct("setSpeed", { speed: Schema.Number }),
  /** Advance a fixed amount of virtual time, useful while paused. */
  Schema.TaggedStruct("step", { ms: Schema.Number }),
  /** Replace a node's (or edge's) settings with a full set of overrides, live. */
  Schema.TaggedStruct("updateNode", { id: Schema.String, settings: Schema.Record(Schema.String, Schema.Unknown) }),
  Schema.TaggedStruct("updateEdge", { id: Schema.String, settings: Schema.Record(Schema.String, Schema.Unknown) }),
  /** Replace the account-level quotas of a placement such as `aws:us-east-1`, live. */
  Schema.TaggedStruct("updateAccount", { placement: Schema.String, settings: Schema.Record(Schema.String, Schema.Unknown) }),
  /** Replace a controller's settings with a full set of overrides, live. */
  Schema.TaggedStruct("updateController", { id: Schema.String, settings: Schema.Record(Schema.String, Schema.Unknown) }),
  Schema.TaggedStruct("inject", { target: Fault.Target, fault: Fault.Fault, durationMs: Schema.optionalKey(Schema.Number) }),
  Schema.TaggedStruct("clearFault", { id: Schema.String }),
  Schema.TaggedStruct("clearFaults", {}),
  /**
   * Play a scenario: its overrides apply, its timeline happens at its times, its assertions are watched, and the run
   * pauses at its end. Starts again from t = 0. A design inside the scenario replaces the document; a path to one is for
   * the host to resolve, and without one the scenario plays against the design already loaded. It stays armed through
   * `load` and `reset` (which start it again) until `clearScenario`.
   */
  Schema.TaggedStruct("scenario", { scenario: Scenario.Scenario }),
  /** Stop playing the scenario: back to the design as it is, from t = 0. */
  Schema.TaggedStruct("clearScenario", {})
])
/** The JSON form of a command: what callers send. */
export type Command = typeof Command.Encoded

export const Phase = Schema.Literals(["empty", "paused", "running", "error"])
export type Phase = typeof Phase.Type

export const Status = Schema.Struct({
  phase: Phase,
  /** Virtual time in ms. */
  t: Schema.Number,
  /** Requested speed. */
  speed: Schema.Number,
  /** Speed actually achieved: lower than requested when the simulation can't keep up. */
  effectiveSpeed: Schema.Number,
  seed: Schema.Number
})
export type Status = typeof Status.Type

const ActiveFaultJson = Schema.toEncoded(Fault.ActiveFault)

/** Everything the engine says. Plain data: nothing here needs Effect to read. */
export const Event = Schema.Union([
  Schema.TaggedStruct("status", { status: Status }),
  Schema.TaggedStruct("frames", { frames: Schema.Array(Frame) }),
  Schema.TaggedStruct("faults", { faults: Schema.Array(ActiveFaultJson) }),
  Schema.TaggedStruct("diagnostics", { diagnostics: Schema.Array(Diagnostic) }),
  /** The alarms watching the run (`Alarm.ts`): firing ones first, then the recently resolved. Sent when they change. */
  Schema.TaggedStruct("alerts", { alerts: Schema.Array(Alarm.Alert) }),
  /** Where the scenario being played stands; no `progress` when none is armed. */
  Schema.TaggedStruct("scenario", { progress: Schema.optionalKey(Scenario.Progress) }),
  /** Time went back to 0 (load or reset): drop any accumulated history. */
  Schema.TaggedStruct("reset", {}),
  /** A command was refused, e.g. a setting outside its range. */
  Schema.TaggedStruct("rejected", { command: Schema.String, issues: Schema.Array(Schema.String) })
])
export type Event = typeof Event.Type

/** Static facts a UI needs once: what components and connectors exist, the transport form, the fault kinds. */
export interface ProviderInfo {
  readonly id: string
  readonly title: string
  readonly defaultRegion: string
  /** Its regions, each with its availability zones (empty for a place with none). */
  readonly regions: ReadonlyArray<{ readonly id: string; readonly name: string; readonly zones: ReadonlyArray<string> }>
  /** The account-level quota form for each region (published defaults differ by region). */
  readonly account: Readonly<Record<string, ReadonlyArray<Describe.FieldSpec>>>
}

export interface Catalog {
  readonly providers: ReadonlyArray<ProviderInfo>
  readonly components: ReadonlyArray<Manifest>
  /** What can sit on an edge. An edge's form is its port's settings, its connector's, then `transport`. */
  readonly connectors: ReadonlyArray<Connector.Manifest>
  /** Transport's settings, which every edge has. */
  readonly transport: ReadonlyArray<Describe.FieldSpec>
  /** What can be attached to a node to change it while it runs. */
  readonly controllers: ReadonlyArray<Controller.Manifest>
  readonly faults: ReadonlyArray<Fault.FaultKind>
}

export class Engine extends Context.Service<Engine, {
  /** Queue a command. Returns as soon as it is queued; its effects show up as events. */
  readonly send: (command: Command) => Effect.Effect<void>
  readonly events: Stream.Stream<Event>
  readonly catalog: Catalog
}>()("simulator/Engine") {
  /** An engine over whatever components the surrounding `Registry` holds. */
  static readonly layer: Layer.Layer<Engine, never, Registry> = Layer.effect(Engine, make())
}

// ---------------------------------------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------------------------------------

export interface Options {
  /** Longest a single tick may spend simulating before yielding to the host. Default 12 ms. */
  readonly budgetMs?: number
  /** Metrics window in virtual ms. Default 250. */
  readonly frameMs?: number
}

const TICK_MS = 16
/** After a long stall (a hidden tab, a debugger) don't try to simulate the whole gap in one go. */
const MAX_WALL_STEP_MS = 100

/** Why the simulation refused a live edit. */
type LiveEditError =
  | Simulation.InvalidConfig
  | Simulation.NoSuchNode
  | Simulation.NoSuchEdge
  | Simulation.NoSuchAccount
  | Simulation.NoSuchController

interface Live {
  readonly sim: Simulation.Service
  readonly scope: Scope.Closeable
  readonly seed: number
  readonly playback: Scenario.Playback | undefined
  readonly alarms: Alarm.Monitor
}

interface State {
  readonly doc: Design.Doc | undefined
  readonly seed: number
  /** The scenario being played, if any. */
  readonly scenario: Scenario.Scenario | undefined
  readonly live: Live | undefined
  readonly phase: Phase
  readonly speed: number
  readonly effective: number
  readonly pacer: Fiber.Fiber<void> | undefined
}

export function make(options: Options = {}) {
  return Effect.gen(function*() {
    const registry = yield* Registry
    const scope = yield* Effect.scope
    const budgetMs = options.budgetMs ?? 12
    const events = yield* PubSub.unbounded<Event>()
    const commands = yield* Queue.unbounded<unknown>()
    const state = yield* Ref.make<State>({
      doc: undefined,
      seed: 1,
      scenario: undefined,
      live: undefined,
      phase: "empty",
      speed: 1,
      effective: 0,
      pacer: undefined
    })
    const emit = (event: Event) => PubSub.publish(events, event)
    const reject = (command: string, issues: ReadonlyArray<string>) => emit({ _tag: "rejected", command, issues })

    const status = Effect.gen(function*() {
      const s = yield* Ref.get(state)
      const t = s.live === undefined ? 0 : yield* s.live.sim.now
      yield* emit({ _tag: "status", status: { phase: s.phase, t, speed: s.speed, effectiveSpeed: s.effective, seed: s.live?.seed ?? s.seed } })
    })

    const stopPacer = Effect.gen(function*() {
      const { pacer } = yield* Ref.get(state)
      if (pacer !== undefined) yield* Fiber.interrupt(pacer)
      yield* Ref.update(state, (s) => ({ ...s, pacer: undefined }))
    })

    const teardown = Effect.gen(function*() {
      yield* stopPacer
      const { live } = yield* Ref.get(state)
      if (live !== undefined) yield* Scope.close(live.scope, Exit.void)
      yield* Ref.update(state, (s) => ({ ...s, live: undefined }))
    })

    /** What the design checks found last, as sent: a live edit only sends them again when they change. */
    let reported = ""
    const report = (diagnostics: ReadonlyArray<Diagnostic>) =>
      Effect.suspend(() => {
        reported = JSON.stringify(diagnostics)
        return emit({ _tag: "diagnostics", diagnostics })
      })

    /**
     * A live edit was applied: keep the engine's copy of the document in step, and check the design again. An edit can
     * fix a problem or make one that the running simulation doesn't see (a controller now names a setting, an account
     * total is now over its quota), so the checks are what a host shows, not the run.
     */
    const edited = (change: (doc: Design.Doc) => Design.Doc) =>
      Effect.gen(function*() {
        const { doc, scenario } = yield* Ref.get(state)
        if (doc === undefined) return
        const next = change(doc)
        yield* Ref.update(state, (s) => ({ ...s, doc: next }))
        const diagnostics = diagnose(running(next, scenario), registry)
        if (JSON.stringify(diagnostics) !== reported) yield* report(diagnostics)
      })

    /** The design as it runs: with a scenario playing, its traffic scale and overrides on top of the document. */
    const running = (doc: Design.Doc, scenario: Scenario.Scenario | undefined): Design.Doc =>
      scenario === undefined ? doc : Scenario.prepare(doc, scenario, registry)

    /**
     * Apply a live edit to the running simulation, then to the document. With a scenario playing, an edit is made to the
     * document and the scenario's overrides stay on top of it, as they were when it started: `pick` finds those settings
     * in the design as it runs (no `pick`: the settings go as given). A refused edit is reported, and changes neither.
     */
    const liveEdit = (
      command: { readonly _tag: string; readonly settings: Record<string, unknown> },
      patch: (doc: Design.Doc) => Design.Doc,
      pick: ((doc: Design.Doc) => Record<string, unknown> | undefined) | undefined,
      apply: (sim: Simulation.Service, settings: Record<string, unknown>) => Effect.Effect<void, LiveEditError>,
      missing: string
    ) =>
      Effect.gen(function*() {
        const { live, doc, scenario } = yield* Ref.get(state)
        if (live === undefined) return
        const { settings } = command
        const asRun = pick === undefined || doc === undefined || scenario === undefined ? settings : (pick(running(patch(doc), scenario)) ?? settings)
        yield* apply(live.sim, asRun).pipe(
          Effect.flatMap(() => edited(patch)),
          Effect.catch((e) => reject(command._tag, e._tag === "InvalidConfig" ? e.issues : [missing]))
        )
      })

    // --- Build ---------------------------------------------------------------------------------------------
    const build = Effect.gen(function*() {
      yield* teardown
      const { doc, seed, scenario } = yield* Ref.get(state)
      if (doc === undefined) return
      // A scenario is checked against the design every time: an edit may have removed something it names.
      let playback: Scenario.Playback | undefined
      if (scenario !== undefined) {
        const made = yield* Effect.result(Scenario.playback(doc, scenario, registry))
        if (made._tag === "Success") playback = made.success
        else {
          yield* Ref.update(state, (s) => ({ ...s, scenario: undefined }))
          yield* reject("scenario", made.failure.issues)
          yield* emit({ _tag: "scenario" })
        }
      }
      const runDoc = playback?.design ?? doc
      const runSeed = playback?.seed ?? seed
      const diagnostics = diagnose(runDoc, registry)
      yield* emit({ _tag: "reset" })
      yield* emit({ _tag: "alerts", alerts: [] })
      if (playback !== undefined) yield* emit({ _tag: "scenario", progress: playback.progress(0) })
      yield* report(diagnostics)
      const fail = (phase: Phase) =>
        Ref.update(state, (s): State => ({ ...s, phase, effective: 0 })).pipe(
          Effect.andThen(emit({ _tag: "faults", faults: [] })),
          Effect.andThen(status)
        )
      if (hasErrors(diagnostics)) return yield* fail("error")

      const design = yield* Schema.decodeUnknownEffect(Design.codec(registry))(runDoc, { errors: "all" }).pipe(Effect.orDie)
      const liveScope = yield* Scope.make()
      const built = yield* Simulation.make(design, { seed: runSeed, ...(options.frameMs === undefined ? {} : { frameMs: options.frameMs }) }).pipe(
        Effect.provide(VirtualTime.layer),
        Scope.provide(liveScope),
        Effect.result
      )
      if (built._tag === "Failure") {
        yield* Scope.close(liveScope, Exit.void)
        yield* report([...diagnostics, { level: "error", code: "make-failed", node: built.failure.node, message: `${built.failure.node}: ${built.failure.message}` }])
        return yield* fail("error")
      }
      const sim = built.success
      // Faults come and go (and expire on their own), so forward every change.
      yield* Effect.forkIn(
        sim.faults.changes.pipe(
          Stream.runForEach((faults) => emit({ _tag: "faults", faults: faults.map((f) => Schema.encodeSync(Fault.ActiveFault)(f)) }))
        ),
        liveScope
      )
      // Anything a scenario does at t = 0 happens before the first frame.
      if (playback !== undefined) yield* playback.apply(sim, 0).pipe(Effect.catch((e) => reject("scenario", e.issues)))
      const alarms = Alarm.monitor(runDoc, registry)
      yield* Ref.update(state, (s): State => ({ ...s, live: { sim, scope: liveScope, seed: runSeed, playback, alarms }, phase: "paused", effective: 0 }))
      yield* status
    })

    // --- Pacing ----------------------------------------------------------------------------------------------
    /**
     * Advance up to `virtualMs`, in slices, stopping early if the wall-clock `deadline` passes. A scenario's events land
     * at exactly their time, and a scenario stops time at its end (`settle` decides what happens then).
     */
    const advanceBy = (live: Live, virtualMs: number, deadline: number) =>
      Effect.gen(function*() {
        const target = (yield* live.sim.now) + virtualMs
        const out: Array<Frame> = []
        const playback = live.playback
        for (;;) {
          const now = yield* live.sim.now
          if (now >= target || (yield* Clock.currentTimeMillis) >= deadline) break
          const stop = playback?.nextStop() ?? Infinity
          if (stop <= now) break
          const until = Math.min(target, now + live.sim.frameMs * 4, stop)
          const frames = yield* live.sim.advanceTo(until)
          out.push(...frames)
          if (playback !== undefined) {
            playback.record(frames)
            if (until === stop) yield* playback.apply(live.sim, until).pipe(Effect.catch((e) => reject("scenario", e.issues)))
          }
        }
        if (out.length > 0 && live.alarms.observe(out)) yield* emit({ _tag: "alerts", alerts: live.alarms.alerts() })
        return out
      })

    /** Tell the host how the scenario is doing. Once it has ended nothing changes, so nothing more is sent. */
    const progress = (live: Live) =>
      Effect.gen(function*() {
        const playback = live.playback
        if (playback === undefined || playback.ended()) return
        yield* emit({ _tag: "scenario", progress: playback.progress(yield* live.sim.now) })
      })

    /** A scenario that has reached its end is decided and reported. True when that just happened: time should stop there. */
    const settle = (live: Live) =>
      Effect.gen(function*() {
        const playback = live.playback
        if (playback === undefined || playback.ended()) return false
        const now = yield* live.sim.now
        if (now < playback.duration) return false
        playback.end()
        yield* emit({ _tag: "scenario", progress: playback.progress(now) })
        return true
      })

    const pace = Effect.gen(function*() {
      let last = yield* Clock.currentTimeMillis
      let lastStatus = -Infinity
      for (;;) {
        yield* Effect.sleep(TICK_MS)
        const s = yield* Ref.get(state)
        if (s.phase !== "running" || s.live === undefined) return
        const wall = yield* Clock.currentTimeMillis
        const elapsed = Math.min(wall - last, MAX_WALL_STEP_MS)
        last = wall
        const before = yield* s.live.sim.now
        const frames = yield* advanceBy(s.live, elapsed * s.speed, wall + budgetMs)
        const advanced = (yield* s.live.sim.now) - before
        if (elapsed > 0) {
          yield* Ref.update(state, (x) => ({ ...x, effective: x.effective === 0 ? advanced / elapsed : x.effective * 0.8 + (advanced / elapsed) * 0.2 }))
        }
        if (frames.length > 0) yield* emit({ _tag: "frames", frames })
        if (yield* settle(s.live)) {
          // The scenario is over: stop here, so its end is where the run rests. Playing again carries on past it.
          yield* Ref.update(state, (x): State => ({ ...x, phase: "paused", effective: 0, pacer: undefined }))
          return yield* status
        }
        if ((yield* Clock.currentTimeMillis) - lastStatus >= 100) {
          lastStatus = yield* Clock.currentTimeMillis
          yield* status
          yield* progress(s.live)
        }
      }
    })

    const play = Effect.gen(function*() {
      const s = yield* Ref.get(state)
      if (s.live === undefined || s.phase === "running") return
      // A crash in the pacing loop is reported, not swallowed.
      const pacer = yield* Effect.forkIn(
        pace.pipe(
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.void : reject("play", [firstLine(cause, "pacing loop crashed")])
          )
        ),
        scope
      )
      yield* Ref.update(state, (x): State => ({ ...x, phase: "running", pacer }))
      yield* status
    })

    const pause = Effect.gen(function*() {
      if ((yield* Ref.get(state)).phase !== "running") return
      yield* stopPacer
      yield* Ref.update(state, (s): State => ({ ...s, phase: "paused", effective: 0 }))
      yield* status
    })

    // --- Commands --------------------------------------------------------------------------------------------
    const handle = (input: unknown) =>
      Effect.gen(function*() {
        const decoded = yield* Effect.result(Schema.decodeUnknownEffect(Command)(input))
        if (decoded._tag === "Failure") {
          const tag = typeof input === "object" && input !== null && "_tag" in input ? String(input._tag) : "unknown"
          return yield* reject(tag, issues(decoded.failure.message))
        }
        const command = decoded.success
        const { live } = yield* Ref.get(state)
        switch (command._tag) {
          case "load": {
            // A design loaded while the simulation is running keeps running: it is the same session, a new design.
            const wasRunning = (yield* Ref.get(state)).phase === "running"
            yield* Ref.update(state, (s) => ({ ...s, doc: command.design, seed: command.seed ?? command.design.seed ?? 1 }))
            yield* build
            if (wasRunning) yield* play
            return
          }
          case "reset": {
            const wasRunning = (yield* Ref.get(state)).phase === "running"
            yield* build
            if (wasRunning) yield* play
            return
          }
          case "play":
            return yield* play
          case "pause":
            return yield* pause
          case "setSpeed":
            yield* Ref.update(state, (s) => ({ ...s, speed: Math.max(0.01, command.speed) }))
            return yield* status
          case "step": {
            if (live === undefined) return
            const frames = yield* advanceBy(live, command.ms, Infinity)
            if (frames.length > 0) yield* emit({ _tag: "frames", frames })
            if (!(yield* settle(live))) yield* progress(live)
            return yield* status
          }
          case "updateNode": {
            const { id, settings } = command
            const patch = (d: Design.Doc) => Design.patchNode(d, id, { settings })
            return yield* liveEdit(command, patch, (d) => d.nodes[id]?.settings, (sim, s) => sim.configureNode(id, s), `No node "${id}"`)
          }
          case "updateEdge": {
            const { id, settings } = command
            const patch = (d: Design.Doc) => internal.withEdgeSettings(d, id, settings)
            return yield* liveEdit(command, patch, (d) => d.edges[id]?.settings, (sim, s) => sim.configureEdge(id, s), `No edge "${id}"`)
          }
          case "updateAccount": {
            const { placement, settings } = command
            const patch = (d: Design.Doc) => internal.withAccount(d, placement, settings)
            const missing = `No account for "${placement}" in this design`
            return yield* liveEdit(command, patch, (d) => d.accounts?.[placement], (sim, s) => sim.configureAccount(placement, s), missing)
          }
          case "updateController": {
            const { id, settings } = command
            const patch = (d: Design.Doc) => internal.withControllerSettings(d, id, settings)
            // A scenario doesn't override a controller's settings: they go to the simulation as given.
            return yield* liveEdit(command, patch, undefined, (sim, s) => sim.configureController(id, s), `No controller "${id}"`)
          }
          case "inject": {
            if (live === undefined) return
            const kind = Fault.catalog.find((k) => k.tag === command.fault._tag)
            if (kind !== undefined && !kind.targets.includes(command.target.kind)) {
              return yield* reject("inject", [`"${command.fault._tag}" cannot be applied to a ${command.target.kind}`])
            }
            return yield* live.sim.faults.inject(command.target, command.fault, command.durationMs).pipe(
              Effect.asVoid,
              Effect.catch(() => reject("inject", [`No ${command.target.kind} "${command.target.id}" in this design`]))
            )
          }
          case "clearFault":
            if (live !== undefined) yield* live.sim.faults.clear(command.id)
            return
          case "clearFaults":
            if (live !== undefined) yield* live.sim.faults.clearAll
            return
          case "scenario": {
            const s = yield* Ref.get(state)
            const spec = command.scenario
            const doc = typeof spec.design === "object" ? spec.design : s.doc
            if (doc === undefined) return yield* reject("scenario", ["Load a design first, or put one in the scenario"])
            // Checked before anything is torn down, so a scenario that can't play leaves the run as it was.
            const made = yield* Effect.result(Scenario.playback(doc, spec, registry))
            if (made._tag === "Failure") return yield* reject("scenario", made.failure.issues)
            const wasRunning = s.phase === "running"
            yield* Ref.update(state, (x) => ({ ...x, doc, scenario: spec, ...(typeof spec.design === "object" ? { seed: doc.seed ?? 1 } : {}) }))
            yield* build
            if (wasRunning) yield* play
            return
          }
          case "clearScenario": {
            const s = yield* Ref.get(state)
            if (s.scenario === undefined) return
            yield* Ref.update(state, (x) => ({ ...x, scenario: undefined }))
            yield* emit({ _tag: "scenario" })
            yield* build
            if (s.phase === "running") yield* play
          }
        }
      })

    // One consumer, so commands are handled strictly in the order they were sent.
    yield* Effect.forkIn(Effect.forever(Queue.take(commands).pipe(Effect.flatMap(handle))), scope)
    yield* Effect.addFinalizer(() => teardown)

    return Engine.of({
      send: (command) => Queue.offer(commands, command).pipe(Effect.asVoid),
      events: Stream.fromPubSub(events),
      catalog: internal.catalog(registry)
    })
  })
}
