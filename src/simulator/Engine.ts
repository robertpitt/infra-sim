import { Cause, Clock, Context, Effect, Exit, Fiber, Layer, PubSub, Queue, Ref, Schema, Scope, Stream } from "effect"
import { type Manifest } from "./Component.ts"
import * as Connector from "./Connector.ts"
import type * as Controller from "./Controller.ts"
import * as Describe from "./Describe.ts"
import { Diagnostic, hasErrors } from "./Diagnostic.ts"
import * as Design from "./Design.ts"
import { diagnose } from "./Diagnostics.ts"
import * as Fault from "./Fault.ts"
import { Registry } from "./Registry.ts"
import * as Simulation from "./Simulation.ts"
import { Frame } from "./Telemetry.ts"
import { VirtualTime } from "./VirtualTime.ts"

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
  Schema.TaggedStruct("clearFaults", {})
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
  readonly regions: ReadonlyArray<{ readonly id: string; readonly name: string }>
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

interface Live {
  readonly sim: Simulation.Service
  readonly scope: Scope.Closeable
}

interface State {
  readonly doc: Design.Doc | undefined
  readonly seed: number
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
      yield* emit({ _tag: "status", status: { phase: s.phase, t, speed: s.speed, effectiveSpeed: s.effective, seed: s.seed } })
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
        const { doc } = yield* Ref.get(state)
        if (doc === undefined) return
        const next = change(doc)
        yield* Ref.update(state, (s) => ({ ...s, doc: next }))
        const diagnostics = diagnose(next, registry)
        if (JSON.stringify(diagnostics) !== reported) yield* report(diagnostics)
      })

    // --- Build ---------------------------------------------------------------------------------------------
    const build = Effect.gen(function*() {
      yield* teardown
      const { doc, seed } = yield* Ref.get(state)
      if (doc === undefined) return
      const diagnostics = diagnose(doc, registry)
      yield* emit({ _tag: "reset" })
      yield* report(diagnostics)
      const fail = (phase: Phase) =>
        Ref.update(state, (s): State => ({ ...s, phase, effective: 0 })).pipe(
          Effect.andThen(emit({ _tag: "faults", faults: [] })),
          Effect.andThen(status)
        )
      if (hasErrors(diagnostics)) return yield* fail("error")

      const design = yield* Schema.decodeUnknownEffect(Design.codec(registry))(doc, { errors: "all" }).pipe(Effect.orDie)
      const liveScope = yield* Scope.make()
      const built = yield* Simulation.make(design, { seed, ...(options.frameMs === undefined ? {} : { frameMs: options.frameMs }) }).pipe(
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
      yield* Ref.update(state, (s): State => ({ ...s, live: { sim, scope: liveScope }, phase: "paused", effective: 0 }))
      yield* status
    })

    // --- Pacing ----------------------------------------------------------------------------------------------
    /** Advance up to `virtualMs`, in slices, stopping early if the wall-clock `deadline` passes. */
    const advanceBy = (live: Live, virtualMs: number, deadline: number) =>
      Effect.gen(function*() {
        const target = (yield* live.sim.now) + virtualMs
        const out: Array<Frame> = []
        for (;;) {
          const now = yield* live.sim.now
          if (now >= target || (yield* Clock.currentTimeMillis) >= deadline) break
          out.push(...(yield* live.sim.advanceTo(Math.min(target, now + live.sim.frameMs * 4))))
        }
        return out
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
        if ((yield* Clock.currentTimeMillis) - lastStatus >= 100) {
          lastStatus = yield* Clock.currentTimeMillis
          yield* status
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
            Cause.hasInterruptsOnly(cause) ? Effect.void : reject("play", [Cause.pretty(cause).split("\n")[0] ?? "pacing loop crashed"])
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
          return yield* reject(tag, decoded.failure.message.split("\n").map((l) => l.trim()).filter(Boolean))
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
            return yield* status
          }
          case "updateNode":
            if (live === undefined) return
            return yield* live.sim.configureNode(command.id, command.settings).pipe(
              Effect.flatMap(() => edited((d) => Design.patchNode(d, command.id, { settings: command.settings }))),
              Effect.catch((e) => reject(command._tag, e._tag === "InvalidConfig" ? e.issues : [`No node "${command.id}"`]))
            )
          case "updateEdge":
            if (live === undefined) return
            return yield* live.sim.configureEdge(command.id, command.settings).pipe(
              Effect.flatMap(() => edited((d) => (d.edges[command.id] === undefined ? d : { ...d, edges: { ...d.edges, [command.id]: { ...d.edges[command.id]!, settings: command.settings } } }))),
              Effect.catch((e) => reject(command._tag, e._tag === "InvalidConfig" ? e.issues : [`No edge "${command.id}"`]))
            )
          case "updateAccount":
            if (live === undefined) return
            return yield* live.sim.configureAccount(command.placement, command.settings).pipe(
              Effect.flatMap(() => edited((d) => ({ ...d, accounts: { ...d.accounts, [command.placement]: command.settings } }))),
              Effect.catch((e) => reject(command._tag, e._tag === "InvalidConfig" ? e.issues : [`No account for "${command.placement}" in this design`]))
            )
          case "updateController":
            if (live === undefined) return
            return yield* live.sim.configureController(command.id, command.settings).pipe(
              Effect.flatMap(() =>
                edited((d) => {
                  const c = d.controllers?.[command.id]
                  return c === undefined ? d : { ...d, controllers: { ...d.controllers, [command.id]: { ...c, settings: command.settings } } }
                })
              ),
              Effect.catch((e) => reject(command._tag, e._tag === "InvalidConfig" ? e.issues : [`No controller "${command.id}"`]))
            )
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
        }
      })

    // One consumer, so commands are handled strictly in the order they were sent.
    yield* Effect.forkIn(Effect.forever(Queue.take(commands).pipe(Effect.flatMap(handle))), scope)
    yield* Effect.addFinalizer(() => teardown)

    return Engine.of({
      send: (command) => Queue.offer(commands, command).pipe(Effect.asVoid),
      events: Stream.fromPubSub(events),
      catalog: {
        providers: registry.providers.map((p) => ({
          id: p.id,
          title: p.title,
          defaultRegion: p.defaultRegion,
          regions: p.regions.map((r) => ({ id: r.id, name: r.name })),
          account: Object.fromEntries(p.regions.map((r) => [r.id, Describe.fields(p.account(r.id))]))
        })),
        components: registry.manifests,
        connectors: registry.connectorManifests,
        transport: Connector.transportFields(),
        controllers: registry.controllerManifests,
        faults: Fault.catalog
      }
    })
  })
}
