import { Duration } from "effect"
import { describe, expect, it } from "vitest"
import { dist, mean, peakGauge } from "../../../testing.ts"
import type * as Simulation from "../../../Simulation.ts"
import { design, exact, outage, read, run, write, zoneOutage } from "../testing.ts"

const multiAz = { ...exact, multiAz: "instance", failover: { multiAzInstance: { mean: 60_000, cv: 0 } } }
const ok = (r: Awaited<ReturnType<typeof run>>, id: string, from: number, to = Infinity) => mean(r.frames, "nodes", id, "rates", "ok", from, to)

/** A fault on one zone of us-east-1 for `ms`, at `at`. */
const zoneFault = (at: number, ms: number, zone: string, fault: Parameters<Simulation.Service["faults"]["inject"]>[1]) => ({
  at,
  act: (s: Simulation.Service) => s.faults.inject({ kind: "zone", id: `aws:us-east-1:${zone}` }, fault, ms)
})

describe("aws.rds: availability zones", () => {
  it("places the primary in the node's zone, or the region's first", async () => {
    const unplaced = await run(design({ db: exact, load: { rps: 1 }, edge: read }), 1_000)
    const placed = await run(design({ db: exact, load: { rps: 1 }, edge: read, zone: "us-east-1c" }), 1_000)
    expect(unplaced.db.writerZone).toBe("us-east-1a")
    expect(placed.db.writerZone).toBe("us-east-1c")
  })

  it("a Multi-AZ instance fails over when its primary's zone goes down, then serves from the standby's zone while it is down", async () => {
    // us-east-1a is down from 30 s to 150 s; the failover takes 60 s.
    const r = await run(design({ db: multiAz, load: { rps: 50 }, edge: read }), 200_000, [zoneOutage(30_000, 120_000)])
    expect(ok(r, "db", 31_000, 89_000)).toBe(0)
    expect(mean(r.frames, "nodes", "web", "rates", "fail.Unavailable", 31_000, 89_000)).toBeCloseTo(50, 0)
    expect(ok(r, "db", 91_000, 149_000)).toBeCloseTo(50, 0)
    expect(ok(r, "db", 151_000)).toBeCloseTo(50, 0)
    expect(r.db.failovers).toBe(1)
    expect(r.db.writerZone).toBe("us-east-1b")
    // Its connections went with the zone: none are open while it fails over.
    expect(peakGauge(r.frames, "db", "connections", 31_000, 89_000)).toBe(0)
  })

  it("a Single-AZ instance is down until its zone returns, and doesn't fail over", async () => {
    const r = await run(design({ db: exact, load: { rps: 50 }, edge: read }), 120_000, [zoneOutage(30_000, 60_000)])
    expect(ok(r, "db", 31_000, 89_000)).toBe(0)
    expect(r.db.unavailable).toBeGreaterThan(2_900)
    expect(ok(r, "db", 91_000)).toBeCloseTo(50, 0)
    expect(r.db.failovers).toBe(0)
    expect(r.db.writerZone).toBe("us-east-1a")
  })

  it("another zone's outage doesn't touch a primary; a node placed in a zone is lost with that one", async () => {
    const other = await run(design({ db: exact, load: { rps: 50 }, edge: read }), 60_000, [zoneOutage(10_000, 40_000, "us-east-1c")])
    expect(mean(other.frames, "nodes", "web", "rates", "fail", 0)).toBe(0)
    const placed = await run(design({ db: exact, load: { rps: 50 }, edge: read, zone: "us-east-1c" }), 60_000, [zoneOutage(10_000, 40_000, "us-east-1c")])
    expect(ok(placed, "db", 11_000, 49_000)).toBe(0)
    expect(ok(placed, "db", 51_000)).toBeCloseTo(50, 0)
  })

  it("Aurora promotes a reader in another zone; the reader in the third keeps serving reads", async () => {
    // A writer in us-east-1a, readers in b and c. Lose a from 30 s to 150 s: b is promoted in 40 s.
    const db = { ...exact, engine: "aurora-mysql", readers: 2, failover: { aurora: { mean: 40_000, cv: 0 } } }
    const r = await run(design({ db, load: { rps: 20 }, edge: read, other: { load: { rps: 10 }, edge: write } }), 200_000, [zoneOutage(30_000, 120_000)])
    expect(ok(r, "web", 31_000, 149_000)).toBeCloseTo(20, 0)
    expect(ok(r, "other", 31_000, 69_000)).toBe(0)
    expect(ok(r, "other", 71_000, 149_000)).toBeCloseTo(10, 0)
    // One reader serves meanwhile: c while b is promoted, then c again while a (the old writer, now a reader) is down.
    expect(mean(r.frames, "nodes", "db", "gauges", "readers", 31_000, 149_000)).toBe(1)
    expect(mean(r.frames, "nodes", "db", "gauges", "readers", 151_000)).toBe(2)
    expect(r.db.failovers).toBe(1)
    expect(r.db.writerZone).toBe("us-east-1b")
  })

  it("losing a reader's zone takes that reader out of the reader endpoint, and nothing else", async () => {
    const db = { ...exact, engine: "aurora-postgres", readers: 2 }
    const r = await run(design({ db, load: { rps: 20 }, edge: read, other: { load: { rps: 10 }, edge: write } }), 90_000, [zoneOutage(30_000, 30_000, "us-east-1c")])
    expect(mean(r.frames, "nodes", "db", "gauges", "readers", 31_000, 59_000)).toBe(1)
    expect(mean(r.frames, "nodes", "db", "gauges", "readers", 61_000)).toBe(2)
    expect(ok(r, "other", 0)).toBeCloseTo(10, 0)
    expect(ok(r, "web", 31_000)).toBeCloseTo(20, 0)
    expect(r.db.failovers).toBe(0)
  })

  it("Aurora with no reader in another zone is down until its zone returns", async () => {
    const r = await run(design({ db: { ...exact, engine: "aurora-mysql", readers: 0 }, load: { rps: 20 }, edge: read }), 120_000, [zoneOutage(30_000, 60_000)])
    expect(ok(r, "db", 31_000, 89_000)).toBe(0)
    expect(ok(r, "db", 91_000)).toBeCloseTo(20, 0)
    expect(r.db.failovers).toBe(0)
  })

  it("a Multi-AZ DB cluster promotes a standby in 25 s and reads carry on from the third zone", async () => {
    const db = { ...exact, engine: "postgres", instanceClass: "db.r6gd.large", multiAz: "cluster", failover: { multiAzCluster: { mean: 25_000, cv: 0 } } }
    const r = await run(design({ db, load: { rps: 20 }, edge: read, other: { load: { rps: 10 }, edge: write } }), 120_000, [zoneOutage(30_000, 60_000)])
    expect(ok(r, "web", 31_000)).toBeCloseTo(20, 0)
    expect(ok(r, "other", 31_000, 54_000)).toBe(0)
    expect(ok(r, "other", 56_000)).toBeCloseTo(10, 0)
    expect(mean(r.frames, "nodes", "db", "gauges", "readers", 31_000, 89_000)).toBe(1)
    expect(mean(r.frames, "nodes", "db", "gauges", "readers", 91_000)).toBe(2)
  })

  it("losing the standby's zone too strands the writer until a zone returns, then it fails over there", async () => {
    // a down 30 s to 230 s: fail over to b by 60 s. b down 100 s to 300 s: nothing to fail over to until a returns at
    // 230 s, then a second failover, to a, done at 260 s.
    const db = { ...multiAz, failover: { multiAzInstance: { mean: 30_000, cv: 0 } } }
    const r = await run(design({ db, load: { rps: 50 }, edge: read }), 320_000, [zoneOutage(30_000, 200_000), zoneOutage(100_000, 200_000, "us-east-1b")])
    expect(ok(r, "db", 61_000, 99_000)).toBeCloseTo(50, 0)
    expect(ok(r, "db", 101_000, 259_000)).toBe(0)
    expect(ok(r, "db", 261_000)).toBeCloseTo(50, 0)
    expect(r.db.failovers).toBe(2)
    expect(r.db.writerZone).toBe("us-east-1a")
  })

  it("an Outage on the node still fails the primary over, and moves it to the standby's zone", async () => {
    const r = await run(design({ db: multiAz, load: { rps: 50 }, edge: read }), 120_000, [outage(30_000, 1_000)])
    expect(r.db.failovers).toBe(1)
    expect(r.db.failoverUntil).toBe(90_000)
    expect(r.db.writerZone).toBe("us-east-1b")
  })

  it("RDS Proxy rides out a zone's failover as it does a primary's: requests wait instead of failing", async () => {
    const db = { ...exact, multiAz: "instance", failover: { multiAzInstance: { mean: 30_000, cv: 0 } } }
    const edge = { ...read, timeout: "1 minute", client: { hold: "300 millis" } }
    const direct = await run(design({ db, load: { rps: 20 }, edge }), 100_000, [zoneOutage(30_000, 60_000)])
    const proxied = await run(design({ db, load: { rps: 20 }, edge, proxy: {} }), 100_000, [zoneOutage(30_000, 60_000)])
    expect(mean(direct.frames, "nodes", "web", "rates", "fail", 31_000, 59_000)).toBeCloseTo(20, 0)
    expect(mean(proxied.frames, "nodes", "web", "rates", "fail", 31_000, 99_000)).toBe(0)
    expect(proxied.proxy?.retried).toBeGreaterThan(0)
    // Its node placed in the zone that went down, the proxy (in several zones) is still there.
    const placed = await run(design({ db, load: { rps: 20 }, edge, proxy: {} }), 40_000, [zoneOutage(30_000, 5_000, "us-east-1c")])
    expect(mean(placed.frames, "nodes", "proxy", "rates", "fail", 0)).toBe(0)
  })

  it("a Slow or Errors fault on a zone reaches the queries on the instances there", async () => {
    // Aurora: the writer in a, its reader in b. a is 50 ms slower; half of b's queries fail.
    const db = { ...exact, engine: "aurora-postgres", readers: 1 }
    const r = await run(design({ db, load: { rps: 20 }, edge: read, other: { load: { rps: 20 }, edge: write } }), 40_000, [
      zoneFault(10_000, 30_000, "us-east-1a", { _tag: "Slow", extra: Duration.millis(50) }),
      zoneFault(10_000, 30_000, "us-east-1b", { _tag: "Errors", rate: 0.5 })
    ])
    expect(dist(r.frames, "db", "latency", 2_000, 9_000).mean).toBeCloseTo(3, 0)
    expect(dist(r.frames, "other", "latency", 11_000).mean).toBeGreaterThan(50)
    expect(mean(r.frames, "nodes", "web", "rates", "fail.Failed", 11_000)).toBeGreaterThan(7)
    expect(mean(r.frames, "nodes", "web", "rates", "fail.Failed", 11_000)).toBeLessThan(13)
    expect(mean(r.frames, "nodes", "other", "rates", "fail", 11_000)).toBe(0)
  })

  it("is deterministic through a zone outage", async () => {
    const doc = design({ db: { engine: "aurora-mysql", readers: 2 }, load: { rps: 80, arrival: "poisson" }, edge: { ...read, client: { hold: "100 millis" } } })
    const a = await run(doc, 90_000, [zoneOutage(20_000, 30_000)])
    const b = await run(doc, 90_000, [zoneOutage(20_000, 30_000)])
    expect(a.db).toEqual(b.db)
  })
})
