import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../../Builder.ts"
import { dist, frames, mean, sim } from "../../components/testing.ts"
import type * as Simulation from "../../Simulation.ts"

/** The viewer's edge: reads (a cache fills with GETs) over a fixed, known latency. */
const READ = { request: { operation: "read" }, latency: { mean: 5, cv: 0 } }
const PROXY = { request: { operation: "write" }, latency: { mean: 5, cv: 0 } }

interface Origin {
  readonly id: string
  /** Settings of the `common.http-endpoint` behind it. */
  readonly settings?: Record<string, unknown>
  /** Settings of the edge from the distribution. */
  readonly edge?: Record<string, unknown>
}

interface Options {
  readonly settings?: Record<string, unknown>
  readonly load?: Record<string, unknown>
  readonly viewer?: Record<string, unknown>
  readonly origins?: ReadonlyArray<Origin>
  readonly account?: Record<string, unknown>
}

/** A client in front of a distribution in front of one or more fixed-latency HTTP origins. */
const cdn = (o: Options = {}) => {
  const b = Builder.make("cdn", { seed: 4 })
  const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 200, ...o.load } })
  const cf = b.add("aws.cloudfront", { id: "cf", settings: { edge: { latency: { mean: 3, cv: 0 } }, ...o.settings } })
  b.connect(web, cf, o.viewer ?? READ)
  for (const origin of o.origins ?? [{ id: "origin" }]) {
    const node = b.add("common.http-endpoint", { id: origin.id, settings: { latency: { mean: 50, cv: 0 }, ...origin.settings } })
    b.connect(cf, node, { latency: { mean: 2, cv: 0 }, ...origin.edge })
  }
  if (o.account !== undefined) b.account("aws:us-east-1", o.account)
  return b.build()
}

interface State {
  readonly objects: number
  readonly ttlSeconds: number
  readonly edgeObjects: number
  readonly regionalObjects: number
  readonly shieldObjects: number
  readonly fetching: number
  readonly hitRatio: number
  readonly recentHitRatio: number
  readonly requests: number
  readonly hits: number
  readonly misses: number
  readonly collapsed: number
  readonly staleServed: number
  readonly originRequests: number
  readonly evictions: number
  readonly errors: { readonly client: number; readonly server: number }
}
const stateOf = (s: Simulation.Service, id = "cf") => Effect.map(s.probe(id), (p) => p.state as State)

/** Run a design for `ms`, and give back the distribution's state at the end and every frame. */
const run = (doc: ReturnType<typeof cdn>, ms: number) =>
  sim(doc, (s) =>
    Effect.gen(function*() {
      const all = yield* s.advanceTo(ms)
      return { state: yield* stateOf(s), all }
    }))

const ok = (all: Parameters<typeof mean>[0], from = 0, to = Infinity) => mean(all, "nodes", "web", "rates", "ok", from, to)
const failed = (all: Parameters<typeof mean>[0], tag: string, from = 0, to = Infinity) => mean(all, "nodes", "web", "rates", `fail.${tag}`, from, to)
const cfRate = (all: Parameters<typeof mean>[0], name: string, from = 0, to = Infinity) => mean(all, "nodes", "cf", "rates", name, from, to)

describe("aws.cloudfront: the hit ratio emerges", () => {
  it("is near 1 when there are few objects and near 0 when there are many", async () => {
    const few = await run(cdn({ settings: { objects: 20 } }), 40_000)
    expect(few.state.hitRatio).toBeGreaterThan(0.99)
    expect(few.state.originRequests).toBe(20)
    // 8,000 requests over a million objects: nearly every one is the first for its object.
    const many = await run(cdn({ settings: { objects: 1_000_000 } }), 40_000)
    expect(many.state.hitRatio).toBeLessThan(0.02)
    expect(many.state.originRequests).toBeGreaterThan(7_800)
  })

  it("one hot key is one object: it is fetched once and then served from the cache", async () => {
    const { state } = await run(cdn({ settings: { objects: 10_000 }, load: { hotKeys: 1 } }), 20_000)
    expect(state.originRequests).toBe(1)
    expect(state.edgeObjects).toBe(1)
    expect(state.hitRatio).toBeGreaterThan(0.999)
  })

  it("a skewed popularity makes the same catalogue far easier to cache", async () => {
    const run4 = (popularitySkew: number) => run(cdn({ settings: { objects: 100_000, popularitySkew } }), 40_000)
    const even = await run4(1)
    const skewed = await run4(5)
    expect(even.state.hitRatio).toBeLessThan(0.1)
    expect(skewed.state.hitRatio).toBeGreaterThan(0.25)
    expect(skewed.state.originRequests).toBeLessThan(even.state.originRequests * 0.8)
  })

  it("rises as the cache warms: the first minute misses, the next hits", async () => {
    const { all } = await run(cdn({ settings: { objects: 2_000 } }), 60_000)
    const early = mean(all, "nodes", "cf", "gauges", "cacheHitRate", 1_000, 5_000)
    const late = mean(all, "nodes", "cf", "gauges", "cacheHitRate", 50_000)
    expect(early).toBeLessThan(0.6)
    expect(late).toBeGreaterThan(0.97)
  })

  it("answers a hit in the edge's own time and a miss in the origin's", async () => {
    // Viewer 5 ms each way, edge 3 ms, origin 2 ms each way plus 50 ms: a hit is 13 ms, a miss 13 + 54 + regional hops (2 x 10 ms).
    const hit = await run(cdn({ settings: { objects: 1 } }), 10_000)
    expect(dist(hit.all, "web", "latency", 2_000).mean).toBeCloseTo(13, 0)
    const miss = await run(cdn({ settings: { objects: 10_000_000 }, load: { rps: 20 } }), 10_000)
    expect(dist(miss.all, "web", "latency", 2_000).mean).toBeCloseTo(13 + 54 + 20, 0)
    const direct = await run(cdn({ settings: { objects: 10_000_000, regionalEdgeCache: { enabled: false } }, load: { rps: 20 } }), 10_000)
    expect(dist(direct.all, "web", "latency", 2_000).mean).toBeCloseTo(13 + 54, 0)
  })
})

