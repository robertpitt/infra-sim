import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../../Builder.ts"
import { frames, mean, sim } from "../../components/testing.ts"

type Bag = Record<string, unknown>

/** client -> gateway -> Lambda, the common shape. */
const gateway = (api: Bag, load: Bag, backend: Bag = {}, account?: Bag, region = "us-east-1") => {
  const b = Builder.make("apigw", { seed: 3 })
  const web = b.add("common.client", { id: "web", settings: { arrival: "constant", ...load } })
  const gw = b.add("aws.apigateway", { id: "api", region, settings: api })
  const fn = b.add("aws.lambda", { id: "fn", region, settings: { memory: 1769, duration: { mean: 50, cv: 0 }, ...backend } })
  b.connect(web, gw)
  b.connect(gw, fn)
  if (account !== undefined) b.account(`aws:${region}`, account)
  return b.build()
}

/**
 * client -> gateway -> endpoint, with the edge into the gateway set to `read` (a GET) unless said otherwise and roomy
 * timeouts, for tests of the cache and of timeouts longer than the edge default of 30 s.
 */
const front = (api: Bag, load: Bag, backend: Bag = {}, edgeIn: Bag = {}, edgeOut: Bag = {}, account?: Bag) => {
  const b = Builder.make("front", { seed: 5 })
  const web = b.add("common.client", { id: "web", settings: { arrival: "constant", ...load } })
  const gw = b.add("aws.apigateway", { id: "api", settings: api })
  const ext = b.add("common.http-endpoint", { id: "ext", settings: { latency: { mean: 50, cv: 0 }, ...backend } })
  b.connect(web, gw, { request: { operation: "read" }, timeout: "10 minutes", ...edgeIn })
  b.connect(gw, ext, { timeout: "10 minutes", ...edgeOut })
  if (account !== undefined) b.account("aws:us-east-1", account)
  return b.build()
}

const probe = (s: { readonly probe: (id: string) => Effect.Effect<{ readonly state: unknown }, unknown> }, id: string) =>
  Effect.map(s.probe(id), (p) => p.state as Record<string, number>)

