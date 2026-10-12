import { describe, expect, it } from "vitest"
import { dist, mean } from "../../components/testing.ts"
import { design, outage, peak, run } from "./testkit.ts"

/** Settings that make query and connection times exact, so rates and latencies can be checked to the millisecond. */
const exact = {
  query: { readCpu: { mean: 1, cv: 0 }, readWait: { mean: 2, cv: 0 }, writeCpu: { mean: 1, cv: 0 }, writeWait: { mean: 2, cv: 0 }, readIos: 0, writeIos: 0 },
  connection: { handshake: { mean: 20, cv: 0 }, cpu: { mean: 3, cv: 0 } }
}
const read = { request: { operation: "read" } }
const write = { request: { operation: "write" } }

describe("aws.rds: connections are the scarce resource", () => {
  it("each request holds a connection; past max_connections new ones are refused with 'too many connections'", async () => {
    // Each request holds its connection about 1.026 s (handshake, query, and 1 s the caller keeps it), so 50 a second
    // need about 51 connections. With 30 allowed, 30/1.026 = 29.2 a second get one and the rest are refused.
    const { frames, db } = await run(
      design({
        db: { engine: "mysql", maxConnections: 30, ...exact },
        load: { rps: 50 },
        edge: { ...read, client: { connections: "per-request", hold: "1 second" } }
      }),
      60_000
    )
    expect(peak(frames, "db", "connections")).toBe(30)
    expect(mean(frames, "nodes", "db", "rates", "ok", 10_000)).toBeCloseTo(29.2, 0)
    expect(mean(frames, "nodes", "db", "rates", "fail.Throttled", 10_000)).toBeCloseTo(20.8, 0)
    expect(db.refused).toBeGreaterThan(900)
  })

  it("under the limit nothing is refused", async () => {
    const { frames, db } = await run(
      design({ db: { engine: "mysql", maxConnections: 30, ...exact }, load: { rps: 20 }, edge: { ...read, client: { connections: "per-request", hold: "1 second" } } }),
      30_000
    )
    expect(db.refused).toBe(0)
    expect(peak(frames, "db", "connections")).toBeLessThanOrEqual(22)
  })

  it("the default max_connections is the parameter group's: 60 on a MySQL db.t3.micro", async () => {
    const { frames, db } = await run(
      design({ db: { engine: "mysql", instanceClass: "db.t3.micro", ...exact }, load: { rps: 100 }, edge: { ...read, client: { connections: "per-request", hold: "1 second" } } }),
      20_000
    )
    expect(db.maxConnections).toBe(60)
    expect(peak(frames, "db", "connections")).toBe(60)
    expect(db.refused).toBeGreaterThan(0)
  })

  it("PostgreSQL refuses with its own words", async () => {
    const { frames } = await run(
      design({ db: { engine: "postgres", maxConnections: 6, ...exact }, load: { rps: 20 }, edge: { ...read, client: { connections: "per-request", hold: "1 second" } } }),
      10_000
    )
    expect(mean(frames, "nodes", "db", "rates", "refused", 3_000)).toBeGreaterThan(10)
  })

  it("opening a connection costs a handshake and server CPU every time; a kept connection is reused without either", async () => {
    const perRequest = await run(design({ db: exact, load: { rps: 20 }, edge: { ...read, client: { connections: "per-request" } } }), 30_000)
    const reused = await run(design({ db: exact, load: { rps: 20 }, edge: { ...read, client: { connections: "reused" } } }), 30_000)
    // Handshake 20 + CPU (1 query + 3 connection) + 2 other: 26 ms; reused, just the query's 3 ms.
    expect(dist(perRequest.frames, "db", "latency", 5_000).mean).toBeCloseTo(26, 0)
    expect(dist(reused.frames, "db", "latency", 5_000).mean).toBeCloseTo(3, 0)
    expect(mean(perRequest.frames, "nodes", "db", "rates", "opened", 5_000)).toBeCloseTo(20, 0)
    expect(mean(reused.frames, "nodes", "db", "rates", "opened", 5_000)).toBe(0)
  })

  it("kept connections count against max_connections while idle, until their idle timeout", async () => {
    // 40 a second, each held 500 ms: about 20 connections. Traffic stops at 20 s; the idle ones close 30 s later.
    const { frames } = await run(
      design({ db: exact, load: { rps: 40 }, edge: { ...read, client: { connections: "reused", hold: "500 millis", idleTimeout: "30 seconds" } } }),
      60_000,
      [{ at: 20_000, act: (s) => s.configureNode("web", { rps: 0 }) }]
    )
    expect(peak(frames, "db", "connections", 10_000, 20_000)).toBeGreaterThanOrEqual(20)
    expect(peak(frames, "db", "connections", 10_000, 20_000)).toBeLessThanOrEqual(23)
    expect(mean(frames, "nodes", "db", "gauges", "idleConnections", 25_000, 45_000)).toBeGreaterThanOrEqual(20)
    expect(peak(frames, "db", "connections", 53_000)).toBe(0)
  })

  it("lowering max_connections live refuses new connections at once and keeps the ones open", async () => {
    const { frames } = await run(
      design({ db: { ...exact, maxConnections: 100 }, load: { rps: 40 }, edge: { ...read, client: { connections: "per-request", hold: "1 second" } } }),
      30_000,
      [{ at: 10_000, act: (s) => s.configureNode("db", { maxConnections: 10 }) }]
    )
    expect(peak(frames, "db", "connections", 5_000, 10_000)).toBeGreaterThan(35)
    expect(peak(frames, "db", "connections", 13_000)).toBe(10)
  })

  it("a caller that gives up and cancels gives its connection back; one that abandons the query doesn't until it ends", async () => {
    const slow = { ...exact, query: { ...exact.query, readWait: { mean: 1_000, cv: 0 } } }
    const cancelled = await run(design({ db: slow, load: { rps: 20 }, edge: { ...read, timeout: "100 millis", cancelOnTimeout: true, client: { connections: "per-request" } } }), 20_000)
    const abandoned = await run(design({ db: slow, load: { rps: 20 }, edge: { ...read, timeout: "100 millis", cancelOnTimeout: false, client: { connections: "per-request" } } }), 20_000)
    expect(peak(cancelled.frames, "db", "connections", 5_000)).toBeLessThanOrEqual(4)
    expect(peak(abandoned.frames, "db", "connections", 5_000)).toBeGreaterThanOrEqual(20)
  })
})

