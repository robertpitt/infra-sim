import { describe, expect, it } from "vitest"
import * as Builder from "../../../Builder.ts"
import { dist, mean, peakGauge } from "../../../testing.ts"
import { design, exact, outage, read, run } from "../testing.ts"

/** A Lambda function that keeps its execution environment's connection for its whole 300 ms invocation. */
const lambdaLike = { ...read, client: { connections: "reused", hold: "300 millis" } }

describe("aws.rds-proxy: a pool shared by many clients", () => {
  it("a burst that holds connections exhausts max_connections directly, and doesn't through a proxy", async () => {
    // 1,000 a second, each holding its connection about 300 ms: about 300 connections, three times the 100 allowed.
    const db = { ...exact, maxConnections: 100 }
    const direct = await run(design({ db, load: { rps: 1_000 }, edge: lambdaLike }), 30_000)
    const proxied = await run(design({ db, load: { rps: 1_000 }, edge: lambdaLike, proxy: {} }), 30_000)
    expect(mean(direct.frames, "nodes", "db", "rates", "refused", 5_000)).toBeGreaterThan(500)
    expect(proxied.db.refused).toBe(0)
    expect(mean(proxied.frames, "nodes", "web", "rates", "ok", 5_000)).toBeCloseTo(1_000, -1)
    // Multiplexing: a database connection is borrowed only for the query (about 3 ms), so few are in use at once.
    expect(mean(proxied.frames, "nodes", "proxy", "gauges", "borrowed", 5_000)).toBeLessThan(10)
    // Its clients hold about 300 connections to the proxy instead.
    expect(mean(proxied.frames, "nodes", "proxy", "gauges", "clientConnections", 5_000)).toBeGreaterThan(280)
  })

  it("takes the cost of new connections off the database: clients that connect per request pay the proxy's handshake", async () => {
    const edge = { ...read, client: { connections: "per-request" } }
    const direct = await run(design({ db: exact, load: { rps: 50 }, edge }), 20_000)
    const proxied = await run(design({ db: exact, load: { rps: 50 }, edge, proxy: { clientHandshake: { mean: 20, cv: 0 } } }), 20_000)
    expect(mean(direct.frames, "nodes", "db", "rates", "opened", 5_000)).toBeCloseTo(50, 0)
    expect(mean(proxied.frames, "nodes", "proxy", "rates", "clientConnects", 5_000)).toBeCloseTo(50, 0)
    expect(mean(proxied.frames, "nodes", "db", "rates", "opened", 5_000)).toBe(0)
    // The database's own work per query drops from 26 ms (with a handshake) to 3.
    expect(dist(proxied.frames, "db", "latency", 5_000).mean).toBeCloseTo(3, 0)
  })

  it("a read-only endpoint sends its clients to the readers", async () => {
    const { db } = await run(design({ db: { ...exact, engine: "aurora-mysql", readers: 2 }, load: { rps: 20 }, edge: read, proxy: { endpoint: "read-only" } }), 10_000)
    expect(db.readers.open).toBeGreaterThan(0)
    expect(db.writer.open).toBe(0)
  })

  it("its pool is MaxConnectionsPercent of max_connections", async () => {
    const { proxy } = await run(design({ db: { engine: "mysql", instanceClass: "db.t4g.medium" }, load: { rps: 1 }, edge: read, proxy: { maxConnectionsPercent: 50 } }), 2_000)
    expect(proxy?.limit).toBe(152)
  })

  it("past its pool, requests wait for a connection instead of being refused, up to the borrow timeout", async () => {
    // A pool of 10 (10% of 100), each query 100 ms: 100 a second at most. 150 a second: 50 a second time out.
    const db = { ...exact, maxConnections: 100, query: { ...exact.query, readWait: { mean: 99, cv: 0 } } }
    const { frames, proxy } = await run(design({ db, load: { rps: 150 }, edge: { ...lambdaLike, timeout: "1 minute" }, proxy: { maxConnectionsPercent: 10, borrowTimeout: "2 seconds" } }), 60_000)
    expect(peakGauge(frames, "proxy", "borrowed")).toBe(10)
    expect(mean(frames, "nodes", "db", "rates", "refused")).toBe(0)
    expect(mean(frames, "nodes", "proxy", "rates", "borrowTimeouts", 20_000)).toBeCloseTo(50, -1)
    expect(mean(frames, "nodes", "proxy", "rates", "fail.Throttled", 20_000)).toBeCloseTo(50, -1)
    expect(dist(frames, "proxy", "borrowLatency", 20_000).p95).toBeGreaterThan(1_500)
    expect(proxy?.queued).toBeGreaterThan(1_000)
  })

  it("under its pool nothing waits", async () => {
    const db = { ...exact, maxConnections: 100, query: { ...exact.query, readWait: { mean: 99, cv: 0 } } }
    const { frames, proxy } = await run(design({ db, load: { rps: 50 }, edge: lambdaLike, proxy: { maxConnectionsPercent: 10 } }), 30_000)
    expect(proxy?.borrowTimeouts).toBe(0)
    expect(dist(frames, "proxy", "borrowLatency", 5_000).p95).toBeLessThan(5)
  })

  it("keeps MaxIdleConnectionsPercent of its connections open while idle, and closes the rest after five minutes", async () => {
    const db = { ...exact, maxConnections: 100, query: { ...exact.query, readWait: { mean: 99, cv: 0 } } }
    const { frames } = await run(
      design({ db, load: { rps: 400 }, edge: lambdaLike, proxy: { maxConnectionsPercent: 50, maxIdleConnectionsPercent: 20 } }),
      400_000,
      [{ at: 20_000, act: (s) => s.configureNode("web", { rps: 0 }) }]
    )
    expect(peakGauge(frames, "db", "connections", 10_000, 20_000)).toBe(50)
    expect(mean(frames, "nodes", "db", "gauges", "connections", 100_000, 300_000)).toBe(50)
    expect(mean(frames, "nodes", "db", "gauges", "connections", 330_000)).toBe(20)
  })
})