describe("aws.cloudfront: TTL", () => {
  const ttlOf = async (cache: Record<string, unknown>) =>
    (await run(cdn({ settings: { objects: 1, cache }, load: { rps: 1 } }), 1_000)).state.ttlSeconds

  it("follows the documented table of Cache-Control, minimum, default and maximum TTL", async () => {
    // No header: the default TTL, or the minimum if that is higher.
    expect(await ttlOf({ defaultTtl: "1 day" })).toBe(86_400)
    expect(await ttlOf({ defaultTtl: "60 seconds", minTtl: "5 minutes" })).toBe(300)
    // max-age: clamped between minimum and maximum.
    expect(await ttlOf({ originCacheControl: "max-age", originMaxAge: "1 hour" })).toBe(3_600)
    expect(await ttlOf({ originCacheControl: "max-age", originMaxAge: "1 hour", maxTtl: "10 minutes" })).toBe(600)
    expect(await ttlOf({ originCacheControl: "max-age", originMaxAge: "10 seconds", minTtl: "1 minute" })).toBe(60)
    // no-store: not cached, unless the minimum TTL overrides it.
    expect(await ttlOf({ originCacheControl: "no-store" })).toBe(0)
    expect(await ttlOf({ originCacheControl: "no-store", minTtl: "30 seconds" })).toBe(30)
  })

  it("an object is fetched again once its TTL has passed", async () => {
    const { state } = await run(cdn({ settings: { objects: 1, cache: { defaultTtl: "10 seconds" } }, load: { rps: 50 } }), 60_000)
    // At about 0, 10, 20, 30, 40 and 50 seconds.
    expect(state.originRequests).toBeGreaterThanOrEqual(5)
    expect(state.originRequests).toBeLessThanOrEqual(7)
    expect(state.hitRatio).toBeGreaterThan(0.99)
  })

  it("a max-age is capped by the maximum TTL", async () => {
    const settings = { objects: 1, cache: { originCacheControl: "max-age", originMaxAge: "1 hour", maxTtl: "5 seconds" } }
    const { state } = await run(cdn({ settings, load: { rps: 50 } }), 30_000)
    expect(state.originRequests).toBeGreaterThanOrEqual(5)
    expect(state.originRequests).toBeLessThanOrEqual(7)
  })

  it("no-store means every request goes to the origin and nothing is cached or collapsed", async () => {
    const { state } = await run(cdn({ settings: { objects: 1, cache: { originCacheControl: "no-store" } }, load: { rps: 100 } }), 10_000)
    expect(state.originRequests).toBe(state.requests)
    expect(state.edgeObjects).toBe(0)
    expect(state.collapsed).toBe(0)
  })

  it("a changed TTL applies to the next fetch", () =>
    sim(cdn({ settings: { objects: 1, cache: { defaultTtl: "1 day" } }, load: { rps: 50 } }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(10_000)
        expect((yield* stateOf(s)).originRequests).toBe(1)
        yield* s.configureNode("cf", { objects: 1, edge: { latency: { mean: 3, cv: 0 } }, cache: { defaultTtl: "2 seconds" } })
        yield* s.advanceTo(30_000)
        // The cached copy keeps its day until it expires, which is far off: nothing new yet. A purge brings the new TTL in.
        expect((yield* stateOf(s)).originRequests).toBe(1)
        yield* s.configureNode("cf", { objects: 1, edge: { latency: { mean: 3, cv: 0 } }, cache: { defaultTtl: "2 seconds" }, invalidation: { propagation: 0, purgeVersion: 1 } })
        yield* s.advanceTo(50_000)
        expect((yield* stateOf(s)).originRequests).toBeGreaterThan(8)
      })))
})

describe("aws.cloudfront: request collapsing", () => {
  it("concurrent misses for one object make one origin request", async () => {
    const { state, all } = await run(cdn({ settings: { objects: 1 }, origins: [{ id: "origin", settings: { latency: { mean: 400, cv: 0 } } }], load: { rps: 100 } }), 5_000)
    expect(state.originRequests).toBe(1)
    // About 40 requests arrive during the 400 ms the first one is away, and all of them are answered by it.
    expect(state.collapsed).toBeGreaterThan(30)
    expect(ok(all, 1_000)).toBeCloseTo(100, -1)
    expect(state.hitRatio).toBeGreaterThan(0.99)
  })

  it("is per edge location: each location makes its own request unless a regional cache joins them", async () => {
    const settings = { objects: 1, edge: { locations: 8, latency: { mean: 3, cv: 0 } } }
    const origins = [{ id: "origin", settings: { latency: { mean: 400, cv: 0 } } }]
    const direct = await run(cdn({ settings: { ...settings, regionalEdgeCache: { enabled: false } }, origins }), 5_000)
    expect(direct.state.originRequests).toBe(8)
    const regional = await run(cdn({ settings, origins }), 5_000)
    expect(regional.state.originRequests).toBe(1)
  })

  it("a viewer that gives up does not stop the fetch or leave anything behind", () =>
    sim(cdn({ settings: { objects: 1 }, viewer: { ...READ, timeout: "50 millis" }, origins: [{ id: "origin", settings: { latency: { mean: 1_000, cv: 0 } } }], load: { rps: 20 } }), (s) =>
      Effect.gen(function*() {
        const all = yield* s.advanceTo(500)
        expect(failed(all, "Timeout", 100)).toBeGreaterThan(10)
        // Everyone has given up, and the one fetch is still away.
        expect((yield* stateOf(s)).fetching).toBe(1)
        yield* s.advanceTo(3_000)
        const later = yield* stateOf(s)
        // It carried on, filled the cache, and the later requests were hits.
        expect(later.fetching).toBe(0)
        expect(later.edgeObjects).toBe(1)
        expect(later.originRequests).toBe(1)
        expect((yield* s.probe("cf")).inflight).toBe(0)
      })))
})