describe("aws.rds: the instance", () => {
  const cpuBound = { instanceClass: "db.t4g.medium", query: { readCpu: { mean: 10, cv: 0.5 }, readWait: { mean: 1, cv: 0 }, readIos: 0 } }

  it("busy vCPUs are the query rate times the CPU each needs (Little's law)", async () => {
    const { frames } = await run(design({ db: cpuBound, load: { rps: 100, arrival: "poisson" }, edge: read }), 60_000)
    // 100 a second x 10 ms on 2 vCPUs: half busy.
    expect(mean(frames, "nodes", "db", "gauges", "cpu", 5_000)).toBeCloseTo(0.5, 1)
  })

  it("query time stretches as the CPU saturates, and past it queries pile up until connections run out", async () => {
    const light = await run(design({ db: cpuBound, load: { rps: 50, arrival: "poisson" }, edge: read }), 60_000)
    const heavy = await run(design({ db: cpuBound, load: { rps: 190, arrival: "poisson" }, edge: read }), 60_000)
    const over = await run(design({ db: { ...cpuBound, maxConnections: 200 }, load: { rps: 300, arrival: "poisson" }, edge: read }), 30_000)
    expect(dist(heavy.frames, "db", "queryTime", 5_000).mean).toBeGreaterThan(2 * dist(light.frames, "db", "queryTime", 5_000).mean)
    expect(dist(heavy.frames, "db", "cpuWait", 5_000).mean).toBeGreaterThan(5)
    expect(mean(over.frames, "nodes", "db", "gauges", "cpu", 10_000)).toBeGreaterThan(0.98)
    expect(peak(over.frames, "db", "connections")).toBe(200)
    expect(over.db.refused).toBeGreaterThan(0)
  })

  it("a Multi-AZ instance makes a write wait for its standby; a read doesn't", async () => {
    const standby = { ...exact, standbyCommit: { mean: 5, cv: 0 } }
    const single = await run(design({ db: standby, load: { rps: 20 }, edge: write }), 10_000)
    const multi = await run(design({ db: { ...standby, multiAz: "instance" }, load: { rps: 20 }, edge: write }), 10_000)
    const reads = await run(design({ db: { ...standby, multiAz: "instance" }, load: { rps: 20 }, edge: read }), 10_000)
    expect(dist(single.frames, "db", "latency", 2_000).mean).toBeCloseTo(3, 0)
    expect(dist(multi.frames, "db", "latency", 2_000).mean).toBeCloseTo(8, 0)
    expect(dist(reads.frames, "db", "latency", 2_000).mean).toBeCloseTo(3, 0)
  })

  it("storage serves its IOPS and queues the rest: gp3's 3,000 baseline holds 300 writes of 10 I/Os a second", async () => {
    const io = { ...exact, storage: { type: "gp3", allocated: 100 }, query: { ...exact.query, writeIos: 10 } }
    const under = await run(design({ db: io, load: { rps: 200 }, edge: write }), 20_000)
    const over = await run(design({ db: io, load: { rps: 400 }, edge: write }), 20_000)
    const provisioned = await run(design({ db: { ...io, storage: { type: "io2", allocated: 100, iops: 10_000 } }, load: { rps: 400 }, edge: write }), 20_000)
    expect(peak(under.frames, "db", "diskQueue", 2_000)).toBeLessThan(50)
    // 1,000 I/Os a second more than it serves: about 15,000 queued after 15 s.
    expect(peak(over.frames, "db", "diskQueue", 15_000, 16_000)).toBeGreaterThan(12_000)
    expect(dist(over.frames, "db", "queryTime", 15_000).mean).toBeGreaterThan(1_000)
    expect(peak(provisioned.frames, "db", "diskQueue", 2_000)).toBeLessThan(50)
  })
})

