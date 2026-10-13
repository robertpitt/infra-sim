import { Duration, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../Builder.ts"
import * as Component from "../Component.ts"
import { registry } from "../components/Builtins.ts"
import * as Connector from "../Connector.ts"
import * as Edge from "../Edge.ts"
import { Unavailable } from "../Message.ts"
import type { Provider } from "../Provider.ts"
import * as Setting from "../Setting.ts"
import { mean, sim, simulator } from "../testing.ts"

/** What `test.multi-az` offers the connectors on edges into it: a ledger its clients sign. */
interface Ledger {
  readonly kind: "ledger"
  readonly sign: (who: string) => void
}
const isLedger = (u: unknown): u is Ledger => typeof u === "object" && u !== null && (u as { kind?: unknown }).kind === "ledger"

/**
 * A Multi-AZ resource: it lives in one zone (its primary's) with a standby in another. It handles its zone's faults
 * itself: when its zone goes down it fails over, unavailable for `failover`, then serves from the standby. It also sees
 * an outage on itself begin and end.
 */
const MultiAz = Component.make({
  type: "test.multi-az",
  title: "Multi-AZ",
  category: "storage",
  handlesZoneFaults: true,
  config: Schema.Struct({ failover: Setting.duration({ default: "30 seconds", min: 0, max: "10 minutes" }) }),
  ports: {},
  state: Schema.Struct({ failovers: Schema.Number, outagesSeen: Schema.Number, signed: Schema.Array(Schema.String), counter: Schema.Number, reaching: Schema.Array(Schema.String) }),
  make: (node) =>
    Effect.gen(function*() {
      const { fast } = node
      let failovers = 0
      let outagesSeen = 0
      let unavailableUntil = -1
      let zoneDown = false
      let outage = false
      const signed: Array<string> = []
      const counter = yield* node.shared("counter", Effect.sync(() => ({ n: 0 })))
      node.faults.watch(() => {
        const z = node.faults.zone().outage
        if (z && !zoneDown) {
          failovers++
          unavailableUntil = fast.now() + Duration.toMillis(fast.settings().failover)
        }
        zoneDown = z
        const o = node.faults.own().outage
        if (o && !outage) outagesSeen++
        outage = o
      })
      return {
        call: () => (fast.now() < unavailableUntil ? Effect.fail(Unavailable({ node: node.id, reason: "failing over" })) : Effect.void),
        offer: { kind: "ledger", sign: (who: string) => void signed.push(who) } satisfies Ledger,
        probe: Effect.sync(() => ({ failovers, outagesSeen, signed: [...signed], counter: counter.n, reaching: node.faults.active().map((f) => `${f.target.kind}:${f.target.id}`) }))
      }
    })
})

/** A connector that signs its target's ledger and counts itself in a resource shared in its target's placement. */
const Signer = Connector.make({
  type: "test.signer",
  provider: "test",
  title: "Signer",
  from: { protocol: "invoke" },
  to: { protocol: "invoke", component: "test.multi-az" },
  config: Edge.Policy,
  make: (ctx) =>
    Effect.gen(function*() {
      const ledger = ctx.offer()
      if (isLedger(ledger)) ledger.sign(ctx.id)
      const counter = yield* ctx.shared("counter", Effect.sync(() => ({ n: 0 })))
      counter.n++
      return { send: (message, done) => ctx.sink.call(message, Edge.policyOf(ctx.fast.settings()), done) }
    })
})

const testProvider: Provider = { id: "test", title: "Test", regions: [], defaultRegion: "", account: () => Schema.Struct({}), connectors: [Signer] }
/** The built-ins plus the test component and provider. */
const { sim: run } = simulator([MultiAz], [testProvider])

const design = () => {
  const b = Builder.make("multi-az", { seed: 2 })
  const web = b.add("common.client", { id: "web", region: "eu-west", settings: { rps: 100, arrival: "constant" } })
  const db = b.add("test.multi-az", { id: "db", region: "eu-west", zone: "eu-west-a", settings: { failover: 30_000 } })
  b.connect(web, db, {}, { id: "e" })
  return b.build()
}

describe("what a node can see of its faults", () => {
  it("a component that handles its zone's faults keeps serving through its zone's outage, after failing over", () =>
    run(design(), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(10_000)
        yield* s.faults.inject({ kind: "zone", id: "internet:eu-west:eu-west-a" }, { _tag: "Outage" })
        const all = yield* s.advanceTo(80_000)
        // Not refused by the engine: the component fails over for 30 s, then serves though its zone is still down.
        expect(mean(all, "nodes", "db", "rates", "fail", 11_000, 39_750)).toBeCloseTo(100, -1)
        expect(mean(all, "nodes", "db", "rates", "ok", 41_000)).toBeCloseTo(100, -1)
        expect(((yield* s.probe("db")).state as { failovers: number }).failovers).toBe(1)
      })))

  it("sees an outage on itself begin and end, and lists what reaches it", () =>
    run(design(), (s) =>
      Effect.gen(function*() {
        yield* s.faults.inject({ kind: "node", id: "db" }, { _tag: "Outage" }, 5_000)
        yield* s.advanceTo(10_000)
        yield* s.faults.inject({ kind: "node", id: "db" }, { _tag: "Outage" }, 5_000)
        const all = yield* s.advanceTo(20_000)
        expect(((yield* s.probe("db")).state as { outagesSeen: number }).outagesSeen).toBe(2)
        // An outage on the node itself is still refused by the engine, whoever handles zones.
        expect(mean(all, "nodes", "db", "rates", "ok", 11_000, 14_750)).toBe(0)
        yield* s.faults.inject({ kind: "zone", id: "internet:eu-west:eu-west-a" }, { _tag: "Slow", extra: Duration.millis(5) })
        yield* s.faults.inject({ kind: "zone", id: "internet:eu-west:eu-west-b" }, { _tag: "Outage" })
        yield* s.faults.inject({ kind: "region", id: "internet:eu-west" }, { _tag: "Errors", rate: 0.1 })
        // Its zone's and its region's reach it; another zone's doesn't.
        expect(((yield* s.probe("db")).state as { reaching: ReadonlyArray<string> }).reaching).toEqual(["region:internet:eu-west", "zone:internet:eu-west:eu-west-a"])
      })))

  it("lets the connector on an edge reach what its target offers, and share a resource in the target's placement", () =>
    run(design(), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(1_000)
        const state = (yield* s.probe("db")).state as { signed: ReadonlyArray<string>; counter: number }
        expect(state.signed).toEqual(["e"])
        // The node built it; the connector found the same one.
        expect(state.counter).toBe(1)
      })))
})