describe("aws.cloudfront: the cache is bounded", () => {
  it("a flood of distinct keys never grows a cache past its capacity", async () => {
    const settings = { objects: 100_000_000, edge: { capacity: 100, latency: { mean: 3, cv: 0 } }, regionalEdgeCache: { capacity: 500 } }
    const { state } = await run(cdn({ settings, load: { rps: 1_000 } }), 20_000)
    expect(state.edgeObjects).toBeLessThanOrEqual(100)
    expect(state.regionalObjects).toBeLessThanOrEqual(500)
    expect(state.evictions).toBeGreaterThan(10_000)
    expect(state.fetching).toBeLessThan(500)
  })

  it("evicts the least requested: a popular object survives a flood of one-off ones", async () => {
    // Skew 1 puts 10,000 objects through a cache of 500. A hot key (30% of requests) is object 0 and must stay in.
    const settings = { objects: 100_000, edge: { capacity: 500, latency: { mean: 3, cv: 0 } } }
    const uniform = await run(cdn({ settings, load: { rps: 200 } }), 30_000)
    const withHot = await run(cdn({ settings, load: { rps: 200, hotKeys: 0.3 } }), 30_000)
    // The hot object is always a hit; without it nothing is. Its hits are the difference.
    expect(withHot.state.hitRatio - uniform.state.hitRatio).toBeGreaterThan(0.25)
  })

  it("a smaller capacity set while running trims the cache as it fills", () =>
    sim(cdn({ settings: { objects: 1_000, edge: { capacity: 1_000, latency: { mean: 3, cv: 0 } } } }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(20_000)
        expect((yield* stateOf(s)).edgeObjects).toBeGreaterThan(900)
        yield* s.configureNode("cf", { objects: 1_000, edge: { capacity: 50, latency: { mean: 3, cv: 0 } } })
        yield* s.advanceTo(40_000)
        expect((yield* stateOf(s)).edgeObjects).toBeLessThanOrEqual(50)
      })))
})

describe("aws.cloudfront: regional edge cache and Origin Shield", () => {
  const spread = { objects: 200, edge: { locations: 40, latency: { mean: 3, cv: 0 } } }

  it("the regional edge cache cuts origin requests: every location's miss lands on one shared cache", async () => {
    const without = await run(cdn({ settings: { ...spread, regionalEdgeCache: { enabled: false } }, load: { rps: 500 } }), 60_000)
    const regional = await run(cdn({ settings: spread, load: { rps: 500 } }), 60_000)
    // Without it every location fetches every object it is asked for; with it each object is fetched once.
    expect(regional.state.originRequests).toBe(200)
    expect(without.state.originRequests).toBeGreaterThan(2_000)
    expect(regional.state.hitRatio).toBeGreaterThan(without.state.hitRatio)
    expect(regional.state.regionalObjects).toBe(200)
  })

  it("it also keeps objects the edge locations have evicted", async () => {
    const small = { objects: 500, edge: { capacity: 100, latency: { mean: 3, cv: 0 } } }
    const off = await run(cdn({ settings: { ...small, regionalEdgeCache: { enabled: false } }, load: { rps: 200 } }), 60_000)
    const on = await run(cdn({ settings: small, load: { rps: 200 } }), 60_000)
    expect(off.state.originRequests).toBeGreaterThan(5_000)
    expect(on.state.originRequests).toBe(500)
  })

  it("several regional caches each fetch an object; Origin Shield makes it one for all of them", async () => {
    const settings = { objects: 100, edge: { locations: 40, latency: { mean: 3, cv: 0 } }, regionalEdgeCache: { locations: 4 } }
    const two = await run(cdn({ settings, load: { rps: 500 } }), 60_000)
    expect(two.state.originRequests).toBeGreaterThan(300)
    expect(two.state.originRequests).toBeLessThanOrEqual(400)
    const shielded = await run(cdn({ settings, load: { rps: 500 }, origins: [{ id: "origin", edge: { shield: true } }] }), 60_000)
    expect(shielded.state.originRequests).toBe(100)
    expect(shielded.state.shieldObjects).toBe(100)
  })

  it("proxied writes skip the regional cache but pass through Origin Shield, and are never cached", async () => {
    const { state } = await run(cdn({ settings: { objects: 1 }, viewer: PROXY, load: { rps: 50 }, origins: [{ id: "origin", edge: { shield: true } }] }), 10_000)
    // Every request but those still on their way to the origin has reached it.
    expect(state.originRequests).toBeGreaterThan(state.requests - 5)
    expect(state.originRequests).toBeLessThanOrEqual(state.requests)
    expect(state.regionalObjects).toBe(0)
    expect(state.shieldObjects).toBe(0)
  })
})

