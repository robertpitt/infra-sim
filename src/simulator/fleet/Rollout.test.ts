import { Duration, Effect, Schema, type Scope, Stream, SubscriptionRef } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../Builder.ts"
import * as Component from "../Component.ts"
import { builtins, providers } from "../components/registry.ts"
import type * as Design from "../Design.ts"
import { codec } from "../Design.ts"
import { type Call, type CallFailure, type Reply, Unavailable } from "../Message.ts"
import * as Registry from "../Registry.ts"
import * as Setting from "../Setting.ts"
import * as Simulation from "../Simulation.ts"
import type { Frame } from "../Telemetry.ts"
import { VirtualTime } from "../VirtualTime.ts"
import { Fleet, type Job } from "./Fleet.ts"
import { Rollout } from "./Rollout.ts"

/** A fleet whose units carry a version, rolled by a `Rollout` within percentages of the desired count (ECS's). */
const Versioned = Component.make({
  type: "test.versioned",
  title: "Versioned",
  category: "compute",
  config: Schema.Struct({
    desired: Setting.int({ default: 4, min: 0, max: 100 }),
    version: Setting.int({ default: 1, min: 1, max: 100 }),
    minPercent: Setting.int({ default: 100, min: 0, max: 100 }),
    maxPercent: Setting.int({ default: 200, min: 100, max: 400 }),
    launch: Setting.duration({ default: "10 seconds", min: 0, max: "1 hour" }),
    healthyAfter: Setting.duration({ default: "20 seconds", min: 0, max: "1 hour" }),
    zones: Setting.int({ default: 0, min: 0, max: 3 }),
    inKind: Setting.bool({ default: false })
  }),
  ports: {},
  state: Schema.Struct({ rolling: Schema.Boolean, old: Schema.Number, fresh: Schema.Number, stopped: Schema.Number, completed: Schema.Number }),
  make: (node) =>
    Effect.gen(function*() {
      const { fast } = node
      const s = () => fast.settings()
      const rollout = new Rollout({
        version: () => s().version,
        desired: () => s().desired,
        maxTotal: (d) => Math.floor((d * s().maxPercent) / 100),
        minHealthy: (d) => Math.ceil((d * s().minPercent) / 100),
        healthyAfter: () => Duration.toMillis(s().healthyAfter),
        now: fast.now,
        after: fast.after,
        replaceInKind: s().inKind
      })
      const fleet = new Fleet(node, {
        desired: () => rollout.target(),
        phases: (unit) => {
          rollout.stamp(unit)
          return [{ name: "launch", ms: Duration.toMillis(s().launch) }]
        },
        workers: () => 10,
        line: () => 100,
        backlog: () => 100,
        drain: () => 30_000,
        zones: () => node.zones.all.slice(0, s().zones),
        detect: () => 5_000,
        name: (id) => `u${id}`
      })
      rollout.attach(fleet)
      yield* node.spawn(SubscriptionRef.changes(node.config).pipe(Stream.runForEach(() =>
        Effect.sync(() => {
          rollout.step()
          fleet.refresh()
        })
      )))
      const count = (fresh: boolean, healthy: boolean) => () => {
        let n = 0
        for (const u of fleet.units) {
          const live = u.state !== "draining" && u.state !== "terminated"
          if (live && (rollout.versionOf(u) === s().version) === fresh && (!healthy || rollout.healthy(u))) n++
        }
        return n
      }
      node.meter.gaugeUnsafe("old", count(false, false))
      node.meter.gaugeUnsafe("fresh", count(true, false))
      node.meter.gaugeUnsafe("healthy", () => count(false, true)() + count(true, true)())
      node.meter.gaugeUnsafe("live", () => count(false, false)() + count(true, false)())
      const handle = (): Call =>
        Effect.callback<Reply, CallFailure>((resume) => {
          const job: Job = {
            start: (ticket) => void fast.after(50, () => {
              ticket.finish()
              resume(Effect.void)
            }, undefined),
            fail: (failure) => resume(Effect.fail(failure))
          }
          const admitted = fleet.admit(job)
          if (typeof admitted === "string") resume(Effect.fail(Unavailable({ node: node.id, reason: admitted })))
          return Effect.void
        })
      return {
        call: () => handle(),
        probe: Effect.sync(() => {
          const st = rollout.status()
          return { rolling: st.rolling, old: st.old, fresh: st.fresh, stopped: rollout.totals.stopped, completed: rollout.totals.completed }
        })
      }
    })
})

const components = [...builtins, Versioned]
const registry = Registry.make(components, providers)
const start = (doc: Design.Doc): Effect.Effect<Simulation.Service, never, Scope.Scope> =>
  Effect.gen(function*() {
    const design = yield* Schema.decodeUnknownEffect(codec(registry))(doc, { errors: "all" }).pipe(Effect.orDie)
    return yield* Simulation.make(design).pipe(Effect.provide(VirtualTime.layer), Effect.provide(Registry.Registry.layer(components, providers)), Effect.orDie)
  })