describe("aws.rds-proxy: pinning", () => {
  const db = { ...exact, maxConnections: 100 }

  it("a pinned session keeps its database connection for as long as its client connection is open", async () => {
    const free = await run(design({ db, load: { rps: 100 }, edge: { ...read, client: { hold: "200 millis" } }, proxy: { pinning: 0 } }), 30_000)
    const pinned = await run(design({ db, load: { rps: 100 }, edge: { ...read, client: { hold: "200 millis" } }, proxy: { pinning: 1 } }), 30_000)
    expect(mean(free.frames, "nodes", "proxy", "gauges", "borrowed", 5_000)).toBeLessThan(3)
    // Every client connection the proxy has open holds one: busy, held, or idle in the client's pool.
    expect(mean(pinned.frames, "nodes", "proxy", "gauges", "borrowed", 5_000)).toBeCloseTo(mean(pinned.frames, "nodes", "proxy", "gauges", "clientConnections", 5_000), 0)
    expect(mean(pinned.frames, "nodes", "proxy", "gauges", "borrowed", 5_000)).toBeGreaterThan(19)
  })

  it("pinned sessions can use up the pool, and the rest time out waiting", async () => {
    const { proxy } = await run(design({ db, load: { rps: 100 }, edge: { ...read, client: { hold: "200 millis" } }, proxy: { pinning: 1, maxConnectionsPercent: 10, borrowTimeout: "1 second" } }), 30_000)
    expect(proxy?.borrowTimeouts).toBeGreaterThan(100)
  })

  it("a pinned session's connection goes back when the proxy closes the idle client connection", async () => {
    const { frames } = await run(
      design({ db, load: { rps: 50 }, edge: { ...read, client: { idleTimeout: "1 hour" } }, proxy: { pinning: 1, idleClientTimeout: "20 seconds" } }),
      60_000,
      [{ at: 15_000, act: (s) => s.configureNode("web", { rps: 0 }) }]
    )
    expect(peakGauge(frames, "proxy", "borrowed", 10_000, 15_000)).toBeGreaterThan(0)
    expect(peakGauge(frames, "proxy", "borrowed", 37_000)).toBe(0)
    expect(peakGauge(frames, "proxy", "clientConnections", 37_000)).toBe(0)
  })
})