describe("aws.cloudfront: origins and failover", () => {
  const down = { _tag: "Outage" } as const
  const group = [{ id: "primary" }, { id: "backup", edge: { role: "secondary" } }]

  it("splits the objects between primary origins by weight, the same object always to the same origin", async () => {
    const doc = cdn({ settings: { objects: 400 }, origins: [{ id: "a", edge: { weight: 1 } }, { id: "b", edge: { weight: 3 } }] })
    await sim(doc, (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(30_000)
        const served = (id: string) => Effect.map(s.probe(id), (p) => (p.state as { served: number }).served)
        const a = yield* served("a")
        const b = yield* served("b")
        expect(a + b).toBe(400) // every object fetched exactly once, from exactly one origin
        expect(a).toBeGreaterThan(70)
        expect(a).toBeLessThan(130)
        // Twice the traffic and a refetch of nothing: an object does not move between origins.
        yield* s.advanceTo(60_000)
        expect((yield* served("a")) + (yield* served("b"))).toBe(400)
      }))
  })

  it("fails over to the secondary origin when the primary is down, for reads", () =>
    sim(cdn({ settings: { objects: 50 }, origins: group }), (s) =>
      Effect.gen(function*() {
        yield* s.faults.inject({ kind: "node", id: "primary" }, down)
        const all = yield* s.advanceTo(20_000)
        expect(failed(all, "Failed")).toBe(0)
        expect(ok(all, 2_000)).toBeCloseTo(200, -1)
        expect(cfRate(all, "failover", 0, 10_000)).toBeGreaterThan(0)
        expect(((yield* s.probe("backup")).state as { served: number }).served).toBe(50)
      })))

  it("without a secondary the viewer gets a 502 when the connection is refused", () =>
    sim(cdn({ settings: { objects: 50 } }), (s) =>
      Effect.gen(function*() {
        yield* s.faults.inject({ kind: "node", id: "origin" }, down)
        const all = yield* s.advanceTo(10_000)
        expect(failed(all, "Failed", 1_000)).toBeGreaterThan(150)
        expect(cfRate(all, "err502", 1_000)).toBeGreaterThan(150)
        expect(ok(all)).toBe(0)
      })))

  it("tries a refused connection as many times as the origin's connection attempts", () =>
    sim(cdn({ settings: { objects: 1_000_000, cache: { errorMinTtl: 0 } }, origins: [{ id: "origin", edge: { connectionAttempts: 3 } }], load: { rps: 50 } }), (s) =>
      Effect.gen(function*() {
        yield* s.faults.inject({ kind: "node", id: "origin" }, down)
        const all = yield* s.advanceTo(10_000)
        // Three tries per request: the first plus two retries.
        expect(cfRate(all, "originRetries", 2_000)).toBeCloseTo(2 * cfRate(all, "originRequests", 2_000), -1)
      })))

  it("fails over only on the status codes selected", () =>
    sim(cdn({ settings: { objects: 50, failover: { status500: false, status502: false, status503: false, status504: false } }, origins: group }), (s) =>
      Effect.gen(function*() {
        yield* s.faults.inject({ kind: "node", id: "primary" }, down)
        const all = yield* s.advanceTo(10_000)
        expect(failed(all, "Failed", 1_000)).toBeGreaterThan(150)
        expect(cfRate(all, "failover")).toBe(0)
      })))

  it("fails over on a 5xx the origin returns, and relays one when there is nowhere to go", async () => {
    const flaky = { id: "primary", settings: { errorRate: 1 } }
    const withBackup = await run(cdn({ settings: { objects: 50 }, origins: [flaky, { id: "backup", edge: { role: "secondary" } }] }), 10_000)
    expect(failed(withBackup.all, "Failed")).toBe(0)
    const alone = await run(cdn({ settings: { objects: 50 }, origins: [flaky] }), 10_000)
    expect(failed(alone.all, "Failed", 1_000)).toBeGreaterThan(150)
  })

  it("never fails a write over: a POST is not repeated against another origin", () =>
    sim(cdn({ settings: { objects: 50 }, viewer: PROXY, origins: group }), (s) =>
      Effect.gen(function*() {
        yield* s.faults.inject({ kind: "node", id: "primary" }, down)
        const all = yield* s.advanceTo(10_000)
        expect(failed(all, "Failed", 1_000)).toBeGreaterThan(150)
        expect(((yield* s.probe("backup")).state as { served: number }).served).toBe(0)
      })))

  it("an unwired distribution answers 502 and serves nothing from nowhere", async () => {
    const doc = cdn({ origins: [] })
    const { all } = await run(doc, 5_000)
    expect(failed(all, "Failed", 1_000)).toBeGreaterThan(150)
  })

  it("keeps serving cached objects while the origin is down", () =>
    sim(cdn({ settings: { objects: 20 } }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(10_000)
        yield* s.faults.inject({ kind: "node", id: "origin" }, down)
        const all = yield* s.advanceTo(20_000)
        expect(failed(all, "Failed", 10_000)).toBe(0)
        expect(ok(all, 11_000)).toBeCloseTo(200, -1)
      })))
})

