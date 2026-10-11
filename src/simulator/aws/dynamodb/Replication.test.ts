import { describe, expect, it } from "vitest"
import * as Builder from "../../Builder.ts"
import { dist, frames, mean } from "../../components/testing.ts"
import { stateAt, write } from "./testkit.ts"

/** A global table: `a` in us-east-1 takes the writes and replicates to `b` in eu-west-1 (and back, so loops are tested too). */
const global = (b: { table?: Record<string, unknown>; replica?: Record<string, unknown>; rps?: number } = {}) => {
  const d = Builder.make("global", { seed: 5 })
  const web = d.add("common.client", { id: "web", settings: { arrival: "constant", rps: b.rps ?? 100, payload: 1 } })
  const a = d.add("aws.dynamodb", { id: "a", settings: { writeCapacity: 5_000, ...b.table } })
  const r = d.add("aws.dynamodb", { id: "b", region: "eu-west-1", settings: { writeCapacity: 5_000, ...b.replica } })
  d.connect(web, a, write)
  d.connect(a.port("replicas"), r)
  d.connect(r.port("replicas"), a)
  return d.build()
}

describe("aws.dynamodb: global tables", () => {
  it("replicates each write to the other region, where it costs write units, and never sends it back", async () => {
    const doc = global()
    const a = await stateAt(doc, 20_000, "a")
    const b = await stateAt(doc, 20_000, "b")
    expect(a.served.writes).toBeGreaterThan(1_900)
    expect(b.served.writes).toBeGreaterThan(a.served.writes - 250) // behind by about a second of lag
    expect(b.consumed.writes).toBeGreaterThan(a.consumed.writes - 250)
    expect(a.replication.sent).toBeGreaterThan(a.served.writes - 250)
    expect(b.replication.sent).toBe(0) // replicated writes are not replicated again
  })

  it("lags a second or so behind, plus the distance between the regions", async () => {
    const all = await frames(global(), 30_000)
    const lag = dist(all, "a", "replicationLag", 5_000)
    expect(lag.p50).toBeGreaterThan(500)
    expect(lag.p50).toBeLessThan(3_000)
  })

  it("a replica without the capacity throttles the replication, not the writes at home", async () => {
    const doc = global({ replica: { writeCapacity: 20, burstSeconds: 0 } })
    const all = await frames(doc, 30_000)
    expect(mean(all, "nodes", "web", "rates", "fail", 5_000)).toBe(0) // writing at home is unaffected
    const a = await stateAt(doc, 30_000, "a")
    expect(a.replication.inFlight).toBeGreaterThan(100) // replication is queuing up, retrying with backoff
    expect(mean(all, "nodes", "b", "rates", "fail.Throttled", 5_000)).toBeGreaterThan(50)
  })

  it("TTL deletes replicate too, and the replica pays for them", async () => {
    const doc = global({ rps: 1, table: { ttl: { expiresPerSecond: 20 } } })
    const b = await stateAt(doc, 20_000, "b")
    expect(b.consumed.writes).toBeGreaterThan(20 * 15) // about 20 a second arriving there
  })
})
