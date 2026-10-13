import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import type { Fast } from "../../../Component.ts"
import type { CallFailure, Message } from "../../../Message.ts"
import * as SeededRandom from "../../../SeededRandom.ts"
import { tallies } from "../../../kit/Tally.ts"
import * as VirtualTime from "../../../VirtualTime.ts"
import { Cluster } from "../internal/cluster.ts"
import { Config } from "../internal/config.ts"
import { Cpu } from "../internal/cpu.ts"
import { Task } from "../internal/node.ts"
import { Refresh } from "../internal/refresh.ts"
import { type Context, COUNTERS, makeMetrics, write } from "../internal/requests.ts"

/** The mechanisms on their own, on a bare virtual-time world: exact numbers, no traffic sources in the way. */

const world = () => {
  const w = VirtualTime.make()
  return { w, fast: { now: w.nowUnsafe, after: w.after }, advance: (ms: number) => Effect.runSync(w.advanceTo(ms)) }
}

describe("aws.opensearch: processor sharing", () => {
  it("runs one job at full speed, and shares the cores evenly beyond one job per core", () => {
    const { fast, advance } = world()
    const cpu = new Cpu(fast, 2)
    const done: Array<number> = []
    for (let i = 0; i < 4; i++) cpu.run(100, () => done.push(fast.now()))
    advance(1_000)
    expect(done).toEqual([200, 200, 200, 200]) // 400 ms of work on 2 cores
  })

  it("slows running jobs down when more arrive, and speeds them up when some finish", () => {
    const { fast, advance } = world()
    const cpu = new Cpu(fast, 2)
    const done: Record<string, number> = {}
    cpu.run(100, () => (done.a = fast.now()))
    cpu.run(100, () => (done.b = fast.now()))
    fast.after(50, () => cpu.run(100, () => (done.c = fast.now())), undefined)
    advance(1_000)
    // To 50 ms: a and b at full speed. Then three jobs on two cores: a and b need 50 more at 2/3, so 125 ms. c has 50 by
    // then and finishes alone at full speed: 175 ms.
    expect(done.a).toBeCloseTo(125, 6)
    expect(done.b).toBeCloseTo(125, 6)
    expect(done.c).toBeCloseTo(175, 6)
  })

  it("reports utilisation over the time since it was last asked", () => {
    const { fast, advance } = world()
    const cpu = new Cpu(fast, 4)
    cpu.run(100, () => {})
    advance(200)
    expect(cpu.sample()).toBeCloseTo(100 / (200 * 4), 6)
  })
})

describe("aws.opensearch: replica writes", () => {
  const harness = (settings: Record<string, unknown>) => {
    const { w, fast: base, advance } = world()
    const config = Schema.decodeUnknownSync(Config)(settings)
    const random = SeededRandom.make(3)
    const fast: Fast<Config> = {
      ...base,
      settings: () => config,
      random,
      mint: () => { throw new Error("unused") },
      account: () => ({})
    }
    const cluster = new Cluster(fast)
    cluster.reconcile(config)
    const counts = tallies(undefined, COUNTERS)
    const ctx: Context = { id: "d", fast, cluster, refresh: new Refresh(fast), tallies: counts, searchable: { add: () => {} }, metrics: makeMetrics(undefined) }
    let id = 0
    const send = (bytes: number, answers: Array<CallFailure | undefined>, count = 1): void => {
      const message: Message = { id: ++id, bornAt: w.nowUnsafe(), origin: "t", attempt: 1, bytes, count, invocation: "sync", operation: "write", key: 0.5 }
      const out = write(ctx, message, (failure) => answers.push(failure))
      if (typeof out !== "function") answers.push(out)
    }
    return { cluster, counts, advance, send, fast }
  }

  it("never rejects a replica for a full queue: it is forced in, past the 10,000", () => {
    const { cluster, counts, advance, send } = harness({ dataNodes: 2, primaryShards: 1, replicas: 1, indexing: { cpuPerDocument: 1, cpuPerRequest: 0 } })
    // The replica's node (node 1) is stuck: both its write threads are busy for good.
    const replicaNode = cluster.nodes[cluster.shards[0]!.copies[1]!]!
    for (let i = 0; i < 2; i++) replicaNode.submit(new Task("write", 1e12, () => {}, () => {}))
    const answers: Array<CallFailure | undefined> = []
    for (let t = 0; t < 12_000; t++) {
      send(100, answers)
      advance(t + 1)
    }
    expect(replicaNode.write.queued).toBeGreaterThan(10_000)
    expect(counts.writeRejected.total).toBe(0)
  })

  it("refuses a replica past 1.5 times the indexing pressure limit, and the write still succeeds on the primary", () => {
    const { cluster, counts, advance, send } = harness({ dataNodes: 2, primaryShards: 1, replicas: 1, indexing: { cpuPerDocument: 1, cpuPerRequest: 0 } })
    const replicaNode = cluster.nodes[cluster.shards[0]!.copies[1]!]!
    for (let i = 0; i < 2; i++) replicaNode.submit(new Task("write", 1e12, () => {}, () => {}))
    const answers: Array<CallFailure | undefined> = []
    // 50 MiB writes, one every 100 ms; the replica limit is 1.5 × 819 MiB, about 24 of them.
    for (let i = 0; i < 100; i++) {
      send(50 * 1024 * 1024, answers)
      advance((i + 1) * 100)
    }
    const limit = 0.1 * 8 * 1024 ** 3 * 1.5
    expect(replicaNode.replicaBytes).toBeLessThanOrEqual(limit)
    expect(replicaNode.replicaBytes).toBeGreaterThan(limit - 50 * 1024 * 1024)
    expect(counts.replicaRejected.total).toBeGreaterThan(0)
    expect(answers.filter((a) => a === undefined).length).toBe(counts.replicaRejected.total)
  })

  it("indexes the documents of a bulk request that got through, and answers 429 for the whole request if any were refused", () => {
    const { cluster, counts, advance, send } = harness({ dataNodes: 3, primaryShards: 3, replicas: 0, indexing: { cpuPerDocument: 1, cpuPerRequest: 0 } })
    // Node 0 (shard 0's primary) has both write threads busy and a full queue.
    const blocked = cluster.nodes[0]!
    for (let i = 0; i < 2 + 10_000; i++) blocked.submit(new Task("write", 1e12, () => {}, () => {}))
    const answers: Array<CallFailure | undefined> = []
    send(3 * 1024, answers, 3) // one document per shard
    advance(1_000)
    expect(counts.writeRejected.total).toBe(1)
    expect(counts.indexed.total).toBe(2)
    expect(answers).toHaveLength(1)
    expect(answers[0]?._tag).toBe("Throttled")
    expect(answers[0] !== undefined && "reason" in answers[0] ? answers[0].reason : "").toContain("1 of 3 documents")
  })
})
