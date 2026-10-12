import { Duration, Effect } from "effect"
import { describe, expect, it } from "vitest"
import { mean } from "../../components/testing.ts"
import type { State as GroupState } from "../../fleet/TargetGroup.ts"
import type { Frame } from "../../Telemetry.ts"
import { audit } from "./audit.ts"
import { balanced, registry, sim, zoneTarget } from "./testing.ts"

const node = (all: ReadonlyArray<Frame>, id: string, name: string, from: number, to = Infinity) => mean(all, "nodes", id, "rates", name, from, to)
const gauge = (all: ReadonlyArray<Frame>, id: string, name: string, from: number, to = Infinity) => mean(all, "nodes", id, "gauges", name, from, to)
const edgeGauge = (all: ReadonlyArray<Frame>, id: string, name: string, from: number, to = Infinity) => mean(all, "edges", id, "gauges", name, from, to)
const DOWN = { _tag: "Outage" } as const

describe("aws.alb: target groups into a fleet", () => {
  it("routes through an ALB target group with AWS's defaults, and counts requests per target a minute", () =>
    sim(balanced({ rps: 600, fleets: { fleet: { settings: { desired: 6 } } } }).build(), (s) =>
      Effect.gen(function*() {
        const all = yield* s.advanceTo(30_000)
        expect((yield* s.probeEdge("lb->fleet")).connector).toBe("aws.alb.target-group")
        expect(node(all, "lb", "requests", 2_000)).toBeCloseTo(600, -1)
        expect(node(all, "fleet", "in", 2_000)).toBeCloseTo(600, -1)
        // 600 a second over 6 healthy targets is 6,000 requests a minute each: RequestCountPerTarget's unit.
        expect(edgeGauge(all, "lb->fleet", "requestCountPerTarget", 2_000) / 6_000).toBeCloseTo(1, 1)
        expect(edgeGauge(all, "lb->fleet", "targets.healthy", 1_000)).toBe(6)
        const state = (yield* s.probe("lb")).state as { zones: ReadonlyArray<{ zone: string; share: number }>; requests: number; targetGroups: ReadonlyArray<{ kind: string }> }
        expect(state.zones.map((z) => z.zone)).toEqual(["us-east-1a", "us-east-1b", "us-east-1c"])
        for (const z of state.zones) expect(z.share).toBeCloseTo(1 / 3, 5)
        expect(state.targetGroups).toEqual([{ edge: "lb->fleet", to: "fleet", kind: "fleet" }])
        expect(state.requests).toBeGreaterThan(17_000)
      })))

  it("answers 503 with nothing wired to it", () => {
    const b = balanced({ fleets: {} })
    return sim(b.build(), (s) => Effect.map(s.advanceTo(5_000), (all) => expect(node(all, "lb", "elb.503", 1_000)).toBeCloseTo(300, -1)))
  })

  it("keeps sending to a hung target until two failed checks 30 s apart catch it, then the fleet replaces it", () =>
    // One target in each zone; zone c's stops answering (a 10-minute slowdown: its host hangs). The ALB's node there is
    // fine. Checks every 30 s from t = 0, each given up after 5 s: the ones at 90 and 120 s fail, so it is out at 125 s.
    sim(balanced({ lbSettings: { idleTimeout: "10 seconds" }, fleets: { fleet: { settings: { desired: 3, zones: 3, workers: 10_000 } } } }).build(), (s) =>
      Effect.gen(function*() {
        const before = yield* s.advanceTo(61_000)
        yield* s.faults.inject(zoneTarget("us-east-1c"), { _tag: "Slow", extra: Duration.minutes(10) })
        const all = [...before, ...(yield* s.advanceTo(200_000))]
        expect(node(all, "lb", "elb.504", 0, 71_000)).toBe(0)
        // A third of the requests reach the hung target and wait out the idle timeout: 504, ten seconds later.
        expect(node(all, "lb", "elb.504", 72_000, 134_000)).toBeCloseTo(100, -1)
        expect(node(all, "lb", "elb.504", 137_000)).toBe(0)
        expect(node(all, "lb", "ok", 137_000)).toBeCloseTo(300, -1)
        // Told, the fleet replaces it; the replacement goes to the emptiest zone, which is c, where it hangs too: it never
        // passes its first check, so it never gets a request, and is replaced in its turn, again and again.
        expect(edgeGauge(all, "lb->fleet", "targets.healthy", 127_000)).toBe(2)
        expect(node(all, "lb", "fail", 137_000)).toBe(0)
      })))

  it("sends nothing to targets in a zone it has no node in, even with cross-zone on", () =>
    sim(balanced({ lbSettings: { zones: 2 }, fleets: { fleet: { settings: { desired: 3, zones: 3 } } } }).build(), (s) =>
      Effect.map(s.advanceTo(20_000), (all) => {
        expect(node(all, "fleet", "unit.u3", 1_000)).toBe(0)
        expect(node(all, "fleet", "unit.u1", 1_000)).toBeCloseTo(150, -1)
        expect(node(all, "fleet", "unit.u2", 1_000)).toBeCloseTo(150, -1)
      })))

  it("answers 503 with no registered target, and fails open (502) when every target is unhealthy", async () => {
    const empty = await sim(balanced({ fleets: { fleet: { settings: { desired: 0 } } } }).build(), (s) => s.advanceTo(10_000))
    expect(node(empty, "lb", "elb.503", 1_000)).toBeCloseTo(300, -1)
    expect(node(empty, "web", "fail.Unavailable", 1_000)).toBeCloseTo(300, -1)
    // Every target in zone a, which goes down; nobody replaces them, so they stay registered and unhealthy.
    const dead = await sim(
      balanced({ lbSettings: { zones: 2 }, fleets: { fleet: { settings: { desired: 2, zones: 1 }, edge: { replaceUnhealthy: false } } } }).build(),
      (s) =>
        Effect.gen(function*() {
          yield* s.advanceTo(5_000)
          yield* s.faults.inject(zoneTarget("us-east-1a"), DOWN)
          return { all: yield* s.advanceTo(200_000), group: (yield* s.probeEdge("lb->fleet")).state as GroupState }
        })
    )
    expect(dead.group.unhealthy).toBe(2)
    // Node a is gone from DNS a TTL later; node b fails open to the unhealthy targets: 502s, never 503.
    expect(node(dead.all, "lb", "elb.502", 130_000)).toBeCloseTo(300, -1)
    expect(node(dead.all, "lb", "elb.503", 5_000)).toBe(0)
  })

  it("answers 504 when the target says nothing within the idle timeout, and the target keeps working", () =>
    sim(balanced({ rps: 50, lbSettings: { idleTimeout: "1 second" }, fleets: { fleet: { settings: { serviceTime: { mean: 3_000, cv: 0 } } } } }).build(), (s) =>
      Effect.gen(function*() {
        const all = yield* s.advanceTo(30_000)
        expect(node(all, "lb", "elb.504", 5_000)).toBeCloseTo(50, -1)
        expect(node(all, "web", "fail.Timeout", 5_000)).toBeCloseTo(50, -1)
        expect(node(all, "fleet", "ok", 5_000)).toBeCloseTo(50, -1)
      })))

  it("passes the target's own 500s and 503s on, as target errors rather than its own", async () => {
    const errors = await sim(balanced({ fleets: { fleet: { settings: { errorRate: 0.1 } } } }).build(), (s) => s.advanceTo(20_000))
    expect(node(errors, "lb", "target.5xx", 2_000)).toBeCloseTo(30, -1)
    expect(node(errors, "lb", "elb.5xx", 2_000)).toBe(0)
    expect(node(errors, "web", "fail.Failed", 2_000)).toBeCloseTo(30, -1)
    // One worker a target and no backlog: a busy target answers 503 itself, which the ALB forwards.
    const busy = await sim(balanced({ fleets: { fleet: { settings: { workers: 1, backlog: 0, serviceTime: { mean: 100, cv: 0 } } } } }).build(), (s) => s.advanceTo(20_000))
    expect(node(busy, "fleet", "ok", 2_000)).toBeCloseTo(30, -1)
    expect(node(busy, "lb", "target.5xx", 2_000)).toBeCloseTo(270, -1)
    expect(node(busy, "lb", "elb.502", 2_000)).toBe(0)
  })

  it("counts 460 when the client gives up and closes its connection before the target answers", () =>
    sim(balanced({ rps: 40, clientEdge: { timeout: "500 millis", cancelOnTimeout: true }, fleets: { fleet: { settings: { serviceTime: { mean: 2_000, cv: 0 } } } } }).build(), (s) =>
      Effect.gen(function*() {
        const all = yield* s.advanceTo(20_000)
        expect(node(all, "lb", "elb.460", 3_000)).toBeCloseTo(40, -1)
        expect(node(all, "lb", "elb.5xx", 3_000)).toBe(0)
        expect(gauge(all, "lb", "activeConnections", 3_000)).toBeLessThan(25)
      })))

  it("passes a GET on as a read, to a fleet and to an IP target, unless the edge says otherwise", async () => {
    const b = balanced({ client: {}, clientEdge: { request: { operation: "read" } }, fleets: { reader: {}, writer: { edge: { request: { operation: "write" } } } } })
    const ip = b.add("test.elb-endpoint", { id: "ip", parent: b.box })
    b.connect(b.lb, ip, {}, { id: "lb->ip" })
    const all = await sim(b.build(), (s) =>
      Effect.gen(function*() {
        expect((yield* s.probeEdge("lb->ip")).connector).toBe("aws.alb.ip-target")
        return yield* s.advanceTo(20_000)
      }))
    expect(node(all, "reader", "op.read", 2_000)).toBeCloseTo(100, -1)
    expect(node(all, "reader", "op.write", 2_000)).toBe(0)
    expect(node(all, "ip", "op.read", 2_000)).toBeCloseTo(100, -1)
    expect(node(all, "writer", "op.write", 2_000)).toBeCloseTo(100, -1)
  })
})