describe("aws.cloudfront: origin timeouts", () => {
  /** A viewer's failures carry no latency, so find when the first one arrived: the end of the frame it landed in. */
  const firstFailureAt = (all: Parameters<typeof mean>[0], tag: string): number => all.find((f) => (f.nodes.web?.rates[`fail.${tag}`] ?? 0) > 0)?.t ?? Infinity
  const slow = (edge: Record<string, unknown>, originMs = 10_000, settings: Record<string, unknown> = {}) =>
    cdn({
      settings: { objects: 1_000_000, regionalEdgeCache: { enabled: false }, ...settings },
      load: { rps: 1 },
      origins: [{ id: "origin", settings: { latency: { mean: originMs, cv: 0 } }, edge }]
    })
  /** Viewer 5 ms each way, edge 3 ms; the first request is sent at 1 s. */
  const arrives = (waitMs: number) => 1_000 + 5 + waitMs + 3 + 5

  it("answers 504 after the response timeout, once per connection attempt for a GET to a custom origin", async () => {
    const one = await run(slow({ responseTimeout: "1 second", connectionAttempts: 1 }), 12_000)
    expect(firstFailureAt(one.all, "Timeout")).toBeGreaterThanOrEqual(arrives(1_000))
    expect(firstFailureAt(one.all, "Timeout")).toBeLessThanOrEqual(arrives(1_000) + 250)
    const three = await run(slow({ responseTimeout: "1 second", connectionAttempts: 3 }), 12_000)
    expect(firstFailureAt(three.all, "Timeout")).toBeGreaterThanOrEqual(arrives(3_000))
    expect(firstFailureAt(three.all, "Timeout")).toBeLessThanOrEqual(arrives(3_000) + 250)
    expect(cfRate(three.all, "err504", 5_000)).toBeGreaterThan(0)
    expect(cfRate(three.all, "originRetries")).toBeGreaterThan(0)
  })

  it("does not repeat a write after a timeout", async () => {
    const doc = cdn({ settings: { objects: 1_000 }, viewer: PROXY, load: { rps: 1 }, origins: [{ id: "origin", settings: { latency: { mean: 10_000, cv: 0 } }, edge: { responseTimeout: "1 second", connectionAttempts: 3 } }] })
    const { all } = await run(doc, 12_000)
    expect(firstFailureAt(all, "Timeout")).toBeGreaterThanOrEqual(arrives(1_000))
    expect(firstFailureAt(all, "Timeout")).toBeLessThanOrEqual(arrives(1_000) + 250)
  })

  it("an S3 origin is not retried after a slow response, and keeps AWS's 30 s default", async () => {
    const { all } = await run(slow({ originType: "s3", connectionAttempts: 3, responseTimeout: "1 second" }, 60_000), 40_000)
    expect(Math.abs(firstFailureAt(all, "Timeout") - arrives(30_000))).toBeLessThanOrEqual(300)
  })

  it("a completion timeout cuts the whole exchange short", async () => {
    const { all } = await run(slow({ responseTimeout: "1 second", connectionAttempts: 3, responseCompletionTimeout: "1500 millis" }), 12_000)
    expect(firstFailureAt(all, "Timeout")).toBeGreaterThanOrEqual(arrives(1_500))
    expect(firstFailureAt(all, "Timeout")).toBeLessThanOrEqual(arrives(1_500) + 250)
  })

  it("an origin that answers within the timeout is not a timeout", async () => {
    const { all } = await run(cdn({ origins: [{ id: "origin", edge: { responseTimeout: "1 second" } }] }), 5_000)
    expect(failed(all, "Timeout")).toBe(0)
    expect(ok(all, 1_000)).toBeCloseTo(200, -1)
  })

  it("the origin carries on after CloudFront gives up, as it does in AWS", () =>
    sim(slow({ responseTimeout: "1 second", connectionAttempts: 1 }, 3_000), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(8_000)
        const served = ((yield* s.probe("origin")).state as { served: number; inflight: number })
        expect(served.served).toBeGreaterThan(0) // it finished work whose caller had already left
      })))
})

describe("aws.cloudfront: errors", () => {
  it("caches an origin error for the error caching minimum TTL, then asks again", async () => {
    const settings = { objects: 1, cache: { errorMinTtl: "10 seconds" } }
    const { state, all } = await run(cdn({ settings, origins: [{ id: "origin", settings: { errorRate: 1 } }], load: { rps: 50 } }), 60_000)
    // About 0, 10, ... 50: six asks for thousands of errors.
    expect(state.originRequests).toBeGreaterThanOrEqual(5)
    expect(state.originRequests).toBeLessThanOrEqual(7)
    expect(cfRate(all, "errorsCached", 10_000)).toBeGreaterThan(40)
    expect(failed(all, "Failed", 5_000)).toBeGreaterThan(45)
  })

  it("with an error caching TTL of 0 every request asks the origin", async () => {
    const settings = { objects: 1, cache: { errorMinTtl: 0 }, regionalEdgeCache: { enabled: false } }
    const { state } = await run(cdn({ settings, origins: [{ id: "origin", settings: { errorRate: 1, latency: { mean: 5, cv: 0 } } }], load: { rps: 50 } }), 10_000)
    // Each fetch is over before the next request arrives, so none is collapsed.
    expect(state.originRequests).toBeGreaterThan(state.requests * 0.95)
  })

  it("does not cache a status AWS does not cache (413 here), however brief the TTL", async () => {
    // The origin refuses anything over 1 KB with a 413; the 100 KB object it is asked for is refused every time.
    const settings = { objects: 1, cache: { errorMinTtl: "1 hour" }, regionalEdgeCache: { enabled: false } }
    const { state, all } = await run(cdn({ settings, origins: [{ id: "origin", settings: { maxPayload: 1, latency: { mean: 5, cv: 0 } } }], load: { rps: 50 } }), 10_000)
    expect(state.originRequests).toBeGreaterThan(state.requests * 0.95)
    expect(failed(all, "Rejected", 2_000)).toBeGreaterThan(45)
  })

  it("serves the expired copy when the origin fails, instead of the error", () =>
    sim(cdn({ settings: { objects: 5, cache: { defaultTtl: "5 seconds", errorMinTtl: "10 seconds" } }, load: { rps: 50 } }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(4_000)
        yield* s.faults.inject({ kind: "node", id: "origin" }, { _tag: "Outage" })
        const all = yield* s.advanceTo(40_000)
        expect(failed(all, "Failed")).toBe(0)
        expect(ok(all, 5_000)).toBeCloseTo(50, -1)
        // One request per object per error TTL revalidates and is answered from the expired copy; the rest hit the extended copy.
        expect((yield* stateOf(s)).staleServed).toBeGreaterThanOrEqual(10)
      })))

  it("stale-if-error bounds how long the expired copy may be served", () =>
    sim(cdn({ settings: { objects: 5, cache: { defaultTtl: "5 seconds", errorMinTtl: "2 seconds", staleIfError: "10 seconds" } }, load: { rps: 50 } }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(4_000)
        yield* s.faults.inject({ kind: "node", id: "origin" }, { _tag: "Outage" })
        const all = yield* s.advanceTo(40_000)
        expect(failed(all, "Failed", 1_000, 14_000)).toBe(0)
        expect(failed(all, "Failed", 20_000)).toBeGreaterThan(40)
      })))

  it("stale-while-revalidate answers from the expired copy while one request refreshes it", async () => {
    const settings = { objects: 1, cache: { defaultTtl: "5 seconds", staleWhileRevalidate: "2 seconds" } }
    const origins = [{ id: "origin", settings: { latency: { mean: 800, cv: 0 } } }]
    const withSwr = await run(cdn({ settings, origins, load: { rps: 50 } }), 30_000)
    const without = await run(cdn({ settings: { ...settings, cache: { defaultTtl: "5 seconds" } }, origins, load: { rps: 50 } }), 30_000)
    expect(withSwr.state.staleServed).toBeGreaterThan(50)
    // Without it the viewers that arrive while the refresh is away wait for it (800 ms): about 15 of every 250 requests... at 50 a second.
    expect(dist(without.all, "web", "latency", 6_000).mean).toBeGreaterThan(dist(withSwr.all, "web", "latency", 6_000).mean + 15)
    expect(dist(withSwr.all, "web", "latency", 6_000).mean).toBeCloseTo(13, 0)
  })

  it("counts the status classes the viewers see", async () => {
    const { all } = await run(cdn({ settings: { objects: 1_000_000 }, origins: [{ id: "origin", settings: { errorRate: 1 } }] }), 5_000)
    expect(cfRate(all, "err5xx", 1_000)).toBeGreaterThan(150)
    expect(mean(all, "nodes", "cf", "gauges", "errorRate5xx", 3_000)).toBeGreaterThan(0.9)
  })
})