const sim = <A, E>(doc: Design.Doc, body: (sim: Simulation.Service) => Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(start(doc), body)))

const design = (settings: Record<string, unknown>) => {
  const b = Builder.make("rollout", { seed: 3 })
  const web = b.add("common.client", { id: "web", region: "eu-west", settings: { rps: 50, arrival: "constant" } })
  const v = b.add("test.versioned", { id: "v", region: "eu-west", settings })
  b.connect(web, v, { timeout: "1 minute" })
  return b.build()
}

const series = (all: ReadonlyArray<Frame>, name: string) => all.map((f) => f.nodes.v!.gauges[name]!)
type Status = { rolling: boolean; old: number; fresh: number; stopped: number; completed: number }

describe("a rolling replacement", () => {
  it("with 100% healthy and 200% at most: starts all the new units, and stops an old one as each new one is healthy", () =>
    sim(design({ desired: 4 }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(5_000)
        yield* s.configureNode("v", { desired: 4, version: 2 })
        const all = yield* s.advanceTo(120_000)
        // Four new units launch at once (8 live at most), up at 15 s, healthy at 35 s; then the old ones go.
        expect(Math.max(...series(all, "live"))).toBe(8)
        expect(Math.min(...series(all, "healthy"))).toBe(4)
        const st = (yield* s.probe("v")).state as Status
        expect(st).toMatchObject({ rolling: false, old: 0, fresh: 4, stopped: 4, completed: 1 })
        expect(all.find((f) => f.t >= 30_000 && f.t < 34_000)!.nodes.v!.gauges.old).toBe(4)
        expect(all.find((f) => f.t >= 36_000)!.nodes.v!.gauges.old).toBe(0)
      })))

  it("with 50% healthy and 100% at most: stops half the old units at once, and never runs more than the desired count", () =>
    sim(design({ desired: 4, minPercent: 50, maxPercent: 100 }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(5_000)
        yield* s.configureNode("v", { desired: 4, version: 2, minPercent: 50, maxPercent: 100 })
        const all = yield* s.advanceTo(120_000)
        expect(Math.max(...series(all, "live"))).toBe(4)
        expect(Math.min(...series(all, "healthy").slice(1))).toBe(2)
        // Two rounds: two new units are healthy at 35 s, which keeps two healthy while both remaining old ones stop; the
        // last two new ones are healthy at 65 s.
        expect(((yield* s.probe("v")).state as Status)).toMatchObject({ rolling: false, old: 0, fresh: 4 })
        const at40 = all.find((f) => f.t >= 40_000)!.nodes.v!.gauges
        expect([at40.old, at40.fresh, at40.healthy]).toEqual([0, 4, 2])
      })))

  it("with 100% healthy and 100% at most it can't make room, and nothing changes", () =>
    sim(design({ desired: 4, maxPercent: 100 }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(5_000)
        yield* s.configureNode("v", { desired: 4, version: 2, maxPercent: 100 })
        yield* s.advanceTo(120_000)
        expect(((yield* s.probe("v")).state as Status)).toMatchObject({ rolling: true, old: 4, fresh: 0, stopped: 0 })
      })))

  it("follows the desired count when it changes during the rollout", () =>
    sim(design({ desired: 4 }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(5_000)
        yield* s.configureNode("v", { desired: 4, version: 2 })
        yield* s.advanceTo(20_000)
        yield* s.configureNode("v", { desired: 6, version: 2 })
        const all = yield* s.advanceTo(150_000)
        expect(((yield* s.probe("v")).state as Status)).toMatchObject({ rolling: false, old: 0, fresh: 6 })
        expect(series(all, "live").at(-1)).toBe(6)
      })))

  it("replacing in kind, an old unit lost during a stalled rollout comes back old (a ReplicaSet recreating its pod)", async () => {
    // Four units over three zones (a, b, c, a). Version 2 never becomes healthy; 75% healthy and 125% at most: three old
    // and two new. Zone a then fails, taking an old and a new unit; each is replaced 5 s later.
    const run = (inKind: boolean) => {
      const base = { desired: 4, zones: 3, minPercent: 75, maxPercent: 125, healthyAfter: "1 hour", inKind }
      return sim(design(base), (s) =>
        Effect.gen(function*() {
          yield* s.advanceTo(5_000)
          yield* s.configureNode("v", { ...base, version: 2 })
          yield* s.advanceTo(30_000)
          expect(((yield* s.probe("v")).state as Status)).toMatchObject({ old: 3, fresh: 2 })
          yield* s.faults.inject({ kind: "zone", id: "internet:eu-west:eu-west-a" }, { _tag: "Outage" })
          yield* s.advanceTo(60_000)
          return (yield* s.probe("v")).state as Status
        }))
    }
    expect(await run(true)).toMatchObject({ rolling: true, old: 3, fresh: 2 })
    // Without it (ECS), the replacement runs the new version.
    expect(await run(false)).toMatchObject({ rolling: true, old: 2, fresh: 3 })
  })
})