describe("aws.alb: routing between target groups", () => {
  const blueGreen = (routing: string) =>
    balanced({ rps: 400, lbSettings: { routing }, fleets: { blue: { edge: { weight: 9 } }, green: { edge: { weight: 1 } } } })

  it("splits by the target groups' weights, and shifts as they are edited (blue/green)", () =>
    sim(blueGreen("weighted").build(), (s) =>
      Effect.gen(function*() {
        const before = yield* s.advanceTo(30_000)
        yield* s.configureEdge("lb->blue", { weight: 0 })
        yield* s.configureEdge("lb->green", { weight: 1 })
        const all = [...before, ...(yield* s.advanceTo(60_000))]
        expect(node(all, "blue", "in", 2_000, 30_000)).toBeCloseTo(360, -1)
        expect(node(all, "green", "in", 2_000, 30_000)).toBeCloseTo(40, -1)
        expect(node(all, "blue", "in", 31_000)).toBe(0)
        expect(node(all, "green", "in", 31_000)).toBeCloseTo(400, -1)
      })))

  it("routes by key with listener rules: one path (key) always reaches the same target group", () =>
    sim(blueGreen("rules").build(), (s) =>
      Effect.gen(function*() {
        yield* s.configureNode("web", { rps: 400, arrival: "constant", hotKeys: 1 })
        const all = yield* s.advanceTo(20_000)
        const blue = node(all, "blue", "in", 2_000)
        const green = node(all, "green", "in", 2_000)
        expect(Math.min(blue, green)).toBe(0)
        expect(blue + green).toBeCloseTo(400, -1)
      })))

  it("answers 503 when every target group has weight 0", () =>
    sim(balanced({ fleets: { fleet: { edge: { weight: 0 } } } }).build(), (s) =>
      Effect.map(s.advanceTo(10_000), (all) => expect(node(all, "lb", "elb.503", 1_000)).toBeCloseTo(300, -1))))
})