describe("aws.rds: readers", () => {
  const aurora = { ...exact, engine: "aurora-postgres", readers: 2 }

  it("reads go to the readers and writes to the writer", async () => {
    const { db } = await run(design({ db: aurora, load: { rps: 50 }, edge: read, other: { load: { rps: 10 }, edge: write } }), 20_000)
    expect(db.reads).toBeGreaterThan(900)
    expect(db.readers.open).toBeGreaterThan(0)
    expect(db.writer.open).toBeGreaterThan(0)
    expect(db.readers.instances).toBe(2)
  })

  it("a Multi-AZ DB cluster serves reads from its two standbys; a Multi-AZ instance's standby serves none", async () => {
    const cluster = await run(design({ db: { ...exact, engine: "postgres", instanceClass: "db.r6gd.large", multiAz: "cluster" }, load: { rps: 50 }, edge: read }), 10_000)
    const instance = await run(design({ db: { ...exact, engine: "postgres", multiAz: "instance" }, load: { rps: 50 }, edge: read }), 10_000)
    expect(cluster.db.readers.instances).toBe(2)
    expect(cluster.db.readers.open).toBeGreaterThan(0)
    expect(cluster.db.writer.open).toBe(0)
    expect(instance.db.readers.instances).toBe(0)
    expect(instance.db.writer.open).toBeGreaterThan(0)
  })

  it("with no readers, reads go to the writer; a client on the writer endpoint reads there too", async () => {
    const none = await run(design({ db: { ...aurora, readers: 0 }, load: { rps: 50 }, edge: read }), 10_000)
    const writer = await run(design({ db: aurora, load: { rps: 50 }, edge: { ...read, client: { endpoint: "writer" } } }), 10_000)
    expect(none.db.readers.open).toBe(0)
    expect(none.db.writer.open).toBeGreaterThan(0)
    expect(writer.db.readers.open).toBe(0)
  })

  it("a write sent to the reader endpoint is refused, and not retried", async () => {
    const { frames } = await run(design({ db: aurora, load: { rps: 20 }, edge: { ...write, retry: { maxAttempts: 3 }, client: { endpoint: "reader" } } }), 10_000)
    expect(mean(frames, "nodes", "db", "rates", "fail.Rejected", 2_000)).toBeCloseTo(20, 0)
    expect(mean(frames, "edges", "web.out->db", "rates", "retries", 2_000)).toBe(0)
  })

  it("readers add their vCPUs: the same reads load each instance less", async () => {
    const cpu = { ...aurora, instanceClass: "db.r7g.large", query: { ...exact.query, readCpu: { mean: 10, cv: 0 } } }
    const writerOnly = await run(design({ db: { ...cpu, readers: 0 }, load: { rps: 100 }, edge: read }), 20_000)
    const scaled = await run(design({ db: { ...cpu, readers: 4 }, load: { rps: 100 }, edge: read }), 20_000)
    expect(mean(writerOnly.frames, "nodes", "db", "gauges", "cpu", 5_000)).toBeCloseTo(0.5, 1)
    expect(mean(scaled.frames, "nodes", "db", "gauges", "readerCpu", 5_000)).toBeCloseTo(0.125, 1)
  })

  it("replica lag is recorded for each write while there are readers", async () => {
    const { frames } = await run(design({ db: { ...aurora, replicaLag: { mean: 30, cv: 0 } }, load: { rps: 20 }, edge: write }), 10_000)
    expect(dist(frames, "db", "replicaLag", 2_000).mean).toBeCloseTo(30, 0)
  })
})

