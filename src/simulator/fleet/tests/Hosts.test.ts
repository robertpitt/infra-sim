import { Duration, Effect, Schema, Stream, SubscriptionRef } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../../Builder.ts"
import * as Component from "../../Component.ts"
import { mean, simulator } from "../../testing.ts"
import * as Setting from "../../Setting.ts"
import * as Simulation from "../../Simulation.ts"
import type { Frame } from "../../Telemetry.ts"
import { Fleet } from "../Fleet.ts"
import { HostPool } from "../Hosts.ts"
import { served } from "../testing.ts"

/**
 * A fleet of tenants on a fleet of hosts, as ECS on EC2 and EKS build them: `test.hosted`. Each host has 2 vCPUs and
 * 4096 MiB; each tenant asks for 1 vCPU and 1024 MiB unless told otherwise, so a host holds two.
 */
const HostedConfig = Schema.Struct({
  hosts: Setting.int({ default: 2, min: 0, max: 100 }),
  tenants: Setting.int({ default: 2, min: 0, max: 1000 }),
  zones: Setting.int({ default: 0, min: 0, max: 3 }),
  tenantCpu: Setting.number({ default: 1, min: 0, max: 64 }),
  tenantMemory: Setting.number({ default: 1024, min: 0, max: 100_000 }),
  slots: Setting.int({ default: 10, min: 1, max: 1000 }),
  strategy: Setting.choice(["binpack", "spread"], { default: "binpack" }),
  spread: Setting.choice(["zones", "strict", "none"], { default: "zones" }),
  protect: Setting.bool({ default: false }),
  hostLaunch: Setting.duration({ default: "60 seconds", min: 0, max: "1 hour" }),
  tenantStart: Setting.duration({ default: "5 seconds", min: 0, max: "1 hour" }),
  hostDetect: Setting.duration({ default: "1 hour", min: 0, max: "10 hours" }),
  tenantDetect: Setting.duration({ default: "10 seconds", min: 0, max: "1 hour" }),
  hostDrain: Setting.duration({ default: "5 minutes", min: 0, max: "1 hour" }),
  tenantDrain: Setting.duration({ default: "30 seconds", min: 0, max: "1 hour" }),
  serviceTime: Setting.duration({ default: "100 millis", min: 0, max: "1 hour" })
})

const Hosted = Component.make({
  type: "test.hosted",
  title: "Hosted",
  category: "compute",
  fleet: true,
  config: HostedConfig,
  ports: {},
  state: Schema.Struct({
    hosts: Schema.Array(Schema.Struct({ name: Schema.String, zone: Schema.optionalKey(Schema.String), tenants: Schema.Array(Schema.String), cordoned: Schema.Boolean })),
    pending: Schema.Number,
    lost: Schema.Number,
    lostWithHost: Schema.Number,
    evicted: Schema.Number
  }),
  make: (node) =>
    Effect.gen(function*() {
      const { fast } = node
      const s = () => fast.settings()
      const ms = (d: Duration.Duration) => Duration.toMillis(d)
      let pool: HostPool | undefined
      const machines = new Fleet(node, {
        desired: () => s().hosts,
        zones: () => node.zones.all.slice(0, s().zones),
        phases: () => [{ name: "launch", ms: ms(s().hostLaunch) }],
        workers: () => 0,
        line: () => 0,
        backlog: () => 0,
        drain: () => ms(s().hostDrain),
        detect: () => ms(s().hostDetect),
        protect: (u) => s().protect && pool!.occupied(u),
        name: (id) => `host-${id}`
      })
      pool = new HostPool(machines, {
        room: () => ({ cpu: 2, memory: 4096, slots: s().slots }),
        strategy: () => s().strategy,
        now: fast.now
      })
      const tenants = new Fleet(node, {
        desired: () => s().tenants,
        zones: () => node.zones.all.slice(0, s().zones),
        phases: () => [{ name: "start", ms: ms(s().tenantStart) }],
        workers: () => 10,
        line: () => 1000,
        backlog: () => 1000,
        drain: () => ms(s().tenantDrain),
        detect: () => ms(s().tenantDetect),
        hosts: pool.tenants({ demand: () => ({ cpu: s().tenantCpu, memory: s().tenantMemory }), spread: () => s().spread }),
        name: (id) => `t${id}`
      })
      const { handle, lost } = served(node, tenants, () => ms(s().serviceTime))
      yield* node.spawn(SubscriptionRef.changes(node.config).pipe(Stream.runForEach(() =>
        Effect.sync(() => {
          machines.refresh()
          tenants.refresh()
        })
      )))
      node.meter.gaugeUnsafe("hosts", () => machines.serving)
      node.meter.gaugeUnsafe("hostsLive", () => machines.count.requested + machines.count.starting + machines.count.grace + machines.count.inService)
      node.meter.gaugeUnsafe("serving", () => tenants.serving)
      node.meter.gaugeUnsafe("pending", () => tenants.count.requested)
      for (const zone of node.zones.all.slice(0, 3)) node.meter.gaugeUnsafe(`serving.${zone}`, () => tenants.servingIn(zone))
      return {
        call: (message) => handle(message, undefined),
        fleet: tenants.offer((unit, message) => handle(message, unit)),
        probe: Effect.sync(() => ({
          hosts: pool!.hosts.map((h) => ({ name: h.name, ...(h.zone === undefined ? {} : { zone: h.zone }), tenants: [...h.tenants].map((t) => t.name), cordoned: h.cordoned })),
          pending: tenants.count.requested,
          lost: lost(),
          lostWithHost: pool!.totals.lostWithHost,
          evicted: pool!.totals.evicted
        }))
      }
    })
})