describe("aws.alb: routing algorithms", () => {
  it("sends a slow target fewer requests with least outstanding requests than with round robin", async () => {
    // Four targets, the first five times slower (200 ms against 40 ms).
    const run = (algorithm: string) =>
      sim(balanced({ rps: 400, fleets: { fleet: { settings: { desired: 4, slowFirst: 5 }, edge: { algorithm } } } }).build(), (s) =>
        Effect.map(s.advanceTo(30_000), (all) => ({ slow: node(all, "fleet", "unit.u1", 5_000), p: mean(all, "nodes", "lb", "rates", "ok", 5_000) })))
    const rr = await run("round-robin")
    const lor = await run("least-outstanding")
    expect(rr.slow).toBeCloseTo(100, -1)
    expect(lor.slow).toBeLessThan(45)
    expect(lor.p).toBeCloseTo(400, -1)
  })

  it("keeps a client on one target with sticky sessions", () =>
    sim(balanced({ rps: 400, fleets: { fleet: { settings: { desired: 4 }, edge: { stickiness: true } } } }).build(), (s) =>
      Effect.gen(function*() {
        yield* s.configureNode("web", { rps: 400, arrival: "constant", hotKeys: 1 })
        const all = yield* s.advanceTo(10_000)
        const busy = [1, 2, 3, 4].map((i) => node(all, "fleet", `unit.u${i}`, 1_000)).filter((r) => r > 0)
        expect(busy).toHaveLength(1)
      })))
})