describe("aws.rds: failover", () => {
  const multiAz = { ...exact, multiAz: "instance", failover: { multiAzInstance: { mean: 60_000, cv: 0 } } }

  it("an Outage fails the primary over: down for the failover time, then up on the standby", async () => {
    const { frames, db } = await run(design({ db: multiAz, load: { rps: 50 }, edge: read }), 120_000, [outage(30_000, 1_000)])
    expect(db.failovers).toBe(1)
    expect(mean(frames, "nodes", "db", "rates", "ok", 32_000, 89_000)).toBe(0)
    expect(mean(frames, "nodes", "web", "rates", "fail", 32_000, 89_000)).toBeCloseTo(50, 0)
    expect(mean(frames, "nodes", "db", "rates", "ok", 92_000)).toBeCloseTo(50, 0)
  })

  it("every connection to the old primary is dropped: clients reconnect after it", async () => {
    const { frames, db } = await run(design({ db: multiAz, load: { rps: 50 }, edge: { ...read, client: { hold: "200 millis" } } }), 120_000, [outage(30_000, 1_000)])
    // About 10 connections before; all of them opened again after the failover.
    expect(mean(frames, "nodes", "db", "rates", "opened", 10_000, 29_000)).toBe(0)
    expect(peak(frames, "db", "connections", 32_000, 89_000)).toBe(0)
    expect(db.opened).toBeGreaterThanOrEqual(2 * 9)
  })

  it("the published typical times are the defaults: Multi-AZ instance 60–120 s, cluster under 35 s, Aurora under 60 s", async () => {
    const down = async (db: Record<string, unknown>): Promise<number> => {
      const { db: state } = await run(design({ db: { ...exact, ...db }, load: { rps: 10 }, edge: read }), 31_000, [outage(30_000, 100)])
      return state.failoverUntil - 30_000
    }
    const instance = await down({ multiAz: "instance" })
    const cluster = await down({ engine: "mysql", instanceClass: "db.r6gd.large", multiAz: "cluster" })
    const aurora = await down({ engine: "aurora-mysql", readers: 1 })
    expect(instance).toBeGreaterThan(50_000)
    expect(instance).toBeLessThan(130_000)
    expect(cluster).toBeGreaterThan(10_000)
    expect(cluster).toBeLessThan(40_000)
    expect(aurora).toBeGreaterThan(5_000)
    expect(aurora).toBeLessThan(70_000)
  })

  it("an Outage longer than the failover keeps the database down for the Outage, and is one failover", async () => {
    const db = { ...exact, multiAz: "cluster", instanceClass: "db.r6gd.large", failover: { multiAzCluster: { mean: 30_000, cv: 0 } } }
    const { frames, db: state } = await run(design({ db, load: { rps: 20 }, edge: { ...read, client: { endpoint: "writer" } } }), 200_000, [outage(30_000, 120_000)])
    expect(state.failovers).toBe(1)
    expect(mean(frames, "nodes", "web", "rates", "ok", 32_000, 149_000)).toBe(0)
    expect(mean(frames, "nodes", "web", "rates", "ok", 152_000)).toBeCloseTo(20, 0)
  })

  it("Aurora's other readers keep serving reads while one is promoted; writes wait for the new writer", async () => {
    const db = { ...exact, engine: "aurora-mysql", readers: 2, failover: { aurora: { mean: 40_000, cv: 0 } } }
    const { frames } = await run(design({ db, load: { rps: 20 }, edge: read, other: { load: { rps: 10 }, edge: write } }), 100_000, [outage(30_000, 1_000)])
    expect(mean(frames, "nodes", "web", "rates", "ok", 33_000, 69_000)).toBeCloseTo(20, 0)
    expect(mean(frames, "nodes", "other", "rates", "ok", 33_000, 69_000)).toBe(0)
    expect(mean(frames, "nodes", "other", "rates", "ok", 72_000)).toBeCloseTo(10, 0)
  })

  it("Aurora with no reader recreates its primary: reads go down too, for longer", async () => {
    const db = { ...exact, engine: "aurora-mysql", readers: 0, failover: { auroraRecreate: { mean: 120_000, cv: 0 } } }
    const { frames } = await run(design({ db, load: { rps: 20 }, edge: read }), 200_000, [outage(30_000, 1_000)])
    expect(mean(frames, "nodes", "web", "rates", "ok", 33_000, 149_000)).toBe(0)
    expect(mean(frames, "nodes", "web", "rates", "ok", 152_000)).toBeCloseTo(20, 0)
  })

  it("a query running when the primary fails fails too: its connection went with it", async () => {
    const slow = { ...multiAz, query: { ...exact.query, readWait: { mean: 5_000, cv: 0 } } }
    const { db } = await run(design({ db: slow, load: { rps: 10 }, edge: { ...read, timeout: "1 minute" } }), 40_000, [outage(30_000, 1_000)])
    expect(db.lost).toBeGreaterThanOrEqual(45)
  })

  it("a client caching DNS keeps reaching the old primary after the failover, less and less over its TTL", async () => {
    const { frames, db } = await run(
      design({ db: { ...multiAz, failover: { multiAzInstance: { mean: 30_000, cv: 0 } } }, load: { rps: 50 }, edge: { ...read, client: { dnsCache: "20 seconds" } } }),
      100_000,
      [outage(30_000, 1_000)]
    )
    const early = mean(frames, "nodes", "web", "rates", "ok", 61_000, 69_000)
    const late = mean(frames, "nodes", "web", "rates", "ok", 71_000, 79_000)
    expect(early).toBeLessThan(late)
    expect(late).toBeLessThan(50)
    expect(mean(frames, "nodes", "web", "rates", "ok", 82_000)).toBeCloseTo(50, 0)
    expect(db.stale).toBeGreaterThan(300)
  })

  it("is deterministic: the same design and seed play out the same", async () => {
    const doc = design({ db: { multiAz: "instance" }, load: { rps: 80, arrival: "poisson" }, edge: { ...read, client: { hold: "100 millis" } } })
    const a = await run(doc, 60_000, [outage(20_000, 500)])
    const b = await run(doc, 60_000, [outage(20_000, 500)])
    expect(a.db).toEqual(b.db)
  })
})
