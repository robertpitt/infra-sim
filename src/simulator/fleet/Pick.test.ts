import { Effect, Schema, type Scope, Stream, SubscriptionRef } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../Builder.ts"
import * as Component from "../Component.ts"
import { builtins, providers } from "../components/registry.ts"
import type * as Design from "../Design.ts"
import { codec } from "../Design.ts"
import * as Registry from "../Registry.ts"
import * as Setting from "../Setting.ts"
import * as Simulation from "../Simulation.ts"
import { VirtualTime } from "../VirtualTime.ts"
import { Fleet } from "./Fleet.ts"

/**
 * `Options.pick`: a component's own choice of which unit scale-in lets go, once the zone is chosen. `test.picked` keeps
 * its units' names in a probe and picks the candidate whose name the `victim` setting names, if it is one.
 */
const Picked = Component.make({
  type: "test.picked",
  title: "Picked",
  category: "compute",
  config: Schema.Struct({
    desired: Setting.int({ default: 6, min: 0, max: 100 }),
    zones: Setting.int({ default: 0, min: 0, max: 3 }),
    victim: Setting.text({ default: "" })
  }),
  ports: {},
  state: Schema.Struct({ units: Schema.Array(Schema.String), offered: Schema.Array(Schema.Array(Schema.String)) }),
  make: (node) =>
    Effect.gen(function*() {
      const offered: Array<Array<string>> = []
      const fleet = new Fleet(node, {
        desired: () => node.fast.settings().desired,
        zones: () => node.zones.all.slice(0, node.fast.settings().zones),
        phases: () => [],
        workers: () => 1,
        line: () => 0,
        backlog: () => 0,
        name: (id) => `u${id}`,
        pick: (candidates) => {
          offered.push(candidates.map((u) => u.name))
          return candidates.find((u) => u.name === node.fast.settings().victim)
        }
      })
      yield* node.spawn(SubscriptionRef.changes(node.config).pipe(Stream.runForEach(() => Effect.sync(() => fleet.refresh()))))
      return { probe: Effect.sync(() => ({ units: fleet.units.filter((m) => m.live).map((m) => m.name), offered })) }
    })
})

const start = (doc: Design.Doc): Effect.Effect<Simulation.Service, never, Scope.Scope> =>
  Effect.gen(function*() {
    const design = yield* Schema.decodeUnknownEffect(codec(Registry.make([...builtins, Picked], providers)))(doc, { errors: "all" }).pipe(Effect.orDie)
    return yield* Simulation.make(design).pipe(Effect.provide(VirtualTime.layer), Effect.provide(Registry.Registry.layer([...builtins, Picked], providers)), Effect.orDie)
  })

const scaleIn = (settings: Record<string, unknown>, after: Record<string, unknown>) => {
  const b = Builder.make("pick", { seed: 1 })
  b.add("test.picked", { id: "p", region: "eu-west", settings })
  return Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(start(b.build()), (s) =>
        Effect.gen(function*() {
          yield* s.advanceTo(1_000)
          yield* s.configureNode("p", after)
          yield* s.advanceTo(2_000)
          return (yield* s.probe("p")).state as { units: ReadonlyArray<string>; offered: ReadonlyArray<ReadonlyArray<string>> }
        })
      )
    )
  )
}

describe("a fleet's own scale-in choice (Options.pick)", () => {
  it("lets go of the unit the component picks rather than the newest", async () => {
    const state = await scaleIn({ desired: 4 }, { desired: 3, victim: "u2" })
    expect(state.units).toEqual(["u1", "u3", "u4"])
    expect(state.offered[0]).toEqual(["u1", "u2", "u3", "u4"])
  })

  it("offers only the fullest zone's units, so zones still come first", async () => {
    // Five units over three zones: a has u1 and u4, b u2 and u5, c u3. Zone a is the fullest first.
    const state = await scaleIn({ desired: 5, zones: 3 }, { desired: 4, zones: 3, victim: "u2" })
    expect(state.offered[0]).toEqual(["u1", "u4"])
    // u2 isn't in zone a, so the fleet falls back to its own rule: the newest there.
    expect(state.units).toEqual(["u1", "u2", "u3", "u5"])
  })
})