describe("aws.cloudfront: invalidation", () => {
  it("a scheduled invalidation empties the cache, so every object is fetched again", async () => {
    const settings = { objects: 5, invalidation: { every: "10 seconds", propagation: 0 } }
    const { state } = await run(cdn({ settings, load: { rps: 100 } }), 55_000)
    // Fetched at the start and again after each of the five purges.
    expect(state.originRequests).toBeGreaterThanOrEqual(25)
    expect(state.originRequests).toBeLessThanOrEqual(30)
  })

  it("takes the propagation time to take effect, and serves from the cache until then", () =>
    sim(cdn({ settings: { objects: 5, invalidation: { every: "10 seconds", propagation: "5 seconds" } }, load: { rps: 100 } }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(14_000)
        expect((yield* stateOf(s)).originRequests).toBe(5)
        yield* s.advanceTo(17_000)
        expect((yield* stateOf(s)).originRequests).toBe(10)
      })))

  it("invalidating a share of the objects refetches about that share", async () => {
    const settings = { objects: 1_000, invalidation: { every: "20 seconds", share: 0.25, propagation: 0 } }
    const { state } = await run(cdn({ settings, load: { rps: 500 } }), 25_000)
    // 1,000 first fetches and one purge of a quarter of them.
    expect(state.originRequests).toBeGreaterThan(1_150)
    expect(state.originRequests).toBeLessThan(1_350)
  })

  it("purges everything when the purge number is changed while running", () =>
    sim(cdn({ settings: { objects: 10, invalidation: { propagation: 0 } }, load: { rps: 100 } }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(5_000)
        expect((yield* stateOf(s)).originRequests).toBe(10)
        yield* s.configureNode("cf", { objects: 10, edge: { latency: { mean: 3, cv: 0 } }, invalidation: { propagation: 0, purgeVersion: 1 } })
        yield* s.advanceTo(10_000)
        expect((yield* stateOf(s)).originRequests).toBe(20)
      })))

  it("also empties the regional edge cache and Origin Shield", async () => {
    const settings = { objects: 5, invalidation: { every: "10 seconds", propagation: 0 } }
    const { state } = await run(cdn({ settings, load: { rps: 100 }, origins: [{ id: "origin", edge: { shield: true } }] }), 15_000)
    expect(state.originRequests).toBe(10)
  })
})

describe("aws.cloudfront: methods, bodies and compression", () => {
  it("proxies writes straight to the origin: never cached, counted as uploaded bytes", async () => {
    const { state, all } = await run(cdn({ settings: { objects: 1 }, viewer: PROXY, load: { rps: 50, payload: 4 } }), 10_000)
    expect(state.originRequests).toBe(state.requests)
    expect(state.hits).toBe(0)
    expect(state.edgeObjects).toBe(0)
    expect(cfRate(all, "bytesUploaded", 2_000)).toBeCloseTo(50 * 4 * 1024, -3)
    expect(cfRate(all, "proxied", 2_000)).toBeCloseTo(50, -1)
  })

  it("answers 403 to a write when only GET and HEAD are allowed", async () => {
    const { all } = await run(cdn({ settings: { allowedMethods: "read" }, viewer: PROXY }), 5_000)
    expect(failed(all, "Rejected", 1_000)).toBeGreaterThan(150)
    expect(cfRate(all, "err4xx", 1_000)).toBeGreaterThan(150)
  })

  it("reads are unaffected by the allowed methods", async () => {
    const { all } = await run(cdn({ settings: { allowedMethods: "read" } }), 5_000)
    expect(ok(all, 1_000)).toBeCloseTo(200, -1)
  })

  it("compresses the compressible share of objects between 1,000 and 10,000,000 bytes", async () => {
    // Per response, as a share of the object's own size.
    const bytes = async (objectSize: number, compression: Record<string, unknown> = {}) =>
      cfRate((await run(cdn({ settings: { objects: 1, objectSize, compression }, load: { rps: 50 } }), 5_000)).all, "bytesDownloaded", 2_000) / 50 / (objectSize * 1024)
    // 100 KB, 60% compressible, shrinking to 35%: 40% stays whole and 60% x 0.35 remains.
    expect(await bytes(100)).toBeCloseTo(1 - 0.6 * 0.65, 1)
    expect(await bytes(100, { enabled: false })).toBeCloseTo(1, 1)
    expect(await bytes(0.5)).toBeCloseTo(1, 1) // under 1,000 bytes: left alone
    expect(await bytes(20_000)).toBeCloseTo(1, 1) // over 10,000,000 bytes: left alone
  })
})

