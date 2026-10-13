import { Duration, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../../../Builder.ts"
import { dist, mean, rate, sim } from "../../../testing.ts"
import type { Frame } from "../../../Telemetry.ts"
import type * as Simulation from "../../../Simulation.ts"
import { audit } from "../Audit.ts"
import { continentOf } from "../internal/config.ts"
import { Route53 } from "../Route53.ts"

const DOWN = { _tag: "Outage" } as const

interface Endpoint {
  readonly id: string
  /** Settings of the `common.http-endpoint`. */
  readonly settings?: Record<string, unknown>
  /** Settings of the edge from the record (the record's own fields: weight, role, location, healthCheck). */
  readonly edge?: Record<string, unknown>
}

interface Options {
  readonly settings?: Record<string, unknown>
  readonly rps?: number
  readonly endpoints?: ReadonlyArray<Endpoint>
  readonly region?: string
  readonly account?: Record<string, unknown>
  readonly seed?: number
}

/** A lookup that takes exactly 20 ms, so latencies can be counted. */
const LOOKUP = { mean: 20, cv: 0 }

/**
 * Callers in front of a Route 53 record whose records point at fixed-latency HTTP endpoints: 5 ms to the record (the
 * last mile to the resolver), 10 ms from it to each endpoint (the rest of the way), 50 ms in the endpoint.
 */
const dns = (o: Options = {}) => {
  const b = Builder.make("dns", { seed: o.seed ?? 3 })
  const users = b.add("common.client", { id: "users", settings: { arrival: "constant", rps: o.rps ?? 200 } })
  const record = b.add("aws.route53", { id: "dns", ...(o.region === undefined ? {} : { region: o.region }), settings: { resolvers: { lookup: LOOKUP }, ...o.settings } })
  b.connect(users, record, { latency: { mean: 5, cv: 0 }, request: { operation: "read" } }, { id: "users->dns" })
  for (const e of o.endpoints ?? [{ id: "a" }]) {
    const node = b.add("common.http-endpoint", { id: e.id, settings: { latency: { mean: 50, cv: 0 }, ...e.settings } })
    b.connect(record, node, { latency: { mean: 10, cv: 0 }, ...e.edge }, { id: `dns->${e.id}` })
  }
  if (o.account !== undefined) b.account(`aws:${o.region ?? "us-east-1"}`, o.account)
  return b.build()
}

interface RecordState {
  readonly edge: string
  readonly to: string
  readonly healthChecked: boolean
  readonly healthy: boolean
  readonly checkersHealthy: number
  readonly checkers: number
  readonly changedAt: number
  readonly cachedShare: number
}
interface State {
  readonly policy: string
  readonly ttlSeconds: number
  readonly records: ReadonlyArray<RecordState>
  readonly resolvers: number
  readonly cached: number
  readonly cachedUnhealthy: number
  readonly queries: number
  readonly cacheHits: number
  readonly noAnswer: number
  readonly probes: number
  readonly probeFailures: number
  readonly healthChecks: number
  readonly healthChecksRefused: number
}
const stateOf = (s: Simulation.Service, id = "dns") => Effect.map(s.probe(id), (p) => p.state as State)
const recordOf = (state: State, to: string): RecordState => state.records.find((r) => r.to === to)!

type Step = (s: Simulation.Service) => Effect.Effect<unknown, unknown>

/** Run to `ms`, doing each step at its time, and give back every frame and the record's state at the end. */
const run = (doc: ReturnType<typeof dns>, ms: number, steps: ReadonlyArray<readonly [number, Step]> = []) =>
  sim(doc, (s) =>
    Effect.gen(function*() {
      const all: Array<Frame> = []
      for (const [at, step] of [...steps].sort((a, b) => a[0] - b[0])) {
        all.push(...(yield* s.advanceTo(at)))
        yield* Effect.orDie(step(s))
      }
      all.push(...(yield* s.advanceTo(ms)))
      return { all, state: yield* stateOf(s) }
    }))

const outage = (id: string): Step => (s) => s.faults.inject({ kind: "node", id }, DOWN)
const recover: Step = (s) => s.faults.clearAll

const edgeCalls = (all: ReadonlyArray<Frame>, to: string, from = 0, to2 = Infinity) => mean(all, "edges", `dns->${to}`, "rates", "calls", from, to2)
const gauge = (all: ReadonlyArray<Frame>, name: string, from = 0, to = Infinity) => mean(all, "nodes", "dns", "gauges", name, from, to)
/** The share of the callers' requests that failed over a window. */
const errorShare = (all: ReadonlyArray<Frame>, from: number, to: number) => {
  const failed = rate(all, "users", "fail", from, to)
  const ok = rate(all, "users", "ok", from, to)
  return failed / Math.max(1e-9, failed + ok)
}

const FAILOVER = [
  { id: "a", edge: { role: "primary" } },
  { id: "b", edge: { role: "secondary" } }
] as const

describe("aws.route53: not in the data path", () => {
  it("adds nothing to a call answered from a resolver cache, and one lookup to a call that has to ask", async () => {
    // 5 + 10 + 50 + 10 + 5 = 80 ms through cached answers; one cache, a minute's TTL: at most two lookups in 30 s.
    const cached = await run(dns({ settings: { resolvers: { count: 1, lookup: LOOKUP } } }), 30_000)
    expect(dist(cached.all, "users", "latency", 2_000).mean).toBeCloseTo(80, 0)
    expect(cached.state.queries).toBeLessThanOrEqual(2)
    // A TTL of 0: nothing is cached, every call asks, and every call pays the 20 ms lookup.
    const uncached = await run(dns({ settings: { ttl: 0, resolvers: { lookup: LOOKUP } } }), 10_000)
    expect(dist(uncached.all, "users", "latency", 2_000).mean).toBeCloseTo(100, 0)
    expect(uncached.state.cacheHits).toBe(0)
    expect(uncached.state.queries).toBeGreaterThan(1_900)
  })

  it("asks Route 53 about once per cache per TTL, however much traffic there is", async () => {
    const r = await run(dns({ rps: 500, settings: { ttl: "10 seconds", resolvers: { count: 100, lookup: LOOKUP } } }), 60_000)
    // 100 caches, each refreshing every 10 s (plus the wait for its next caller, about 0.2 s).
    expect(rate(r.all, "dns", "queries", 20_000)).toBeGreaterThan(8.5)
    expect(rate(r.all, "dns", "queries", 20_000)).toBeLessThan(11)
    expect(rate(r.all, "dns", "cacheHits", 20_000)).toBeGreaterThan(480)
  })

  it("passes the caller's operation through to the endpoint, unless the edge says otherwise", async () => {
    const table = (operation?: string) => {
      const b = Builder.make("op", { seed: 1 })
      const users = b.add("common.client", { id: "users", settings: { rps: 50 } })
      const record = b.add("aws.route53", { id: "dns" })
      const store = b.add("aws.dynamodb", { id: "table", settings: { mode: "on-demand" } })
      b.connect(users, record, { request: { operation: "read" } })
      b.connect(record, store, operation === undefined ? {} : { request: { operation } })
      return b.build()
    }
    const passed = await run(table(), 10_000)
    expect(rate(passed.all, "table", "consumedRead", 2_000)).toBeGreaterThan(10)
    expect(rate(passed.all, "table", "consumedWrite", 2_000)).toBe(0)
    const forced = await run(table("write"), 10_000)
    expect(rate(forced.all, "table", "consumedWrite", 2_000)).toBeGreaterThan(10)
  })

  it("puts its own connector on the record's edges", async () => {
    const connector = await sim(dns(), (s) => Effect.map(s.inspect, (i) => i.edges["dns->a"]!.connector))
    expect(connector).toBe("aws.route53.connection")
  })
})

describe("aws.route53: routing policies", () => {
  it("simple: values in random order, weights ignored, no health checks", async () => {
    const r = await run(
      dns({ settings: { ttl: "5 seconds", resolvers: { lookup: LOOKUP } }, endpoints: [{ id: "a", edge: { weight: 9 } }, { id: "b", edge: { weight: 1 } }] }),
      120_000,
      [[30_000, outage("b")]]
    )
    expect(edgeCalls(r.all, "a", 5_000, 30_000)).toBeGreaterThan(85)
    expect(edgeCalls(r.all, "b", 5_000, 30_000)).toBeGreaterThan(85)
    // No health checks: the dead value keeps its half of the traffic for as long as it is down.
    expect(r.state.probes).toBe(0)
    expect(r.state.healthChecks).toBe(0)
    expect(errorShare(r.all, 90_000, 120_000)).toBeGreaterThan(0.4)
    expect(errorShare(r.all, 90_000, 120_000)).toBeLessThan(0.6)
  })

  it("weighted: each record's share is its weight over the total", async () => {
    const r = await run(
      dns({ settings: { policy: "weighted", ttl: "10 seconds", resolvers: { lookup: LOOKUP } }, endpoints: [{ id: "a", edge: { weight: 9 } }, { id: "b", edge: { weight: 1 } }, { id: "c", edge: { weight: 0 } }] }),
      90_000
    )
    const a = edgeCalls(r.all, "a", 20_000)
    const b = edgeCalls(r.all, "b", 20_000)
    // Probes cross the edges too (about 0.5 a second each); a share of 1,000 caches is within a few percent.
    expect(b / (a + b)).toBeGreaterThan(0.07)
    expect(b / (a + b)).toBeLessThan(0.13)
    expect(edgeCalls(r.all, "c", 20_000)).toBeLessThan(1)
  })

  it("weighted: all weights zero is an even split; zero-weight records step in when every weighted one is unhealthy", async () => {
    const even = await run(dns({ settings: { policy: "weighted", ttl: "5 seconds", resolvers: { lookup: LOOKUP } }, endpoints: [{ id: "a", edge: { weight: 0 } }, { id: "b", edge: { weight: 0 } }] }), 40_000)
    expect(edgeCalls(even.all, "a", 10_000)).toBeGreaterThan(85)
    expect(edgeCalls(even.all, "b", 10_000)).toBeGreaterThan(85)

    const standby = await run(
      dns({ settings: { policy: "weighted", ttl: "5 seconds", healthCheck: { interval: "10" }, resolvers: { lookup: LOOKUP } }, endpoints: [{ id: "a", edge: { weight: 5 } }, { id: "b", edge: { weight: 0 } }] }),
      90_000,
      [[30_000, outage("a")]]
    )
    expect(edgeCalls(standby.all, "b", 5_000, 30_000)).toBeLessThan(2)
    expect(edgeCalls(standby.all, "b", 70_000)).toBeGreaterThan(190)
    expect(errorShare(standby.all, 70_000, 90_000)).toBeLessThan(0.01)
  })

  it("failover: the secondary takes over once the primary is found unhealthy, and the primary gets it back", async () => {
    const r = await run(dns({ settings: { policy: "failover" }, endpoints: FAILOVER }), 450_000, [[60_000, outage("a")], [260_000, recover]])
    expect(edgeCalls(r.all, "b", 5_000, 60_000)).toBeLessThan(2)
    // Detection takes about 85 s and the caches a TTL (60 s) more: by 210 s every caller is on the secondary.
    expect(errorShare(r.all, 215_000, 260_000)).toBeLessThan(0.01)
    expect(edgeCalls(r.all, "b", 215_000, 260_000)).toBeGreaterThan(190)
    // Back on the primary within detection (about 65 s) and a TTL of its recovery; the secondary had no errors.
    expect(edgeCalls(r.all, "a", 390_000)).toBeGreaterThan(190)
    expect(errorShare(r.all, 260_000, 450_000)).toBe(0)
  })

  it("failover: the secondary is answered while it is healthy, the primary when both are unhealthy", async () => {
    const both = await run(dns({ settings: { policy: "failover", healthCheck: { interval: "10" } }, endpoints: FAILOVER }), 140_000, [[20_000, outage("a")], [20_000, outage("b")]])
    expect(both.state.records.every((x) => !x.healthy)).toBe(true)
    // Caches that asked between the two verdicts hold the secondary for a TTL; after that only its checks reach it.
    expect(edgeCalls(both.all, "a", 115_000)).toBeGreaterThan(190)
    expect(edgeCalls(both.all, "b", 115_000)).toBeLessThan(2)
    // A secondary without a health check is always healthy, so it is answered even though it is down.
    const unchecked = await run(
      dns({ settings: { policy: "failover", healthCheck: { interval: "10" } }, endpoints: [{ id: "a", edge: { role: "primary" } }, { id: "b", edge: { role: "secondary", healthCheck: false } }] }),
      120_000,
      [[20_000, outage("a")], [20_000, outage("b")]]
    )
    expect(recordOf(unchecked.state, "b").healthChecked).toBe(false)
    expect(edgeCalls(unchecked.all, "b", 100_000)).toBeGreaterThan(190)
  })

  it("latency: the endpoint nearest the callers, then the next nearest when it is unhealthy", async () => {
    const r = await run(
      dns({
        settings: { policy: "latency", healthCheck: { interval: "10" } },
        endpoints: [{ id: "far", edge: { latency: { mean: 80, cv: 0 } } }, { id: "near", edge: { latency: { mean: 10, cv: 0 } } }, { id: "mid", edge: { latency: { mean: 40, cv: 0 } } }]
      }),
      150_000,
      [[30_000, outage("near")]]
    )
    expect(edgeCalls(r.all, "near", 5_000, 30_000)).toBeGreaterThan(195)
    expect(edgeCalls(r.all, "mid", 130_000)).toBeGreaterThan(195)
    expect(edgeCalls(r.all, "far", 5_000)).toBeLessThan(2)
  })

  it("latency: the network distance the engine estimates from placements decides it", async () => {
    const b = Builder.make("latency", { seed: 2 })
    const users = b.add("common.client", { id: "users", region: "eu-west", settings: { rps: 100 } })
    // The record stands with its callers in London.
    const record = b.add("aws.route53", { id: "dns", region: "eu-west-2", settings: { policy: "latency" } })
    b.connect(users, record, { request: { operation: "read" } })
    for (const [id, region] of [["virginia", "us-east-1"], ["ireland", "eu-west-1"], ["singapore", "ap-southeast-1"]] as const) {
      const bucket = b.add("aws.s3", { id, region })
      b.connect(record, bucket, {}, { id: `dns->${id}` })
    }
    const r = await run(b.build(), 20_000)
    expect(edgeCalls(r.all, "ireland", 2_000)).toBeGreaterThan(90)
    expect(edgeCalls(r.all, "virginia", 2_000) + edgeCalls(r.all, "singapore", 2_000)).toBeLessThan(2)
  })

  it("geolocation: the callers' continent, then the default record, and no answer without one", async () => {
    const endpoints = [{ id: "na", edge: { location: "NA" } }, { id: "eu", edge: { location: "EU" } }, { id: "rest", edge: { location: "default" } }]
    const r = await run(dns({ region: "eu-west-2", settings: { policy: "geolocation", healthCheck: { interval: "10" } }, endpoints }), 150_000, [[30_000, outage("eu")]])
    expect(edgeCalls(r.all, "eu", 5_000, 30_000)).toBeGreaterThan(195)
    expect(edgeCalls(r.all, "rest", 130_000)).toBeGreaterThan(195)
    expect(edgeCalls(r.all, "na", 5_000)).toBeLessThan(2)

    const none = await run(dns({ region: "ap-southeast-2", settings: { policy: "geolocation" }, endpoints: [{ id: "na", edge: { location: "NA" } }] }), 10_000)
    expect(rate(none.all, "users", "fail.Rejected", 2_000)).toBeGreaterThan(195)
    expect(none.state.noAnswer).toBeGreaterThan(1_500)
    expect(continentOf("ap-southeast-2")).toBe("OC")
    expect(continentOf("me-central-1")).toBe("AS")
    expect(continentOf("mx-central-1")).toBe("NA")
  })
})

describe("aws.route53: health checks", () => {
  /** When Route 53 decided the primary was unhealthy, after an outage at `at`. */
  const detection = async (healthCheck: Record<string, unknown>, at = 60_000) => {
    const r = await run(dns({ settings: { policy: "failover", healthCheck }, endpoints: FAILOVER }), at + 150_000, [[at, outage("a")]])
    const a = recordOf(r.state, "a")
    expect(a.healthy).toBe(false)
    return a.changedAt - at
  }

  it("takes about interval x threshold to notice: 3 standard checks are about 85 s, fast ones about 28 s", async () => {
    // Each checker's first failing check lands within an interval of the outage, and it calls it after 2 more. Route 53
    // agrees once 18% or fewer still say healthy: 14 of 16 checkers, the 14th of 16 random phases, about 0.82 of one.
    const standard = await detection({})
    // It can't take longer than (threshold) intervals, plus the probes' round trips.
    expect(standard).toBeGreaterThan(70_000)
    expect(standard).toBeLessThan(91_000)
    const fast = await detection({ interval: "10" })
    expect(fast).toBeGreaterThan(22_000)
    expect(fast).toBeLessThan(31_000)
    const once = await detection({ failureThreshold: 1 })
    expect(once).toBeGreaterThan(10_000)
    expect(once).toBeLessThan(31_000)
  })

  it("notices a recovery sooner than a failure: more than 18% saying healthy is enough", async () => {
    const r = await run(dns({ settings: { policy: "failover" }, endpoints: FAILOVER }), 400_000, [[30_000, outage("a")], [200_000, recover]])
    const back = recordOf(r.state, "a").changedAt - 200_000
    // 3 of 16 checkers: the 3rd of 16 random phases, about 0.18 of an interval, after 2 more checks.
    expect(back).toBeGreaterThan(60_000)
    expect(back).toBeLessThan(75_000)
  })

  it("probes through the edge: every checker every interval, so about 16 every 30 s per endpoint", async () => {
    const r = await run(dns({ rps: 0, settings: { policy: "failover" }, endpoints: FAILOVER }), 300_000)
    expect(edgeCalls(r.all, "a", 30_000)).toBeGreaterThan(0.45)
    expect(edgeCalls(r.all, "a", 30_000)).toBeLessThan(0.62)
    expect(r.state.records.map((x) => x.checkers)).toEqual([16, 16])
    const fewer = await run(dns({ rps: 0, settings: { policy: "failover", healthCheck: { regions: 3 } }, endpoints: FAILOVER }), 10_000)
    expect(fewer.state.records.map((x) => x.checkers)).toEqual([6, 6])
  })

  it("sees an endpoint in a region that is out, because the checks cross the network to it", async () => {
    const b = Builder.make("regional", { seed: 5 })
    const users = b.add("common.client", { id: "users", settings: { rps: 100 } })
    const r53 = b.add("aws.route53", { id: "dns", region: "us-east-2", settings: { policy: "failover", healthCheck: { interval: "10" } } })
    b.connect(users, r53, { request: { operation: "read" } })
    const east = b.add("aws.s3", { id: "east", region: "us-east-1" })
    const west = b.add("aws.s3", { id: "west", region: "us-west-2" })
    b.connect(r53, east, { role: "primary" }, { id: "dns->east" })
    b.connect(r53, west, { role: "secondary" }, { id: "dns->west" })
    const r = await run(b.build(), 150_000, [[20_000, (s) => s.faults.inject({ kind: "region", id: "aws:us-east-1" }, DOWN)]])
    expect(recordOf(r.state, "east").healthy).toBe(false)
    expect(edgeCalls(r.all, "west", 120_000)).toBeGreaterThan(95)
    expect(errorShare(r.all, 120_000, 150_000)).toBeLessThan(0.01)
  })

  it("HTTP checks fail an endpoint that answers with errors; TCP checks only connect, so they pass it", async () => {
    const failing = (type: string) =>
      run(dns({ settings: { policy: "failover", healthCheck: { type, interval: "10" } }, endpoints: FAILOVER }), 120_000, [[
        10_000,
        (s) => s.faults.inject({ kind: "node", id: "a" }, { _tag: "Errors", rate: 1 })
      ]])
    const http = await failing("http")
    expect(recordOf(http.state, "a").healthy).toBe(false)
    expect(errorShare(http.all, 100_000, 120_000)).toBeLessThan(0.01)
    const tcp = await failing("tcp")
    expect(recordOf(tcp.state, "a").healthy).toBe(true)
    expect(errorShare(tcp.all, 100_000, 120_000)).toBeGreaterThan(0.99)
  })

  it("HTTP checks fail an endpoint slower than 2 s to answer, though its callers still get answers", async () => {
    const r = await run(dns({ settings: { policy: "failover", healthCheck: { interval: "10" } }, endpoints: FAILOVER }), 130_000, [[
      10_000,
      (s) => s.faults.inject({ kind: "node", id: "a" }, { _tag: "Slow", extra: Duration.seconds(3) })
    ]])
    expect(recordOf(r.state, "a").healthy).toBe(false)
    expect(recordOf(r.state, "b").healthy).toBe(true)
    expect(errorShare(r.all, 20_000, 130_000)).toBe(0)
    expect(edgeCalls(r.all, "b", 110_000)).toBeGreaterThan(190)
  })

  it("holds no more health checks than the account's quota; a record without one is always healthy", async () => {
    const r = await run(dns({ settings: { policy: "failover", healthCheck: { interval: "10" } }, endpoints: FAILOVER, account: { route53HealthChecks: 1 } }), 90_000, [[20_000, outage("b")]])
    expect(r.state.healthChecks).toBe(1)
    expect(r.state.healthChecksRefused).toBe(1)
    expect(recordOf(r.state, "a").healthChecked).toBe(true)
    expect(recordOf(r.state, "b").healthChecked).toBe(false)
    expect(recordOf(r.state, "b").healthy).toBe(true)
  })

  it("shares the quota between the records of an account", async () => {
    const b = Builder.make("two", { seed: 1 })
    const users = b.add("common.client", { id: "users", settings: { rps: 10 } })
    for (const id of ["one", "two"]) {
      const r = b.add("aws.route53", { id, settings: { policy: "weighted" } })
      b.connect(users, r)
      for (const to of ["x", "y"]) {
        const ep = b.add("common.http-endpoint", { id: `${id}-${to}` })
        b.connect(r, ep)
      }
    }
    b.account("aws:us-east-1", { route53HealthChecks: 3 })
    const counts = await sim(b.build(), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(5_000)
        return [(yield* stateOf(s, "one")).healthChecks, (yield* stateOf(s, "two")).healthChecks]
      }))
    expect(counts[0]! + counts[1]!).toBe(3)
  })
})