describe("aws.apigateway: throttling", () => {
  it("throttles at the account rate with a token bucket: a burst is absorbed, then the steady rate holds", async () => {
    const all = await frames(gateway({}, { rps: 400 }, {}, { apiGatewayRate: 100 }), 70_000)
    // The 5,000-token bucket absorbs 300/s of excess for about 16 s.
    expect(mean(all, "nodes", "web", "rates", "fail.Throttled", 0, 10_000)).toBe(0)
    expect(mean(all, "nodes", "web", "rates", "ok", 40_000)).toBeCloseTo(100, -1)
    expect(mean(all, "nodes", "web", "rates", "fail.Throttled", 40_000)).toBeGreaterThan(280)
  })

  it("the account rate is shared by every API in the region", () => {
    const b = Builder.make("shared", { seed: 3 })
    const backend = b.add("common.http-endpoint", { id: "ext", settings: { latency: { mean: 10, cv: 0 } } })
    for (const id of ["a", "b"]) {
      const gw = b.add("aws.apigateway", { id })
      b.connect(b.add("common.client", { id: `web-${id}`, settings: { arrival: "constant", rps: 200 } }), gw)
      b.connect(gw, backend)
    }
    b.account("aws:us-east-1", { apiGatewayRate: 100 })
    return frames(b.build(), 70_000).then((all) => {
      const total = mean(all, "nodes", "a", "rates", "ok", 40_000) + mean(all, "nodes", "b", "rates", "ok", 40_000)
      expect(total).toBeCloseTo(100, -1)
    })
  })

  it("applies a stage throttle below the account limit", async () => {
    const all = await frames(gateway({ stageThrottle: { rate: 50, burst: 50 } }, { rps: 200 }), 30_000)
    expect(mean(all, "nodes", "web", "rates", "ok", 10_000)).toBeCloseTo(50, -1)
    expect(mean(all, "nodes", "api", "rates", "throttled.stage", 10_000)).toBeGreaterThan(140)
    expect(mean(all, "nodes", "api", "rates", "throttled.account", 10_000)).toBe(0)
  })

  it("the account limit decides when it is lower than the stage's", async () => {
    const all = await frames(gateway({ stageThrottle: { rate: 500, burst: 500 } }, { rps: 300 }, {}, { apiGatewayRate: 60 }), 90_000)
    expect(mean(all, "nodes", "web", "rates", "ok", 70_000)).toBeCloseTo(60, -1)
    expect(mean(all, "nodes", "api", "rates", "throttled.account", 70_000)).toBeGreaterThan(200)
  })

  it("applies the stage limit to each route, so a hot key saturates one route while the rest are fine", async () => {
    const api = { routes: 10, stageThrottle: { rate: 10, burst: 10 } }
    const spread = await frames(gateway(api, { rps: 200 }), 40_000)
    // Twenty requests a second per route against ten allowed: about 100 get through.
    expect(mean(spread, "nodes", "web", "rates", "ok", 20_000)).toBeCloseTo(100, -1)
    const hot = await frames(gateway(api, { rps: 200, hotKeys: 1 }), 40_000)
    // Every request is for one route, which lets ten a second through.
    expect(mean(hot, "nodes", "web", "rates", "ok", 20_000)).toBeCloseTo(10, 0)
  })

  it("a usage plan throttles each API key on its own, before the stage and account", async () => {
    const api = { usagePlan: { enabled: true, clients: 4, rate: 25, burst: 25 } }
    const all = await frames(gateway(api, { rps: 400 }), 40_000)
    // A hundred a second per key against 25: about 100 get through in all.
    expect(mean(all, "nodes", "web", "rates", "ok", 20_000)).toBeCloseTo(100, -1)
    expect(mean(all, "nodes", "api", "rates", "throttled.usagePlan", 20_000)).toBeGreaterThan(280)
    expect(mean(all, "nodes", "api", "rates", "throttled.account", 20_000)).toBe(0)
  })

  it("a usage plan quota stops a client for the rest of the period", () =>
    sim(gateway({ usagePlan: { enabled: true, clients: 1, rate: 0, quota: 300, period: "day" } }, { rps: 50 }), (s) =>
      Effect.gen(function*() {
        const all = yield* s.advanceTo(20_000)
        const state = yield* probe(s, "api")
        // 50 a second for 20 s is 1,000 requests; 300 are allowed for the day.
        expect(state.served).toBe(300)
        expect(state.quotaExceeded).toBeGreaterThan(650)
        expect(mean(all, "nodes", "api", "rates", "throttled.quota", 15_000)).toBeGreaterThan(45)
        expect(mean(all, "nodes", "web", "rates", "ok", 15_000)).toBe(0)
      })))

  it("usage plans and the cache are REST features: an HTTP API ignores them", async () => {
    const api = { apiType: "http", usagePlan: { enabled: true, clients: 1, rate: 5, burst: 5 } }
    const all = await frames(gateway(api, { rps: 100 }), 10_000)
    expect(mean(all, "nodes", "web", "rates", "ok", 3_000)).toBeCloseTo(100, -1)
  })

  it("takes a live edit of a stage limit on the next request", () =>
    sim(gateway({}, { rps: 100 }), (s) =>
      Effect.gen(function*() {
        const before = yield* s.advanceTo(5_000)
        expect(mean(before, "nodes", "web", "rates", "fail.Throttled", 1_000)).toBe(0)
        yield* s.configureNode("api", { stageThrottle: { rate: 20, burst: 20 } })
        const after = yield* s.advanceTo(15_000)
        expect(mean(after, "nodes", "web", "rates", "ok", 10_000)).toBeCloseTo(20, -1)
      })))

  it("has smaller default quotas in the regions where AWS does", () =>
    sim(gateway({}, { rps: 1 }, {}, undefined, "af-south-1"), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(1_000)
        const accounts = (yield* s.inspect).accounts as Record<string, { apiGatewayRate: number }>
        expect(accounts["aws:af-south-1"]!.apiGatewayRate).toBe(2_500)
      })))
})

