import { describe, expect, it } from "vitest"
import { dist, mean } from "../../components/testing.ts"
import { design, peak, run } from "./testkit.ts"

/** Query and connection times that make every figure exact (as in `Rds.test.ts`). */
const exact = {
  query: { readCpu: { mean: 1, cv: 0 }, readWait: { mean: 2, cv: 0 }, writeCpu: { mean: 1, cv: 0 }, writeWait: { mean: 2, cv: 0 }, readIos: 0, writeIos: 0 },
  connection: { handshake: { mean: 20, cv: 0 }, cpu: { mean: 3, cv: 0 } }
}
const read = { request: { operation: "read" } }
const write = { request: { operation: "write" } }
const edgeRate = (frames: Parameters<typeof mean>[0], id: string, name: string, from = 5_000) => mean(frames, "edges", id, "rates", name, from)

describe("aws.rds: what its dashboard reads", () => {
  it("averages CPUUtilization over time: 400 reads a second of 1 ms on 2 vCPUs is 20%", async () => {
    // db.r7g.large has 2 vCPUs. Reused connections, so no connection CPU once they are open.
    const { frames } = await run(design({ db: exact, load: { rps: 400 }, edge: { ...read, client: { connections: "reused" } } }), 20_000)
    expect(mean(frames, "nodes", "db", "gauges", "cpuUtilization", 5_000)).toBeCloseTo(0.2, 2)
    // The instant's gauge agrees on average, frame by frame it can only be 0, 50% or 100%.
    expect(mean(frames, "nodes", "db", "gauges", "cpu", 5_000)).toBeCloseTo(0.2, 1)
    expect(mean(frames, "nodes", "db", "gauges", "readerCpuUtilization", 5_000)).toBe(0)
  })

  it("counts the writer's storage I/Os against its volume's IOPS; an Aurora volume has none", async () => {
    const db = { ...exact, query: { ...exact.query, readIos: 2, writeIos: 3 } }
    const reads = await run(design({ db, load: { rps: 100 }, edge: { ...read, client: { connections: "reused" } } }), 15_000)
    expect(mean(reads.frames, "nodes", "db", "rates", "readIops", 5_000)).toBeCloseTo(200, -1)
    expect(mean(reads.frames, "nodes", "db", "rates", "writeIops", 5_000)).toBe(0)
    // gp3 under 400 GiB: a 3,000 IOPS baseline.
    expect(mean(reads.frames, "nodes", "db", "gauges", "provisionedIops", 5_000)).toBe(3_000)
    const writes = await run(design({ db: { ...db, engine: "aurora-postgres" }, load: { rps: 100 }, edge: { ...write, client: { connections: "reused" } } }), 15_000)
    expect(mean(writes.frames, "nodes", "db", "rates", "writeIops", 5_000)).toBeCloseTo(300, -1)
    expect(writes.frames.some((f) => f.nodes.db?.gauges.provisionedIops !== undefined)).toBe(false)
  })

  it("times successful reads and writes apart (SelectLatency, DMLLatency)", async () => {
    const reads = await run(design({ db: exact, load: { rps: 50 }, edge: { ...read, client: { connections: "reused" } } }), 10_000)
    expect(dist(reads.frames, "db", "selectLatency", 3_000).p50).toBeCloseTo(3, 0)
    // A Multi-AZ instance adds the standby's acknowledgement to a write.
    const writes = await run(
      design({ db: { ...exact, multiAz: "instance", standbyCommit: { mean: 5, cv: 0 } }, load: { rps: 50 }, edge: { ...write, client: { connections: "reused" } } }),
      10_000
    )
    expect(dist(writes.frames, "db", "dmlLatency", 3_000).p50).toBeCloseTo(8, 0)
  })

  it("a client's edge counts its own connections: open, in use, opened, and refused at max_connections", async () => {
    // As in Rds.test.ts: 50 a second each holding a connection about 1.026 s, with 30 allowed.
    const { frames } = await run(
      design({ db: { engine: "mysql", maxConnections: 30, ...exact }, load: { rps: 50 }, edge: { ...read, client: { connections: "per-request", hold: "1 second" } } }),
      30_000
    )
    const edge = "web.out->db"
    expect(edgeRate(frames, edge, "connectionsOpened", 10_000)).toBeCloseTo(29.2, 0)
    expect(edgeRate(frames, edge, "connectionsRefused", 10_000)).toBeCloseTo(mean(frames, "nodes", "db", "rates", "refused", 10_000), 5)
    expect(frames.reduce((m, f) => Math.max(m, f.edges[edge]?.gauges.connections ?? 0), 0)).toBe(30)
    expect(peak(frames, "db", "connections")).toBe(30)
    expect(mean(frames, "edges", edge, "gauges", "connectionsInUse", 10_000)).toBeGreaterThan(28)
  })
})

describe("aws.rds-proxy: what its dashboard reads", () => {
  it("times the database's share of each query, and its clients' edges count their connections to the proxy", async () => {
    const { frames } = await run(design({ db: exact, load: { rps: 100 }, edge: { ...read, client: { connections: "reused", hold: "100 millis" } }, proxy: {} }), 15_000)
    const database = dist(frames, "proxy", "databaseResponseLatency", 5_000).p50
    // The query's 3 ms in the database, plus the proxy-to-database edge's own latency.
    expect(database).toBeGreaterThanOrEqual(3)
    expect(database).toBeLessThan(dist(frames, "proxy", "latency", 5_000).p50)
    // About 100 a second each holding a connection about 100 ms: some ten connections to the proxy, none refused.
    const open = mean(frames, "edges", "web.out->proxy", "gauges", "connections", 5_000)
    expect(open).toBeGreaterThan(8)
    expect(open).toBeCloseTo(mean(frames, "nodes", "proxy", "gauges", "clientConnections", 5_000), 5)
    expect(edgeRate(frames, "web.out->proxy", "connectionsRefused")).toBe(0)
  })
})