describe("aws.route53: the TTL lag", () => {
  it("moves the traffic over gradually across one TTL after detection, as the caches expire", async () => {
    const r = await run(dns({ settings: { policy: "failover" }, endpoints: FAILOVER }), 260_000, [[60_000, outage("a")]])
    const detected = recordOf(r.state, "a").changedAt
    // Before detection every cache still points at the primary; within the TTL after, about half; after it, none.
    expect(errorShare(r.all, 65_000, detected - 2_000)).toBeGreaterThan(0.99)
    expect(gauge(r.all, "cachedUnhealthy", detected + 1_000, detected + 2_000)).toBeGreaterThan(0.95)
    const halfway = gauge(r.all, "cachedUnhealthy", detected + 29_000, detected + 31_000)
    expect(halfway).toBeGreaterThan(0.35)
    expect(halfway).toBeLessThan(0.65)
    expect(errorShare(r.all, detected + 22_000, detected + 38_000)).toBeGreaterThan(0.3)
    expect(errorShare(r.all, detected + 22_000, detected + 38_000)).toBeLessThan(0.7)
    expect(errorShare(r.all, detected + 61_000, 260_000)).toBe(0)
  })

  it("a longer TTL is a longer lag: 300 s leaves most callers on the dead endpoint two minutes after detection", async () => {
    const r = await run(dns({ settings: { policy: "failover", ttl: "300 seconds", healthCheck: { interval: "10" } }, endpoints: FAILOVER }), 200_000, [[30_000, outage("a")]])
    const detected = recordOf(r.state, "a").changedAt
    const later = errorShare(r.all, detected + 110_000, detected + 130_000)
    expect(later).toBeGreaterThan(0.45)
    expect(later).toBeLessThan(0.75)
  })

  it("resolvers that ignore the TTL keep their share of the traffic on the dead endpoint long after", async () => {
    const r = await run(
      dns({ settings: { policy: "failover", healthCheck: { interval: "10" }, resolvers: { lookup: LOOKUP, ignoreTtlShare: 0.1, ignoreTtlFor: "10 minutes" } }, endpoints: FAILOVER }),
      200_000,
      [[30_000, outage("a")]]
    )
    const detected = recordOf(r.state, "a").changedAt
    // 10% of caches hold answers for 10 minutes; a minute after the TTL ran out, about 9 in 10 of them still do.
    const lingering = errorShare(r.all, detected + 70_000, detected + 100_000)
    expect(lingering).toBeGreaterThan(0.06)
    expect(lingering).toBeLessThan(0.13)
  })
})