describe("aws.alb: zones", () => {
  const outage = (crossZone: boolean) =>
    sim(balanced({ rps: 300, fleets: { fleet: { settings: { desired: 6, zones: 3 }, edge: { crossZone, replaceUnhealthy: false } } } }).build(), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(61_000)
        yield* s.faults.inject(zoneTarget("us-east-1a"), DOWN)
        return yield* s.advanceTo(240_000)
      }))

  it("loses a zone's node: its share falls to nothing over the 60 s DNS TTL", async () => {
    const all = await outage(true)
    // A third of the requests reach node a when it goes, and fewer as cached answers expire: clients that resolved more
    // than a TTL ago spread over three nodes, the rest over two. 10 s in, 5/6 of the answers still hold a; 45 s in, 1/4.
    expect(node(all, "lb", "deadNode", 66_000, 76_000)).toBeCloseTo(100 * (5 / 6), -1)
    expect(node(all, "lb", "deadNode", 101_000, 111_000)).toBeCloseTo(100 * (1 / 4), -1)
    expect(node(all, "lb", "deadNode", 122_000)).toBe(0)
    expect(gauge(all, "lb", "zones.inDns", 70_000)).toBe(2)
  })

  it("with cross-zone on, the other nodes send to the dead zone's targets until checks catch them; with it off, never", async () => {
    const on = await outage(true)
    const off = await outage(false)
    // On: nodes b and c send a third of theirs to zone a's dead targets, until two failed checks (90 and 120 s).
    expect(node(on, "lb", "elb.502", 62_000, 119_000)).toBeGreaterThan(40)
    expect(node(on, "lb", "elb.502", 125_000)).toBe(0)
    // Off: they only ever send to their own zone's targets.
    expect(node(off, "lb", "elb.502", 62_000)).toBe(0)
    // Either way, once DNS has moved and the checks have caught up, nothing fails.
    expect(node(on, "web", "fail", 130_000)).toBe(0)
    expect(node(off, "web", "fail", 130_000)).toBe(0)
  })

  it("plays the same outage the same way twice", async () => {
    const [a, b] = [await outage(true), await outage(true)]
    expect(a.length).toBe(b.length)
    expect(JSON.stringify(a.map((f) => f.nodes.lb))).toBe(JSON.stringify(b.map((f) => f.nodes.lb)))
  })

  it("with cross-zone off, answers 503 for requests entering a zone that has no targets", async () => {
    const run = (crossZone: boolean) =>
      sim(balanced({ rps: 300, lbSettings: { zones: 3 }, fleets: { fleet: { settings: { desired: 4, zones: 2 }, edge: { crossZone } } } }).build(), (s) => s.advanceTo(20_000))
    expect(node(await run(false), "lb", "elb.503", 2_000)).toBeCloseTo(100, -1)
    expect(node(await run(true), "lb", "elb.503", 2_000)).toBe(0)
  })
})