describe("aws.apigateway: requests and integrations", () => {
  it("answers 504 when the integration is too slow, while the backend keeps working", () =>
    sim(gateway({ integrationTimeout: "500 millis" }, { rps: 10 }, { duration: { mean: 2_000, cv: 0 }, timeout: "10 seconds" }), (s) =>
      Effect.gen(function*() {
        const all = yield* s.advanceTo(20_000)
        expect(mean(all, "nodes", "web", "rates", "fail.Timeout", 5_000)).toBeGreaterThan(8)
        expect(mean(all, "nodes", "api", "rates", "status.5xx", 5_000)).toBeGreaterThan(8)
        const fn = (yield* s.probe("fn")).state as { concurrent: number }
        expect(fn.concurrent).toBeGreaterThan(10) // the abandoned invocations are still running
      })))

  it("refuses requests over 10 MB with 413, and takes ones just under it", async () => {
    const over = await frames(gateway({}, { rps: 5, payload: 11 * 1024 }), 5_000)
    expect(mean(over, "nodes", "web", "rates", "fail.Rejected", 1_000)).toBeGreaterThan(3)
    expect(mean(over, "nodes", "api", "rates", "status.4xx", 1_000)).toBeGreaterThan(3)
    // Lambda's own synchronous limit is 6 MB, so use an endpoint behind the gateway to see 10 MB get through.
    const under = await frames(front({}, { rps: 5, payload: 9 * 1024 }), 5_000)
    expect(mean(under, "nodes", "web", "rates", "ok", 1_000)).toBeGreaterThan(3)
  })

  it("an HTTP API waits up to 30 s, a REST API only 29 s", async () => {
    const run = (apiType: string) => frames(gateway({ apiType, integrationTimeout: "30 seconds" }, { rps: 1 }, { duration: { mean: 29_500, cv: 0 }, timeout: "40 seconds" }), 90_000)
    const http = await run("http")
    const rest = await run("rest")
    expect(mean(http, "nodes", "web", "rates", "ok", 40_000)).toBeGreaterThan(0.5)
    expect(mean(rest, "nodes", "web", "rates", "fail.Timeout", 40_000)).toBeGreaterThan(0.5)
  })

  it("only an account quota raise lets a Regional REST API wait past 29 s; an edge-optimized one never can", async () => {
    const slow = { latency: { mean: 40_000, cv: 0 } }
    const api = { integrationTimeout: "50 seconds" }
    const raise = { apiGatewayIntegrationTimeout: "60 seconds" }
    const stock = await frames(front(api, { rps: 1 }, slow), 100_000)
    const raised = await frames(front(api, { rps: 1 }, slow, {}, {}, raise), 100_000)
    const edge = await frames(front({ ...api, endpoint: "edge" }, { rps: 1 }, slow, {}, {}, raise), 100_000)
    expect(mean(stock, "nodes", "web", "rates", "fail.Timeout", 60_000)).toBeGreaterThan(0.5)
    expect(mean(raised, "nodes", "web", "rates", "ok", 60_000)).toBeGreaterThan(0.5)
    expect(mean(edge, "nodes", "web", "rates", "fail.Timeout", 60_000)).toBeGreaterThan(0.5)
  })

  it("maps backend failures: 503 when it is down, 502 when it fails, its own 4xx passes through; none is a 429", () =>
    sim(gateway({}, { rps: 20 }), (s) =>
      Effect.gen(function*() {
        yield* s.faults.inject({ kind: "node", id: "fn" }, { _tag: "Outage" })
        const down = yield* s.advanceTo(5_000)
        expect(mean(down, "nodes", "web", "rates", "fail.Unavailable", 1_000)).toBeGreaterThan(15)
        expect(mean(down, "nodes", "web", "rates", "fail.Throttled", 1_000)).toBe(0)
        expect(mean(down, "nodes", "api", "rates", "status.5xx", 1_000)).toBeGreaterThan(15)
        yield* s.faults.clearAll
        yield* s.faults.inject({ kind: "node", id: "fn" }, { _tag: "Errors", rate: 1 })
        const failing = yield* s.advanceTo(10_000)
        expect(mean(failing, "nodes", "web", "rates", "fail.Failed", 6_000)).toBeGreaterThan(15)
      })))

  it("passes a backend's refusal through as a 4xx", async () => {
    // 7 MB is under the gateway's 10 MB but over Lambda's 6 MB synchronous limit.
    const all = await frames(gateway({}, { rps: 5, payload: 7 * 1024 }), 5_000)
    expect(mean(all, "nodes", "web", "rates", "fail.Rejected", 1_000)).toBeGreaterThan(3)
    expect(mean(all, "nodes", "api", "rates", "status.4xx", 1_000)).toBeGreaterThan(3)
    expect(mean(all, "nodes", "api", "rates", "status.5xx", 1_000)).toBe(0)
  })

  it("a gateway with nothing connected answers 500, not a hang", async () => {
    const b = Builder.make("alone", { seed: 1 })
    b.connect(b.add("common.client", { id: "web", settings: { rps: 10, arrival: "constant" } }), b.add("aws.apigateway", { id: "api" }))
    const all = await frames(b.build(), 5_000)
    expect(mean(all, "nodes", "web", "rates", "fail.Failed", 1_000)).toBeGreaterThan(8)
  })

  it("a MOCK integration answers at the gateway, with only the gateway's own latency", async () => {
    const b = Builder.make("mock", { seed: 1 })
    b.connect(b.add("common.client", { id: "web", settings: { rps: 50, arrival: "constant" } }), b.add("aws.apigateway", { id: "api", settings: { integrationType: "mock", overhead: { mean: 20, cv: 0 } } }))
    const all = await frames(b.build(), 10_000)
    expect(mean(all, "nodes", "web", "rates", "ok", 2_000)).toBeCloseTo(50, -1)
    // 20 ms of gateway, plus 1 ms each way for the edge into it.
    const latency = all.filter((f) => f.t > 2_000).map((f) => f.nodes.api?.dist.latency?.p50 ?? 0)
    expect(latency.reduce((a, v) => a + v, 0) / latency.length).toBeCloseTo(20, 0)
  })

  it("records IntegrationLatency separately from the gateway's own overhead", async () => {
    const all = await frames(gateway({ overhead: { mean: 30, cv: 0 } }, { rps: 20 }, { duration: { mean: 200, cv: 0 } }), 15_000)
    const integration = all.filter((f) => f.t > 5_000).map((f) => f.nodes.api?.dist.integrationLatency?.p50 ?? 0)
    const total = all.filter((f) => f.t > 5_000).map((f) => f.nodes.api?.dist.latency?.p50 ?? 0)
    const avg = (xs: ReadonlyArray<number>) => xs.reduce((a, v) => a + v, 0) / xs.length
    // Latency covers the overhead and the integration; IntegrationLatency only the integration (the function plus the edge to it).
    expect(avg(total) - avg(integration)).toBeCloseTo(30, 0)
    expect(avg(integration)).toBeGreaterThan(200)
  })

  it("gives back what an abandoned request held: a caller that cancels leaves nothing in flight", async () => {
    const doc = front({}, { rps: 50 }, { latency: { mean: 5_000, cv: 0 } }, { timeout: "100 millis", cancelOnTimeout: true, request: { operation: "write" } })
    const all = await frames(doc, 20_000)
    // Without cleanup the gateway would hold 50 a second for 5 s: about 250 in flight.
    expect(mean(all, "nodes", "api", "gauges", "inflight", 10_000)).toBeLessThan(10)
  })
})