describe("aws.route53: hardening", () => {
  it("a record with no values answers NXDOMAIN, which is not retried", async () => {
    const b = Builder.make("empty")
    const users = b.add("common.client", { id: "users", settings: { rps: 20 } })
    const record = b.add("aws.route53", { id: "dns" })
    b.connect(users, record, { retry: { maxAttempts: 3 } })
    const r = await run(b.build(), 5_000)
    expect(rate(r.all, "users", "fail.Rejected", 1_000)).toBeGreaterThan(15)
    expect(r.state.records).toEqual([])
  })

  it("takes live edits: more caches, a new policy, a new TTL", async () => {
    const r = await run(dns({ settings: { ttl: "5 seconds" }, endpoints: FAILOVER }), 60_000, [[
      20_000,
      (s) => s.configureNode("dns", { policy: "failover", ttl: "1 second", resolvers: { count: 50_000, lookup: LOOKUP } })
    ], [40_000, (s) => s.configureNode("dns", { policy: "failover", resolvers: { count: 1, lookup: LOOKUP } })]])
    expect(r.state.resolvers).toBe(1)
    expect(edgeCalls(r.all, "b", 30_000, 40_000)).toBeLessThan(2)
    expect(errorShare(r.all, 0, 60_000)).toBe(0)
    expect(r.state.healthChecks).toBe(2)
  })

  it("is deterministic: the same design and seed give the same run", async () => {
    const once = () => run(dns({ settings: { policy: "weighted" }, endpoints: [{ id: "a" }, { id: "b" }] }), 20_000, [[5_000, outage("a")]])
    const [x, y] = [await once(), await once()]
    expect(x.state).toEqual(y.state)
  })

  it("one caller (a hot key) sits behind one cache", async () => {
    const b = Builder.make("hot", { seed: 1 })
    const users = b.add("common.client", { id: "users", settings: { rps: 100, hotKeys: 1 } })
    const record = b.add("aws.route53", { id: "dns", settings: { policy: "weighted" } })
    b.connect(users, record)
    for (const id of ["a", "b"]) {
      const ep = b.add("common.http-endpoint", { id })
      b.connect(record, ep, {}, { id: `dns->${id}` })
    }
    const r = await run(b.build(), 30_000)
    expect(r.state.cached).toBe(1)
    expect(Math.min(edgeCalls(r.all, "a", 2_000), edgeCalls(r.all, "b", 2_000))).toBeLessThan(5)
  })
})

describe("aws.route53: audit", () => {
  it("points out a TTL above AWS's advice for health-checked records, and resolvers that ignore TTLs", () => {
    const decode = (settings: Record<string, unknown>) => Schema.decodeUnknownSync(Route53.config as never)(settings)
    const codes = (settings: Record<string, unknown>) => audit("us-east-1", [{ id: "dns", name: "DNS", type: "aws.route53", config: decode(settings) }], {}).map((d) => d.code)
    expect(codes({})).toEqual([])
    expect(codes({ policy: "failover", ttl: "60 seconds" })).toEqual([])
    expect(codes({ policy: "failover", ttl: "300 seconds" })).toEqual(["route53-ttl-above-health-check-advice"])
    // Simple routing has no health checks, so a long TTL is only slow to change.
    expect(codes({ ttl: "300 seconds" })).toEqual([])
    expect(codes({ resolvers: { ignoreTtlShare: 0.05 } })).toEqual(["route53-resolvers-ignore-ttl"])
    expect(audit("us-east-1", [{ id: "q", name: "q", type: "aws.sqs", config: {} }], {})).toEqual([])
  })
})