describe("aws.alb: capacity", () => {
  const surge = (reserved: number) =>
    sim(balanced({ rps: 200, lbSettings: { capacity: { reserved } }, fleets: { fleet: { settings: { desired: 10, workers: 1_000 } } } }).build(), (s) =>
      Effect.gen(function*() {
        const before = yield* s.advanceTo(60_000)
        yield* s.configureNode("web", { rps: 6_000, arrival: "constant" })
        return [...before, ...(yield* s.advanceTo(300_000))]
      }))

  it("rejects connections in a sudden surge while it scales, and not with an LCU reservation", async () => {
    const cold = await surge(0)
    // 200 req/s at 10 requests a connection is under 1 LCU: the ALB sits at its 10 LCU minimum (2,500 req/s of new
    // connections). 6,000 req/s needs 24 LCUs, 34 with headroom; doubling a minute gets there in about two.
    expect(gauge(cold, "lb", "capacity.lcu", 30_000, 60_000)).toBeCloseTo(10, 0)
    expect(node(cold, "lb", "rejectedConnections", 61_000, 70_000)).toBeGreaterThan(2_500)
    expect(node(cold, "lb", "rejectedConnections", 200_000)).toBe(0)
    expect(gauge(cold, "lb", "capacity.lcu", 250_000)).toBeGreaterThan(30)
    expect(gauge(cold, "lb", "capacityUtilization", 61_000, 70_000)).toBeGreaterThan(0.95)
    const reserved = await surge(100)
    expect(node(reserved, "lb", "rejectedConnections", 0)).toBe(0)
    expect(gauge(reserved, "lb", "reserved.lcu", 0)).toBe(100)
  }, 120_000) // two five-minute runs at 6,000 requests a second

  it("starts scaled to its traffic, so a steady design never sees it", () =>
    sim(balanced({ rps: 5_000, fleets: { fleet: { settings: { desired: 10, workers: 1_000 } } } }).build(), (s) =>
      Effect.map(s.advanceTo(30_000), (all) => {
        expect(node(all, "lb", "rejectedConnections", 0)).toBe(0)
        // 5,000 req/s: 20 LCUs of new connections (and 18 of bytes at 1 KB each).
        expect(gauge(all, "lb", "consumed.lcu", 5_000)).toBeCloseTo(20, 0)
      })))
})

describe("aws.alb: Lambda targets", () => {
  const lambda = (fn: Record<string, unknown>, payload = 1) => {
    const b = balanced({ client: { payload }, fleets: {} })
    const f = b.add("aws.lambda", { id: "fn", parent: b.box, settings: { duration: { mean: 20, cv: 0 }, ...fn } })
    b.connect(b.lb, f, {}, { id: "lb->fn" })
    return b.build()
  }

  it("invokes the function; a function error is a 502", () =>
    sim(lambda({ errorRate: 0.2 }), (s) =>
      Effect.gen(function*() {
        const all = yield* s.advanceTo(20_000)
        expect((yield* s.probeEdge("lb->fn")).connector).toBe("aws.alb.lambda-target")
        expect(node(all, "fn", "in", 2_000)).toBeCloseTo(300, -1)
        expect(node(all, "lb", "elb.502", 2_000)).toBeCloseTo(60, -1)
        expect(node(all, "lb", "lambda.userError", 2_000)).toBeCloseTo(60, -1)
      })))

  it("refuses a body over 1 MB with 413, without invoking", () =>
    sim(lambda({}, 2_048), (s) =>
      Effect.map(s.advanceTo(10_000), (all) => {
        expect(node(all, "lb", "elb.4xx", 1_000)).toBeCloseTo(300, -1)
        expect(node(all, "fn", "in", 1_000)).toBe(0)
      })))
})

describe("aws.alb: account quotas", () => {
  const member = (id: string, reserved: number) => ({ id, name: id, type: "aws.alb", config: { capacity: { reserved } } })
  const quotas = (o: Record<string, number> = {}) => ({ elbApplicationLoadBalancers: 50, elbNetworkLoadBalancers: 50, elbReservedAlbLcus: 0, ...o })

  it("warns that reserving LCUs needs the Region's quota raised, and that a reservation is at least 100", () => {
    const codes = audit("us-east-1", [member("a", 50)], quotas()).map((d) => d.code)
    expect(codes).toEqual(["elb-reservation-minimum", "elb-reservation-quota"])
    expect(audit("us-east-1", [member("a", 500)], quotas({ elbReservedAlbLcus: 1_000 }))).toEqual([])
  })

  it("is placeable in a VPC", () => {
    expect(registry.get("aws.vpc")!.container!.accepts(registry.get("aws.alb")!)).toBe(true)
  })
})