describe("global components", () => {
  it("a region's outage doesn't reach a global component placed in it, only what is regional there", async () => {
    const b = Builder.make("global", { seed: 3 })
    const box = b.add("aws.region", { id: "us", settings: { region: "us-east-1" } })
    const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 50 } })
    const cdn = b.add("aws.cloudfront", { id: "cdn", parent: box, settings: { objects: 1 } })
    const origin = b.add("common.http-endpoint", { id: "origin", settings: { latency: { mean: 5, cv: 0 } } })
    const api = b.add("aws.apigateway", { id: "api", parent: box })
    b.connect(web, cdn, { weight: 1, request: { operation: "read" } })
    b.connect(cdn, origin, { request: { operation: "read" } })
    b.connect(web, api, { weight: 1 })
    b.connect(api, origin)
    expect(registry.get("aws.cloudfront")!.global).toBe(true)
    const all = await sim(b.build(), (s) =>
      Effect.gen(function*() {
        yield* s.faults.inject({ kind: "region", id: "aws:us-east-1" }, { _tag: "Outage" })
        return yield* s.advanceTo(20_000)
      }))
    expect(mean(all, "nodes", "cdn", "rates", "fail", 5_000)).toBe(0)
    expect(mean(all, "nodes", "cdn", "rates", "ok", 5_000)).toBeGreaterThan(20)
    expect(mean(all, "nodes", "api", "rates", "fail", 5_000)).toBeGreaterThan(20)
  })
})