describe("aws.cloudfront: edge functions", () => {
  const latencyWith = async (functions: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    dist((await run(cdn({ settings: { objects: 1, functions, ...extra }, load: { rps: 50 } }), 10_000)).all, "web", "latency", 3_000).mean

  it("a CloudFront Function adds under a millisecond, Lambda@Edge tens of them", async () => {
    const base = await latencyWith({})
    expect(await latencyWith({ viewerRequest: "function", cloudFrontFunction: { mean: 0.5, cv: 0 } })).toBeCloseTo(base + 0.5, 1)
    expect(await latencyWith({ viewerRequest: "lambda", lambdaAtEdge: { mean: 40, cv: 0 } })).toBeCloseTo(base + 40, 0)
    expect(await latencyWith({ viewerRequest: "lambda", viewerResponse: "lambda", lambdaAtEdge: { mean: 40, cv: 0 } })).toBeCloseTo(base + 80, 0)
  })

  it("origin-facing functions run only on a miss", async () => {
    const hot = await latencyWith({ originRequest: "lambda", originResponse: "lambda", lambdaAtEdge: { mean: 40, cv: 0 } })
    const base = await latencyWith({})
    expect(hot).toBeCloseTo(base, 0) // one object, nearly all hits
    const cold = dist((await run(cdn({ settings: { objects: 10_000_000, functions: { originRequest: "lambda", originResponse: "lambda", lambdaAtEdge: { mean: 40, cv: 0 } } }, load: { rps: 20 } }), 10_000)).all, "web", "latency", 3_000).mean
    expect(cold).toBeCloseTo(13 + 54 + 20 + 80, 0)
  })

  it("a Lambda@Edge function over its timeout gives the viewer a 503", async () => {
    const functions = { viewerRequest: "lambda", lambdaAtEdge: { mean: 2_000, cv: 0 }, lambdaTimeout: "1 second" }
    const { all } = await run(cdn({ settings: { objects: 1, functions }, load: { rps: 20 } }), 10_000)
    expect(failed(all, "Unavailable", 3_000)).toBeGreaterThan(15)
    expect(cfRate(all, "err503", 3_000)).toBeGreaterThan(15)
    // It was cut off at the timeout, not left to run its 2 s.
    expect(all.find((f) => (f.nodes.web?.rates["fail.Unavailable"] ?? 0) > 0)!.t).toBeLessThan(1_500)
  })

  it("function errors are a 503 at the configured rate", async () => {
    const { all } = await run(cdn({ settings: { objects: 1, functions: { viewerRequest: "function", errorRate: 0.25 } }, load: { rps: 400 } }), 20_000)
    expect(failed(all, "Unavailable", 2_000) / 400).toBeCloseTo(0.25, 1)
  })

  it("Lambda@Edge is throttled over the regional rate, which is an account quota", async () => {
    const functions = { viewerRequest: "lambda", lambdaAtEdge: { mean: 5, cv: 0 } }
    const { all } = await run(cdn({ settings: { objects: 1, functions }, load: { rps: 300 }, account: { cloudfrontLambdaEdgeRate: 100 } }), 60_000)
    expect(ok(all, 30_000)).toBeCloseTo(100, -1)
    expect(failed(all, "Unavailable", 30_000)).toBeGreaterThan(190)
  })
})

describe("aws.cloudfront: price class", () => {
  it("viewers outside the price class's regions pay the farther edge's latency, on average", async () => {
    const mine = (priceClass: string) =>
      run(cdn({ settings: { objects: 1, edge: { priceClass, latency: { mean: 3, cv: 0 }, farLatency: { mean: 100, cv: 0 } } }, load: { rps: 400 } }), 30_000).then((r) => dist(r.all, "web", "latency", 3_000).mean)
    const all = await mine("all")
    expect(all).toBeCloseTo(13, 0)
    expect(await mine("200")).toBeCloseTo(13 + 0.1 * 100, 0)
    expect(await mine("100")).toBeCloseTo(13 + 0.25 * 100, 0)
  })
})

describe("aws.cloudfront: quotas", () => {
  it("throttles over the requests-per-second quota, which is editable", () =>
    sim(cdn({ settings: { objects: 1 }, load: { rps: 400 }, account: { cloudfrontRequestRate: 100 } }), (s) =>
      Effect.gen(function*() {
        const all = yield* s.advanceTo(10_000)
        expect(ok(all, 4_000)).toBeCloseTo(100, -1)
        expect(failed(all, "Throttled", 4_000)).toBeGreaterThan(280)
        yield* s.configureAccount("aws:us-east-1", { cloudfrontRequestRate: 1_000 })
        const more = yield* s.advanceTo(20_000)
        expect(ok(more, 14_000)).toBeCloseTo(400, -1)
        expect(failed(more, "Throttled", 14_000)).toBe(0)
      })))

  it("throttles over the data transfer rate in gigabits a second", async () => {
    // 1 Gbps is 125 MB/s: 10 MB objects, uncompressed, go at 12.5 a second.
    const settings = { objects: 1, objectSize: 10 * 1024, compression: { enabled: false } }
    const { all } = await run(cdn({ settings, load: { rps: 40 }, account: { cloudfrontDataTransferRate: 1 } }), 20_000)
    expect(ok(all, 10_000)).toBeGreaterThan(11)
    expect(ok(all, 10_000)).toBeLessThan(14)
    expect(failed(all, "Throttled", 10_000)).toBeGreaterThan(25)
  })

  it("defaults to AWS's published numbers", () =>
    sim(cdn(), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(1_000)
        const accounts = (yield* s.inspect).accounts as Record<string, Record<string, number>>
        const a = accounts["aws:us-east-1"]!
        expect(a.cloudfrontRequestRate).toBe(250_000)
        expect(a.cloudfrontDataTransferRate).toBe(150)
        expect(a.cloudfrontLambdaEdgeRate).toBe(10_000)
      })))
})