describe("aws.apigateway: authorizers", () => {
  /** client -> gateway -> endpoint, with a Lambda authorizer on the gateway's authorizer port. */
  const withAuthorizer = (api: Bag, load: Bag = { rps: 100 }, authorizer: Bag = {}) => {
    const b = Builder.make("auth", { seed: 9 })
    const web = b.add("common.client", { id: "web", settings: { arrival: "constant", ...load } })
    const gw = b.add("aws.apigateway", { id: "api", settings: { authorizer: { type: "lambda" }, ...api } })
    const auth = b.add("aws.lambda", { id: "auth", settings: { memory: 1769, duration: { mean: 20, cv: 0 }, ...authorizer } })
    b.connect(web, gw)
    b.connect(gw, b.add("common.http-endpoint", { id: "ext", settings: { latency: { mean: 10, cv: 0 } } }))
    b.connect(gw.port("authorizer"), auth)
    return b.build()
  }

  it("a Lambda authorizer is called for every request when its result is not cached", async () => {
    const all = await frames(withAuthorizer({ authorizer: { type: "lambda", ttl: 0 } }), 15_000)
    expect(mean(all, "nodes", "api", "rates", "auth.invocations", 5_000)).toBeCloseTo(100, -1)
    expect(mean(all, "nodes", "auth", "rates", "in", 5_000)).toBeCloseTo(100, -1)
    expect(mean(all, "nodes", "web", "rates", "ok", 5_000)).toBeCloseTo(100, -1)
  })

  it("caching the result cuts authorizer invocations to about one per caller per TTL", async () => {
    // 20 callers, results cached for 5 s: 4 refreshes a second at most, against 100 requests a second.
    const api = { authorizer: { type: "lambda", ttl: "5 seconds", identities: 20 } }
    const all = await frames(withAuthorizer(api), 31_000)
    const calls = mean(all, "nodes", "api", "rates", "auth.invocations", 6_000)
    expect(calls).toBeGreaterThan(2)
    expect(calls).toBeLessThan(6)
    expect(mean(all, "nodes", "api", "rates", "auth.cacheHit", 6_000)).toBeGreaterThan(90)
    expect(mean(all, "nodes", "web", "rates", "ok", 6_000)).toBeCloseTo(100, -1)
  })

  it("denied callers get 403 and the denial is cached too", async () => {
    const api = { authorizer: { type: "lambda", ttl: "60 seconds", identities: 10, deny: 0.5 } }
    const all = await frames(withAuthorizer(api), 20_000)
    const rejected = mean(all, "nodes", "web", "rates", "fail.Rejected", 5_000)
    expect(rejected).toBeGreaterThan(20)
    expect(rejected).toBeLessThan(80)
    expect(mean(all, "nodes", "web", "rates", "ok", 5_000) + rejected).toBeCloseTo(100, -1)
    // Ten callers, each asked once (a handful twice, while the first answer was in flight).
    expect(mean(all, "nodes", "api", "rates", "auth.invocations", 5_000)).toBe(0)
  })

  it("an authorizer that is down fails every request with a 500, and the backend never sees one", () =>
    sim(withAuthorizer({}), (s) =>
      Effect.gen(function*() {
        yield* s.faults.inject({ kind: "node", id: "auth" }, { _tag: "Outage" })
        const all = yield* s.advanceTo(5_000)
        expect(mean(all, "nodes", "web", "rates", "fail.Failed", 1_000)).toBeGreaterThan(90)
        expect(mean(all, "nodes", "ext", "rates", "in", 1_000)).toBe(0)
        expect(mean(all, "nodes", "api", "rates", "auth.failed", 1_000)).toBeGreaterThan(90)
      })))

  it("a slow authorizer function times out at 10 s with a 500", async () => {
    const all = await frames(withAuthorizer({ authorizer: { type: "lambda", ttl: 0 } }, { rps: 2 }, { duration: { mean: 12_000, cv: 0 }, timeout: "30 seconds" }), 60_000)
    expect(mean(all, "nodes", "web", "rates", "fail.Failed", 30_000)).toBeGreaterThan(1.5)
    expect(mean(all, "nodes", "ext", "rates", "in", 30_000)).toBe(0)
  })

  it("JWT, IAM and Cognito checks add only their own latency; JWT pays once for the issuer's keys", async () => {
    const run = (type: string) => {
      const b = Builder.make("jwt", { seed: 1 })
      const gw = b.add("aws.apigateway", { id: "api", settings: { apiType: type === "jwt" ? "http" : "rest", overhead: { mean: 5, cv: 0 }, authorizer: { type, latency: { mean: 40, cv: 0 } } } })
      b.connect(b.add("common.client", { id: "web", settings: { rps: 20, arrival: "constant" } }), gw)
      b.connect(gw, b.add("common.http-endpoint", { id: "ext", settings: { latency: { mean: 10, cv: 0 } } }))
      return frames(b.build(), 12_000)
    }
    const none = await run("none")
    const jwt = await run("jwt")
    const iam = await run("iam")
    const median = (all: Awaited<ReturnType<typeof run>>) => {
      const xs = all.filter((f) => f.t > 3_000).map((f) => f.nodes.api?.dist.latency?.p50 ?? 0)
      return xs.reduce((a, v) => a + v, 0) / xs.length
    }
    // The check costs its 40 ms on top of whatever the gateway and the backend take without one.
    expect(median(iam) - median(none)).toBeCloseTo(40, 0)
    expect(median(jwt) - median(none)).toBeCloseTo(40, 0)
    // Only the very first request pays the 100 ms fetch of the issuer's keys.
    const first = jwt.find((f) => (f.nodes.api?.dist.latency?.n ?? 0) > 0)!
    expect(first.nodes.api!.dist.latency!.p99).toBeGreaterThan(140)
  })
})