describe("aws.rds-proxy: failover", () => {
  const db = { ...exact, multiAz: "instance", failover: { multiAzInstance: { mean: 30_000, cv: 0 } } }

  it("holds requests through a failover instead of failing them, with its clients' connections kept open", async () => {
    const edge = { ...lambdaLike, timeout: "1 minute" }
    const direct = await run(design({ db, load: { rps: 20 }, edge }), 100_000, [outage(30_000, 1_000)])
    const proxied = await run(design({ db, load: { rps: 20 }, edge, proxy: {} }), 100_000, [outage(30_000, 1_000)])
    // Directly, a minute's worth of requests fail; through the proxy, they wait and then succeed.
    expect(mean(direct.frames, "nodes", "web", "rates", "fail", 31_000, 59_000)).toBeCloseTo(20, 0)
    expect(mean(proxied.frames, "nodes", "web", "rates", "fail", 31_000, 59_000)).toBe(0)
    expect(proxied.proxy?.retried).toBeGreaterThan(0)
    expect(proxied.proxy?.targetUp).toBe(true)
    expect(peakGauge(proxied.frames, "proxy", "waiting", 35_000, 59_000)).toBeGreaterThan(400)
    // The ones that came in as it began waited the whole failover.
    const slowest = Math.max(...proxied.frames.map((f) => f.nodes.web?.dist.latency?.max ?? 0))
    expect(slowest).toBeGreaterThan(28_000)
    expect(slowest).toBeLessThan(33_000)
    // The proxy's clients never lost their connections to it: each was opened once (more were needed while requests
    // waited). Directly, every client lost its connection and opened another after the failover.
    expect(proxied.proxy?.clientConnects).toBeLessThanOrEqual(peakGauge(proxied.frames, "proxy", "clientConnections") + 2)
    expect(direct.db.opened).toBeGreaterThan(peakGauge(direct.frames, "db", "connections") + 4)
  })

  it("isn't fooled by a client's DNS cache: it follows the new primary at once", async () => {
    const edge = { ...lambdaLike, timeout: "1 minute", client: { ...lambdaLike.client, dnsCache: "30 seconds" } }
    const direct = await run(design({ db, load: { rps: 20 }, edge }), 120_000, [outage(30_000, 1_000)])
    const proxied = await run(design({ db, load: { rps: 20 }, edge, proxy: {} }), 120_000, [outage(30_000, 1_000)])
    expect(direct.db.stale).toBeGreaterThan(100)
    expect(proxied.db.stale).toBe(0)
  })

  it("a borrow timeout shorter than the failover fails the requests that waited too long", async () => {
    const { proxy } = await run(design({ db, load: { rps: 20 }, edge: { ...lambdaLike, timeout: "1 minute" }, proxy: { borrowTimeout: "5 seconds" } }), 100_000, [outage(30_000, 1_000)])
    expect(proxy?.borrowTimeouts).toBeGreaterThan(400)
  })
})

describe("aws.rds-proxy: inputs", () => {
  it("with no database wired it refuses every request as unavailable", async () => {
    const b = Builder.make("lonely", { seed: 1 })
    const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 10 } })
    const proxy = b.add("aws.rds-proxy", { id: "proxy" })
    b.add("aws.rds", { id: "db" })
    b.connect(web, proxy)
    const { frames } = await run(b.build(), 5_000)
    expect(mean(frames, "nodes", "proxy", "rates", "fail.Unavailable", 1_000)).toBeCloseTo(10, 0)
  })

  it("a client edge with another connector is treated as a default client", async () => {
    const { db } = await run(design({ db: exact, load: { rps: 10 }, edge: read }), 5_000)
    const b = Builder.make("plain", { seed: 1 })
    const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 10 } })
    const target = b.add("aws.rds", { id: "db", settings: exact })
    b.connect(web, target, read, { connector: "core.link" })
    const plain = await run(b.build(), 5_000)
    expect(plain.db.clients).toBe(0)
    expect(plain.db.queries).toBe(db.queries)
    expect(plain.db.opened).toBe(db.opened)
  })
})