describe("aws.cloudfront: metrics and determinism", () => {
  it("reports the standard metrics as counters and gauges", async () => {
    const { all } = await run(cdn({ settings: { objects: 50 }, load: { rps: 100 } }), 30_000)
    expect(cfRate(all, "requests", 10_000)).toBeCloseTo(100, -1)
    expect(cfRate(all, "bytesDownloaded", 10_000)).toBeGreaterThan(100 * 60_000)
    expect(cfRate(all, "cacheHit", 10_000)).toBeCloseTo(100, -1)
    expect(mean(all, "nodes", "cf", "gauges", "cacheHitRate", 20_000)).toBeCloseTo(1, 2)
    expect(mean(all, "nodes", "cf", "gauges", "edgeObjects", 20_000)).toBe(50)
    const origin = dist(all, "cf", "originLatency")
    // Time to first byte of an origin fetch: regional hops (20), origin edge (4) and origin (50), plus the one at the edge.
    expect(origin.windows).toBeGreaterThan(0)
    expect(origin.mean).toBeGreaterThan(70)
  })

  it("is deterministic: the same design and seed play out identically", async () => {
    const doc = cdn({ settings: { objects: 500, popularitySkew: 2, edge: { locations: 5, latency: { mean: 3, cv: 0.5 } } }, load: { rps: 300, arrival: "poisson" } })
    const a = await run(doc, 20_000)
    const b = await run(doc, 20_000)
    expect(a.state).toEqual(b.state)
    expect(JSON.stringify(a.all)).toEqual(JSON.stringify(b.all))
  })

  it("survives odd inputs: no key spread, zero bytes, no traffic", async () => {
    const odd = await run(cdn({ settings: { objects: 1, objectSize: 0 }, load: { rps: 10, payload: 0.001 } }), 5_000)
    expect(odd.state.requests).toBeGreaterThan(40)
    expect(failed(odd.all, "Failed")).toBe(0)
    const idle = await run(cdn({ load: { rps: 0 } }), 5_000)
    expect(idle.state.requests).toBe(0)
    expect(idle.state.hitRatio).toBe(0)
  })
})

describe("aws.cloudfront: definition", () => {
  it("probes match the declared state, and every gauge the README lists is registered", async () => {
    const { Schema } = await import("effect")
    const { CloudFront } = await import("./index.ts")
    await sim(cdn({ settings: { objects: 50 } }), (s) =>
      Effect.gen(function*() {
        const all = yield* s.advanceTo(5_000)
        const state = (yield* s.probe("cf")).state
        expect(() => Schema.decodeUnknownSync(CloudFront.state as never)(state)).not.toThrow()
        const gauges = Object.keys(all[all.length - 1]!.nodes.cf!.gauges)
        for (const name of ["cacheHitRate", "errorRate4xx", "errorRate5xx", "edgeObjects", "regionalObjects", "shieldObjects", "fetching"]) expect(gauges).toContain(name)
      }))
  })

  it("is registered as aws.cloudfront with the cdn icon, one output port and a read default on its origins", async () => {
    const { CloudFront } = await import("./index.ts")
    const { edgeSchema } = await import("../../Connector.ts")
    const { Link } = await import("../../connectors/index.ts")
    expect(CloudFront.type).toBe("aws.cloudfront")
    expect(CloudFront.icon).toBe("cdn")
    expect(Object.keys(CloudFront.ports)).toEqual(["out"])
    const origin = edgeSchema(Link, CloudFront.ports.out).fields as Record<string, unknown>
    expect(Object.keys(origin)).toEqual(expect.arrayContaining(["originType", "role", "shield", "connectionAttempts", "responseTimeout", "weight", "latency", "retry"]))
  })

  it("refuses a request body over 64 GB", async () => {
    const { bodyTooLarge } = await import("./config.ts")
    expect(bodyTooLarge(64 * 1024 ** 3)).toBe(false)
    expect(bodyTooLarge(64 * 1024 ** 3 + 1)).toBe(true)
  })

  it("contributes exactly the three CloudFront quota fields, each prefixed cloudfront", async () => {
    const { quotas } = await import("./quotas.ts")
    const fields = quotas("eu-west-1")
    expect(Object.keys(fields)).toEqual(["cloudfrontRequestRate", "cloudfrontDataTransferRate", "cloudfrontLambdaEdgeRate"])
  })

  it("drops the caches beyond a smaller number of edge locations", () =>
    sim(cdn({ settings: { objects: 100, edge: { locations: 20, latency: { mean: 3, cv: 0 } } } }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(20_000)
        const wide = (yield* stateOf(s)).edgeObjects
        expect(wide).toBeGreaterThan(1_000) // up to 20 x 100
        yield* s.configureNode("cf", { objects: 100, edge: { locations: 1, latency: { mean: 3, cv: 0 } } })
        yield* s.advanceTo(21_000)
        expect((yield* stateOf(s)).edgeObjects).toBeLessThanOrEqual(100)
      })))
})

describe("aws.cloudfront: audit", () => {
  it("flags a catalogue bigger than the cache, a minimum TTL over the maximum, and an invalidation schedule that costs or breaks the limit", async () => {
    const { audit } = await import("./audit.ts")
    const { CloudFront } = await import("./index.ts")
    const { Schema } = await import("effect")
    const decode = (settings: Record<string, unknown>) => Schema.decodeUnknownSync(CloudFront.config as never)(settings)
    const run1 = (settings: Record<string, unknown>) =>
      audit("us-east-1", [{ id: "cf", name: "CDN", type: "aws.cloudfront", config: decode(settings) }], {}).map((d) => d.code)
    expect(run1({})).toEqual([])
    expect(run1({ objects: 100_000, edge: { capacity: 1_000 } })).toContain("cloudfront-cache-smaller-than-catalog")
    expect(run1({ cache: { minTtl: "2 days", maxTtl: "1 day" } })).toContain("cloudfront-min-ttl-above-max-ttl")
    expect(run1({ invalidation: { every: "30 minutes" } })).toContain("cloudfront-invalidation-cost")
    expect(run1({ invalidation: { every: "500 millis" } })).toContain("cloudfront-invalidation-rate")
  })
})