describe("aws.apigateway: response cache", () => {
  const cached = { cache: { enabled: true, ttl: "60 seconds", keys: 50, responseSize: 10 } }

  it("serves repeated GETs from the cache: few distinct keys, a high hit ratio, a light backend", async () => {
    const all = await frames(front(cached, { rps: 100 }), 40_000)
    const hits = mean(all, "nodes", "api", "rates", "cache.hit", 20_000)
    const misses = mean(all, "nodes", "api", "rates", "cache.miss", 20_000)
    expect(hits / (hits + misses)).toBeGreaterThan(0.95)
    expect(mean(all, "nodes", "ext", "rates", "in", 20_000)).toBeLessThan(5)
    expect(mean(all, "nodes", "web", "rates", "ok", 20_000)).toBeCloseTo(100, -1)
  })

  it("a cache hit is answered without the integration, so it is faster", async () => {
    const all = await frames(front(cached, { rps: 100 }, { latency: { mean: 200, cv: 0 } }), 30_000)
    const late = all.filter((f) => f.t > 15_000).map((f) => f.nodes.api?.dist.latency?.p50 ?? 0)
    expect(late.reduce((a, v) => a + v, 0) / late.length).toBeLessThan(60)
  })

  it("entries expire at the TTL and are fetched again", async () => {
    const all = await frames(front({ cache: { enabled: true, ttl: "5 seconds", keys: 20, responseSize: 10 } }, { rps: 100 }), 40_000)
    // Twenty entries refilled every 5 s is about 4 misses a second.
    const misses = mean(all, "nodes", "api", "rates", "cache.miss", 10_000)
    expect(misses).toBeGreaterThan(2)
    expect(misses).toBeLessThan(8)
  })

  it("caches GET only by default; other methods need the scope widened", async () => {
    const write = { request: { operation: "write" } }
    const get = await frames(front(cached, { rps: 50 }, {}, write), 10_000)
    expect(mean(get, "nodes", "api", "rates", "cache.hit", 2_000)).toBe(0)
    expect(mean(get, "nodes", "api", "rates", "cache.miss", 2_000)).toBe(0)
    const all = await frames(front({ cache: { ...cached.cache, scope: "all" } }, { rps: 50 }, {}, write), 20_000)
    expect(mean(all, "nodes", "api", "rates", "cache.hit", 10_000)).toBeGreaterThan(40)
  })

  it("a cache too small for its working set mostly misses; a big enough one does not", async () => {
    // 1,000 KB responses in a 0.5 GB cache is about 488 entries, against 5,000 distinct keys.
    const small = await frames(front({ cache: { enabled: true, ttl: "300 seconds", keys: 5_000, responseSize: 1_000, size: "0.5" } }, { rps: 200 }), 60_000)
    const big = await frames(front({ cache: { enabled: true, ttl: "300 seconds", keys: 5_000, responseSize: 1_000, size: "6.1" } }, { rps: 200 }), 60_000)
    const ratio = (all: typeof small) => {
      const h = mean(all, "nodes", "api", "rates", "cache.hit", 40_000)
      return h / (h + mean(all, "nodes", "api", "rates", "cache.miss", 40_000))
    }
    expect(ratio(small)).toBeLessThan(0.25)
    expect(ratio(big)).toBeGreaterThan(0.6)
  })

  it("never caches a response over 1,048,576 bytes", async () => {
    const all = await frames(front({ cache: { ...cached.cache, responseSize: 2_000 } }, { rps: 50 }), 15_000)
    expect(mean(all, "nodes", "api", "rates", "cache.hit", 5_000)).toBe(0)
  })

  it("Cache-Control: max-age=0 goes to the backend and refreshes the entry; unauthorised ones can be refused", async () => {
    const run = (invalidation: string) => frames(front({ cache: { ...cached.cache, invalidate: 1, invalidation } }, { rps: 50 }), 15_000)
    const allowed = await run("allowed")
    expect(mean(allowed, "nodes", "api", "rates", "cache.hit", 5_000)).toBe(0)
    expect(mean(allowed, "nodes", "ext", "rates", "in", 5_000)).toBeCloseTo(50, -1)
    const forbidden = await run("forbidden")
    expect(mean(forbidden, "nodes", "web", "rates", "fail.Rejected", 5_000)).toBeGreaterThan(40)
    const ignored = await run("ignored")
    expect(mean(ignored, "nodes", "api", "rates", "cache.hit", 8_000)).toBeGreaterThan(40)
  })

  it("an HTTP API has no cache", async () => {
    const all = await frames(front({ apiType: "http", ...cached }, { rps: 50 }), 10_000)
    expect(mean(all, "nodes", "api", "rates", "cache.hit", 2_000)).toBe(0)
    expect(mean(all, "nodes", "ext", "rates", "in", 2_000)).toBeCloseTo(50, -1)
  })

  it("probe state counts hits, misses and held entries", () =>
    sim(front(cached, { rps: 100 }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(10_000)
        const state = yield* probe(s, "api")
        expect(state.cacheEntries).toBeGreaterThan(40)
        expect(state.cacheEntries).toBeLessThanOrEqual(50)
        expect(state.cacheHits).toBeGreaterThan(state.cacheMisses ?? 0)
      })))
})

describe("aws.apigateway: determinism", () => {
  it("the same design and seed give the same frames, with every layer switched on", async () => {
    const api = {
      routes: 5,
      stageThrottle: { rate: 40, burst: 40 },
      usagePlan: { enabled: true, clients: 5, rate: 30, burst: 30 },
      cache: { enabled: true, ttl: "30 seconds", keys: 40, responseSize: 10 },
      authorizer: { type: "iam" }
    }
    const a = await frames(front(api, { rps: 150, arrival: "poisson" }), 15_000)
    const b = await frames(front(api, { rps: 150, arrival: "poisson" }), 15_000)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})