const { sim } = simulator([Hosted])

const design = (settings: Record<string, unknown>, rps = 20) => {
  const b = Builder.make("hosted", { seed: 7 })
  const web = b.add("common.client", { id: "web", region: "eu-west", settings: { rps, arrival: "constant" } })
  const h = b.add("test.hosted", { id: "h", region: "eu-west", settings })
  b.connect(web, h, { timeout: "1 minute" })
  return b.build()
}

type Probe = { hosts: ReadonlyArray<{ name: string; zone?: string; tenants: ReadonlyArray<string>; cordoned: boolean }>; pending: number; lost: number; lostWithHost: number; evicted: number }
const probe = (s: Simulation.Service) => Effect.map(s.probe("h"), (p) => p.state as Probe)
const gauge = (all: ReadonlyArray<Frame>, name: string, from: number, to: number) => mean(all, "nodes", "h", "gauges", name, from, to)

describe("units placed on hosts", () => {
  it("binpacks tenants onto the fullest host, and spreads them onto the emptiest", async () => {
    const packed = await sim(design({ hosts: 3, tenants: 3, strategy: "binpack" }), (s) => Effect.andThen(s.advanceTo(1_000), probe(s)))
    expect(packed.hosts.map((h) => h.tenants.length)).toEqual([2, 1, 0])
    const spread = await sim(design({ hosts: 3, tenants: 3, strategy: "spread" }), (s) => Effect.andThen(s.advanceTo(1_000), probe(s)))
    expect(spread.hosts.map((h) => h.tenants.length)).toEqual([1, 1, 1])
  })

  it("keeps tenants with no room pending until a host comes up, then starts them there", () =>
    // Two hosts hold four tenants; six are asked for. A third host launches in 60 s.
    sim(design({ hosts: 2, tenants: 4 }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(10_000)
        yield* s.configureNode("h", { hosts: 2, tenants: 6 })
        const early = yield* s.advanceTo(30_000)
        expect(gauge(early, "pending", 11_000, 30_000)).toBe(2)
        expect(gauge(early, "serving", 11_000, 30_000)).toBe(4)
        yield* s.configureNode("h", { hosts: 3, tenants: 6 })
        // Host up at 90 s; the two pending tenants then take 5 s to start.
        const all = yield* s.advanceTo(100_000)
        expect(gauge(all, "pending", 31_000, 89_750)).toBe(2)
        expect(gauge(all, "serving", 96_000, 100_000)).toBe(6)
        expect((yield* probe(s)).hosts.map((h) => h.tenants.length)).toEqual([2, 2, 2])
      })))

  it("spreads tenants over zones, and with strict spread waits rather than skew", async () => {
    // Three zones, one host each, room for two tenants a host.
    const spread = await sim(design({ zones: 3, hosts: 3, tenants: 3 }), (s) => Effect.andThen(s.advanceTo(1_000), probe(s)))
    expect(spread.hosts.map((h) => h.tenants.length)).toEqual([1, 1, 1])
    // Two hosts, in zones a and b; zone c has none. The third tenant belongs in zone c: strict spread leaves it pending
    // rather than put a second tenant in a or b; the default puts it in a.
    const strict = await sim(design({ zones: 3, hosts: 2, tenants: 3, spread: "strict" }), (s) => Effect.andThen(s.advanceTo(10_000), probe(s)))
    expect(strict.pending).toBe(1)
    expect(strict.hosts.map((h) => h.tenants.length)).toEqual([1, 1])
    const loose = await sim(design({ zones: 3, hosts: 2, tenants: 3 }), (s) => Effect.andThen(s.advanceTo(10_000), probe(s)))
    expect(loose.pending).toBe(0)
    expect(loose.hosts.map((h) => h.tenants.length)).toEqual([2, 1])
  })

  it("takes a dead host's tenants with it; they are replaced on other hosts once noticed", () =>
    // Zone a holds one host with two tenants; zones b and c hold the rest. The tenant fleet notices dead tenants after 10 s.
    sim(design({ zones: 3, hosts: 3, tenants: 2, slots: 2 }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(5_000)
        expect((yield* probe(s)).hosts.map((h) => [h.zone, h.tenants.length])).toEqual([["eu-west-a", 1], ["eu-west-b", 1], ["eu-west-c", 0]])
        yield* s.faults.inject({ kind: "zone", id: "internet:eu-west:eu-west-a" }, { _tag: "Outage" })
        const all = yield* s.advanceTo(30_000)
        const p = yield* probe(s)
        expect(p.lostWithHost).toBe(1)
        // Dead from 5 s, noticed at 15 s, started on zone c's host by 20 s.
        expect(gauge(all, "serving", 6_000, 14_750)).toBe(1)
        expect(gauge(all, "serving", 21_000, 30_000)).toBe(2)
        expect(p.hosts.find((h) => h.zone === "eu-west-c")!.tenants.length).toBe(1)
      })))

  it("evicts a draining host's tenants: replacements start elsewhere and nothing in flight is lost", () =>
    // Spread: 8 tenants on 5 hosts are 2, 2, 2, 1, 1. Scaled to 4 hosts, the newest drains; its tenant is evicted and
    // started again on the emptiest host left, and the drained host waits for it to finish the requests it holds (2 s each).
    sim(design({ hosts: 5, tenants: 8, strategy: "spread", serviceTime: "2 seconds" }, 10), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(5_000)
        expect((yield* probe(s)).hosts.map((h) => h.tenants.length)).toEqual([2, 2, 2, 1, 1])
        yield* s.configureNode("h", { hosts: 4, tenants: 8, strategy: "spread", serviceTime: "2 seconds" })
        const all = yield* s.advanceTo(60_000)
        const p = yield* probe(s)
        expect(p.lost).toBe(0)
        expect(p.evicted).toBe(1)
        expect(p.hosts.map((h) => h.tenants.length)).toEqual([2, 2, 2, 2])
        expect(gauge(all, "serving", 11_000, 60_000)).toBe(8)
        // The host went once its tenant had finished, well before its own 5-minute drain.
        expect(gauge(all, "hostsLive", 10_000, 60_000)).toBe(4)
        expect(mean(all, "nodes", "web", "rates", "fail", 0, 60_000)).toBe(0)
      })))

  it("with scale-in protection lets go only of empty hosts, and runs above desired until one empties", () =>
    sim(design({ hosts: 4, tenants: 8, protect: true }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(5_000)
        // Every host is full: asked for two hosts, it keeps four.
        yield* s.configureNode("h", { hosts: 2, tenants: 8, protect: true })
        const held = yield* s.advanceTo(20_000)
        expect(gauge(held, "hosts", 6_000, 20_000)).toBe(4)
        expect((yield* probe(s)).evicted).toBe(0)
        // Scale the tenants in: the newest two go, and binpack had put them on the last host, which empties and goes.
        yield* s.configureNode("h", { hosts: 2, tenants: 6, protect: true })
        const all = yield* s.advanceTo(80_000)
        expect(gauge(all, "hosts", 55_000, 80_000)).toBe(3)
        expect((yield* probe(s)).hosts.map((h) => h.tenants.length)).toEqual([2, 2, 2])
      })))
})
