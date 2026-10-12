import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../../Builder.ts"
import { dist, frames, mean, sim } from "../../components/testing.ts"
import type * as Simulation from "../../Simulation.ts"

const READ = { request: { operation: "read" } }

interface Shape {
  readonly bucket?: Record<string, unknown>
  readonly load?: Record<string, unknown>
  /** Edge settings between the client and the bucket. */
  readonly edge?: Record<string, unknown>
  readonly account?: Record<string, unknown>
  readonly seed?: number
}

/** a client -> a bucket (nothing else), writing unless the edge says read */
const bucket = (s: Shape = {}) => {
  const b = Builder.make("s3", { seed: s.seed ?? 5 })
  const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 100, ...s.load } })
  const s3 = b.add("aws.s3", { id: "bucket", settings: s.bucket ?? {} })
  b.connect(web, s3, s.edge)
  if (s.account !== undefined) b.account("aws:us-east-1", s.account)
  return b.build()
}

/** The client sends `rps` from `from` until `to`, then `after`, as a scenario's timeline would. The frames up to `to`. */
const burst = (s: Simulation.Service, rps: number, from: number, to: number, after: number) =>
  Effect.gen(function*() {
    const before = yield* s.advanceTo(from)
    yield* s.configureNode("web", { arrival: "constant", rps })
    const during = yield* s.advanceTo(to)
    yield* s.configureNode("web", { arrival: "constant", rps: after })
    return [...before, ...during]
  })

/** Rates of the bucket's counters, averaged over the windows ending after `from`. */
const rate = (all: Awaited<ReturnType<typeof frames>>, name: string, from = 5_000) => mean(all, "nodes", "bucket", "rates", name, from)

describe("aws.s3: request limits per prefix", () => {
  it("answers 503 Slow Down above 3,500 writes a second on one prefix", async () => {
    const all = await frames(bucket({ load: { rps: 7_000 } }), 20_000)
    expect(rate(all, "put")).toBeCloseTo(3_500, -2)
    expect(rate(all, "5xxErrors")).toBeCloseTo(3_500, -2)
    expect(mean(all, "nodes", "web", "rates", "fail.Throttled", 5_000)).toBeCloseTo(3_500, -2)
  })

  it("allows 5,500 reads a second on one prefix", async () => {
    const all = await frames(bucket({ load: { rps: 8_000 }, edge: READ }), 20_000)
    expect(rate(all, "get")).toBeCloseTo(5_500, -2)
    expect(rate(all, "5xxErrors")).toBeCloseTo(2_500, -2)
  })

  it("is not throttled below the limit", async () => {
    const all = await frames(bucket({ load: { rps: 3_000 } }), 20_000)
    expect(rate(all, "5xxErrors")).toBe(0)
    expect(rate(all, "put")).toBeCloseTo(3_000, -2)
  })

  it("reads and writes have separate allowances", async () => {
    const b = Builder.make("s3", { seed: 5 })
    const s3 = b.add("aws.s3", { id: "bucket" })
    b.connect(b.add("common.client", { id: "writer", settings: { arrival: "constant", rps: 3_000 } }), s3)
    b.connect(b.add("common.client", { id: "reader", settings: { arrival: "constant", rps: 5_000 } }), s3, READ)
    const all = await frames(b.build(), 15_000)
    expect(rate(all, "5xxErrors")).toBe(0)
    expect(rate(all, "get")).toBeCloseTo(5_000, -2)
    expect(rate(all, "put")).toBeCloseTo(3_000, -2)
  })

  it("scales with the number of prefixes: more prefixes, more requests", async () => {
    const one = await frames(bucket({ load: { rps: 7_000 } }), 15_000)
    const four = await frames(bucket({ load: { rps: 7_000 }, bucket: { prefixes: 4 } }), 15_000)
    expect(rate(one, "5xxErrors")).toBeGreaterThan(3_000)
    expect(rate(four, "5xxErrors")).toBe(0)
    expect(rate(four, "put")).toBeCloseTo(7_000, -2)
  })

  it("a hot key stays on one prefix however many there are", async () => {
    const all = await frames(bucket({ load: { rps: 7_000, hotKeys: 1 }, bucket: { prefixes: 4 } }), 15_000)
    expect(rate(all, "put")).toBeCloseTo(3_500, -2)
  })

  it("takes a live edit of the prefix count on the next call", () =>
    sim(bucket({ load: { rps: 7_000 } }), (s) =>
      Effect.gen(function*() {
        const before = yield* s.advanceTo(10_000)
        yield* s.configureNode("bucket", { prefixes: 4 })
        const after = yield* s.advanceTo(20_000)
        expect(mean(before, "nodes", "bucket", "rates", "5xxErrors", 5_000)).toBeGreaterThan(3_000)
        expect(mean(after, "nodes", "bucket", "rates", "5xxErrors", 12_000)).toBe(0)
      })))
})

describe("aws.s3: gradual scale-up of a hot prefix", () => {
  const hot = { load: { rps: 7_000 }, bucket: { prefixScaling: { enabled: true, splitAfter: "15 seconds", maxSplits: 3 } } }

  it("keeps answering 503 while scaling, then stops once the prefix has caught up with the demand", async () => {
    const all = await frames(bucket(hot), 50_000)
    expect(rate(all, "5xxErrors", 3_000)).toBeGreaterThan(0)
    expect(mean(all, "nodes", "bucket", "rates", "5xxErrors", 3_000, 14_000)).toBeCloseTo(3_500, -2)
    // One doubling takes the prefix to 7,000 a second, which is what is asked for.
    expect(mean(all, "nodes", "bucket", "rates", "5xxErrors", 30_000)).toBeLessThan(100)
    expect(mean(all, "nodes", "bucket", "rates", "put", 30_000)).toBeGreaterThan(6_800)
  })

  it("holds a prefix at the guaranteed rate when scale-up is off", async () => {
    const all = await frames(bucket({ ...hot, bucket: { prefixScaling: { enabled: false } } }), 50_000)
    expect(mean(all, "nodes", "bucket", "rates", "put", 30_000)).toBeCloseTo(3_500, -2)
  })

  it("never scales past the largest number of splits", async () => {
    const run = bucket({ load: { rps: 40_000 }, bucket: { prefixScaling: { enabled: true, splitAfter: "5 seconds", maxSplits: 1 } } })
    await sim(run, (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(30_000)
        const state = (yield* s.probe("bucket")).state as { scaled: { prefixes: number; writeCeiling: number } }
        expect(state.scaled.prefixes).toBe(1)
        expect(state.scaled.writeCeiling).toBe(7_000)
      }))
  })

  it("a brief spike does not count as sustained pressure", async () => {
    const run = bucket({ load: { rps: 2_000 }, bucket: { prefixScaling: { enabled: true, splitAfter: "5 seconds", maxSplits: 3 } } })
    await sim(run, (s) =>
      Effect.gen(function*() {
        yield* burst(s, 6_000, 5_000, 7_000, 2_000)
        yield* s.advanceTo(30_000)
        const state = (yield* s.probe("bucket")).state as { scaled: { prefixes: number } }
        expect(state.scaled.prefixes).toBe(0)
      }))
  })

  it("forgets the scaling when it is switched off", () =>
    sim(bucket({ load: { rps: 7_000 }, bucket: { prefixScaling: { enabled: true, splitAfter: "5 seconds", maxSplits: 3 } } }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(15_000)
        yield* s.configureNode("bucket", { prefixScaling: { enabled: false } })
        const after = yield* s.advanceTo(30_000)
        expect(mean(after, "nodes", "bucket", "rates", "put", 20_000)).toBeCloseTo(3_500, -2)
      })))
})

describe("aws.s3: kinds of request", () => {
  it("splits reads into GET, HEAD and LIST, and writes into PUT, COPY and DELETE, by the configured shares", async () => {
    const reads = await frames(bucket({ load: { rps: 2_000 }, edge: READ, bucket: { headShare: 0.25, listShare: 0.15 } }), 15_000)
    expect(rate(reads, "head") / 2_000).toBeCloseTo(0.25, 1)
    expect(rate(reads, "list") / 2_000).toBeCloseTo(0.15, 1)
    expect(rate(reads, "get") / 2_000).toBeCloseTo(0.6, 1)
    const writes = await frames(bucket({ load: { rps: 2_000 }, bucket: { deleteShare: 0.3, copyShare: 0.2 } }), 15_000)
    expect(rate(writes, "delete") / 2_000).toBeCloseTo(0.3, 1)
    expect(rate(writes, "copy") / 2_000).toBeCloseTo(0.2, 1)
    // CloudWatch counts a copy as a PUT on the destination.
    expect(rate(writes, "put") / 2_000).toBeCloseTo(0.7, 1)
  })

  it("a HEAD or DELETE has no body to move and a GET or PUT does", async () => {
    const settings = { readLatency: { mean: 40, cv: 0 }, writeLatency: { mean: 40, cv: 0 }, transferRate: 100 }
    const load = { rps: 2, payload: 10_240 } // 10 MiB: 100 ms at 100 MB/s
    const p50 = (all: Awaited<ReturnType<typeof frames>>) => dist(all, "bucket", "latency", 2_000).p50
    expect(p50(await frames(bucket({ load, edge: READ, bucket: settings }), 20_000))).toBeCloseTo(140, -1)
    expect(p50(await frames(bucket({ load, edge: READ, bucket: { ...settings, headShare: 1 } }), 20_000))).toBeCloseTo(40, -1)
    expect(p50(await frames(bucket({ load, bucket: settings }), 20_000))).toBeCloseTo(140, -1)
    expect(p50(await frames(bucket({ load, bucket: { ...settings, deleteShare: 1 } }), 20_000))).toBeCloseTo(40, -1)
  })

  it("a LIST has its own first-byte latency", async () => {
    const all = await frames(bucket({ load: { rps: 5 }, edge: READ, bucket: { listShare: 1, listLatency: { mean: 250, cv: 0 } } }), 20_000)
    expect(dist(all, "bucket", "latency", 2_000).p50).toBeCloseTo(250, -1)
  })

  it("counts a delete marker instead of removing the object when versioning is on", async () => {
    const run = (versioning: boolean) => frames(bucket({ load: { rps: 100 }, bucket: { deleteShare: 1, versioning } }), 10_000)
    expect(rate(await run(true), "deleteMarkers")).toBeCloseTo(100, -1)
    expect(rate(await run(false), "deleteMarkers")).toBe(0)
  })

  it("seeds its own mix: the same design and seed give the same frames, a different seed does not", async () => {
    const doc = (seed: number) => bucket({ seed, load: { rps: 500, arrival: "poisson" }, bucket: { deleteShare: 0.3, copyShare: 0.2 } })
    const a = await frames(doc(7), 8_000)
    const b = await frames(doc(7), 8_000)
    const c = await frames(doc(8), 8_000)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c))
  })
})

describe("aws.s3: first byte and transfer time", () => {
  it("takes the first-byte latency plus bytes over the transfer rate", async () => {
    const all = await frames(bucket({ load: { rps: 2, payload: 10_240 }, edge: READ, bucket: { readLatency: { mean: 40, cv: 0 }, transferRate: 50 } }), 20_000)
    // 10 MiB at 50 MiB/s is 200 ms, after 40 ms to the first byte.
    expect(dist(all, "bucket", "latency", 2_000).p50).toBeCloseTo(240, -1)
    expect(dist(all, "bucket", "firstByteLatency", 2_000).p50).toBeCloseTo(40, -1)
    expect(dist(all, "bucket", "totalRequestLatency", 2_000).p50).toBeCloseTo(240, -1)
  })

  it("reports bytes uploaded and downloaded", async () => {
    const down = await frames(bucket({ load: { rps: 10, payload: 100 }, edge: READ }), 10_000)
    // The window edges move a request or two between frames, so allow a couple of percent.
    expect(rate(down, "bytesDownloaded", 2_000) / (10 * 100 * 1024)).toBeCloseTo(1, 1)
    const up = await frames(bucket({ load: { rps: 10, payload: 100 } }), 10_000)
    expect(rate(up, "bytesUploaded", 2_000) / (10 * 100 * 1024)).toBeCloseTo(1, 1)
    expect(rate(up, "bytesDownloaded", 2_000)).toBe(0)
  })

  it("moves a large object over parallel parts, each one a request on the prefix", async () => {
    // 100,000 KB is 97.7 MiB: 13 parts of 8 MiB, over 10 connections, plus the initiate and the complete.
    const settings = { writeLatency: { mean: 70, cv: 0 }, transferRate: 10 }
    const load = { rps: 2, payload: 100_000 }
    const single = await frames(bucket({ load, bucket: settings }), 40_000)
    const parts = await frames(bucket({ load, bucket: { ...settings, multipart: { enabled: true } } }), 40_000)
    expect(dist(single, "bucket", "latency", 15_000).p50).toBeGreaterThan(9_000)
    // 70 initiate + 70 first byte + 70 second wave + 97.66 MiB / 100 MiB/s + 70 complete = ~1.25 s.
    expect(dist(parts, "bucket", "latency", 15_000).p50).toBeCloseTo(1_250, -2)
    expect(rate(parts, "put", 10_000)).toBeCloseTo(2 * 13, -1)
    expect(rate(parts, "post", 10_000)).toBeCloseTo(2 * 2, 0)
    expect(rate(parts, "bytesUploaded", 10_000) / (2 * 100_000 * 1024)).toBeCloseTo(1, 1)
  })

  it("parts count against the prefix: a multipart upload can throttle where a single PUT would not", async () => {
    // 3 uploads a second of 15 requests each is 45 requests a second against 3,500: fine. 300 a second is 4,500: not.
    const settings = { multipart: { enabled: true, threshold: 8, partSize: 8, concurrency: 10 } }
    const small = await frames(bucket({ load: { rps: 3, payload: 100_000 }, bucket: settings }), 15_000)
    expect(rate(small, "5xxErrors", 5_000)).toBe(0)
    const heavy = await frames(bucket({ load: { rps: 300, payload: 100_000 }, bucket: settings }), 15_000)
    expect(rate(heavy, "5xxErrors", 5_000)).toBeGreaterThan(0)
  })

  it("leaves objects under the threshold alone", async () => {
    const all = await frames(bucket({ load: { rps: 10, payload: 1_024 }, bucket: { multipart: { enabled: true, threshold: 8 } } }), 10_000)
    expect(rate(all, "put", 2_000)).toBeCloseTo(10, 0)
    expect(rate(all, "post", 2_000)).toBe(0)
  })
})

describe("aws.s3: storage classes", () => {
  it("reads in milliseconds from the instant-access classes", async () => {
    for (const storageClass of ["standard", "standard-ia", "one-zone-ia", "glacier-instant", "intelligent-tiering"]) {
      const all = await frames(bucket({ load: { rps: 50 }, edge: READ, bucket: { storageClass } }), 8_000)
      expect(rate(all, "get", 2_000)).toBeCloseTo(50, 0)
      expect(mean(all, "nodes", "web", "rates", "fail", 2_000)).toBe(0)
    }
  })

  it("refuses a GET of an archived object (403 InvalidObjectState, not retryable) but still answers HEAD and LIST", async () => {
    for (const storageClass of ["glacier-flexible", "deep-archive"]) {
      const get = await frames(bucket({ load: { rps: 50 }, edge: READ, bucket: { storageClass } }), 8_000)
      expect(mean(get, "nodes", "web", "rates", "fail.Rejected", 2_000)).toBeCloseTo(50, 0)
      expect(rate(get, "get", 2_000)).toBe(0)
      expect(rate(get, "4xxErrors", 2_000)).toBeCloseTo(50, 0)
      const head = await frames(bucket({ load: { rps: 50 }, edge: READ, bucket: { storageClass, headShare: 1 } }), 8_000)
      expect(mean(head, "nodes", "web", "rates", "fail", 2_000)).toBe(0)
    }
  })

  it("serves the share of archived reads that find a restored object", async () => {
    const all = await frames(bucket({ load: { rps: 200 }, edge: READ, bucket: { storageClass: "glacier-flexible", restoredShare: 0.4 } }), 15_000)
    expect(rate(all, "get", 2_000) / 200).toBeCloseTo(0.4, 1)
  })

  it("does not stop writes to an archive class", async () => {
    const all = await frames(bucket({ load: { rps: 50 }, bucket: { storageClass: "deep-archive" } }), 8_000)
    expect(mean(all, "nodes", "web", "rates", "fail", 2_000)).toBe(0)
  })
})

describe("aws.s3: directory buckets (S3 Express One Zone)", () => {
  it("has no per-prefix limit: 20,000 reads a second succeed where a general purpose bucket answers 503", async () => {
    const run = (bucketType: string) => frames(bucket({ load: { rps: 20_000 }, edge: READ, bucket: { bucketType } }), 8_000)
    expect(rate(await run("general"), "5xxErrors", 3_000)).toBeGreaterThan(10_000)
    expect(rate(await run("directory"), "5xxErrors", 3_000)).toBe(0)
  })

  it("is limited to 200,000 writes a second in all", async () => {
    // Three clients at the most one can send (100,000 a second) offer 300,000.
    const b = Builder.make("s3", { seed: 5 })
    const s3 = b.add("aws.s3", { id: "bucket", settings: { bucketType: "directory" } })
    for (const id of ["a", "b", "c"]) b.connect(b.add("common.client", { id, settings: { arrival: "constant", rps: 100_000 } }), s3)
    // The bucket starts with a second's worth of tokens, which a 100,000 a second excess drains in two seconds.
    const all = await frames(b.build(), 6_000)
    expect(rate(all, "put", 4_500) / 200_000).toBeCloseTo(1, 1)
  })

  it("answers faster than a general purpose bucket by the configured factor", async () => {
    const settings = { readLatency: { mean: 40, cv: 0 }, directoryLatencyFactor: 10 }
    const run = (bucketType: string) => frames(bucket({ load: { rps: 5 }, edge: READ, bucket: { ...settings, bucketType } }), 10_000)
    expect(dist(await run("general"), "bucket", "latency", 2_000).p50).toBeCloseTo(40, -1)
    expect(dist(await run("directory"), "bucket", "latency", 2_000).p50).toBeCloseTo(4, 0)
  })

  it("switches the limits live", () =>
    sim(bucket({ load: { rps: 7_000 } }), (s) =>
      Effect.gen(function*() {
        const before = yield* s.advanceTo(8_000)
        yield* s.configureNode("bucket", { bucketType: "directory" })
        const after = yield* s.advanceTo(16_000)
        expect(mean(before, "nodes", "bucket", "rates", "5xxErrors", 4_000)).toBeGreaterThan(3_000)
        expect(mean(after, "nodes", "bucket", "rates", "5xxErrors", 10_000)).toBe(0)
      })))
})

/** a client -> a bucket -> endpoints on its events port */
const notifying = (s: Shape, subscribers: ReadonlyArray<{ id: string; edge?: Record<string, unknown> }>) => {
  const b = Builder.make("s3", { seed: s.seed ?? 5 })
  const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 100, ...s.load } })
  const s3 = b.add("aws.s3", { id: "bucket", settings: { notificationDelay: { mean: 1_000, cv: 0 }, ...s.bucket } })
  b.connect(web, s3, s.edge)
  for (const sub of subscribers) b.connect(s3.port("events"), b.add("common.http-endpoint", { id: sub.id, settings: { latency: { mean: 5, cv: 0 } } }), sub.edge)
  return b.build()
}

describe("aws.s3: event notifications", () => {
  it("tells every destination about each write, after the notification delay and off the request path", async () => {
    const all = await frames(notifying({ load: { rps: 100 }, bucket: { notificationDelay: { mean: 5_000, cv: 0 } } }, [{ id: "a" }, { id: "b" }]), 20_000)
    expect(mean(all, "nodes", "a", "rates", "in", 0, 4_000)).toBe(0)
    for (const id of ["a", "b"]) expect(mean(all, "nodes", id, "rates", "ok", 8_000)).toBeCloseTo(100, -1)
    // The client never waits for the notification.
    expect(dist(all, "web", "latency", 2_000).p50).toBeLessThan(150)
    expect(rate(all, "delivered", 8_000)).toBeCloseTo(200, -1)
  })

  it("does not publish events for reads", async () => {
    const all = await frames(notifying({ load: { rps: 100 }, edge: READ }, [{ id: "a" }]), 10_000)
    expect(mean(all, "nodes", "a", "rates", "in", 0)).toBe(0)
  })

  it("sends an object-removed event for a delete and object-created for the rest, to those subscribed to each", async () => {
    const all = await frames(
      notifying({ load: { rps: 400 }, bucket: { deleteShare: 0.25 } }, [
        { id: "created", edge: { eventTypes: "created" } },
        { id: "removed", edge: { eventTypes: "removed" } },
        { id: "all" }
      ]),
      15_000
    )
    expect(mean(all, "nodes", "created", "rates", "in", 6_000) / 400).toBeCloseTo(0.75, 1)
    expect(mean(all, "nodes", "removed", "rates", "in", 6_000) / 400).toBeCloseTo(0.25, 1)
    expect(mean(all, "nodes", "all", "rates", "in", 6_000)).toBeCloseTo(400, -1)
  })

  it("a prefix and suffix filter is the fraction of events that match it", async () => {
    const all = await frames(notifying({ load: { rps: 500 } }, [{ id: "filtered", edge: { filter: 0.1 } }, { id: "plain" }]), 15_000)
    expect(mean(all, "nodes", "filtered", "rates", "in", 6_000) / 500).toBeCloseTo(0.1, 1)
    expect(mean(all, "nodes", "plain", "rates", "in", 6_000) / 500).toBeCloseTo(1, 1)
  })

  it("delivers some notifications twice when asked (at-least-once)", async () => {
    const all = await frames(notifying({ load: { rps: 200 }, bucket: { duplicateRate: 0.5 } }, [{ id: "a" }]), 15_000)
    expect(mean(all, "nodes", "a", "rates", "in", 6_000) / 200).toBeCloseTo(1.5, 1)
    const none = await frames(notifying({ load: { rps: 200 } }, [{ id: "a" }]), 15_000)
    expect(mean(none, "nodes", "a", "rates", "in", 6_000) / 200).toBeCloseTo(1, 1)
  })

  it("retries a failing destination and finally gives up, counting what it could not deliver", async () => {
    const doc = notifying({ load: { rps: 20 } }, [{ id: "down", edge: { retry: { maxAttempts: 2, backoff: 100, jitter: false } } }])
    await sim(doc, (s) =>
      Effect.gen(function*() {
        yield* s.faults.inject({ kind: "node", id: "down" }, { _tag: "Outage" })
        const all = yield* s.advanceTo(20_000)
        const state = (yield* s.probe("bucket")).state as { notifications: { delivered: number; undelivered: number; pending: number } }
        expect(state.notifications.delivered).toBe(0)
        expect(state.notifications.undelivered).toBeGreaterThan(300)
        expect(mean(all, "nodes", "down", "rates", "in", 8_000)).toBeCloseTo(40, -1) // two attempts each
      }))
  })

  it("one slow destination does not hold up another", async () => {
    const b = Builder.make("s3", { seed: 5 })
    const s3 = b.add("aws.s3", { id: "bucket", settings: { notificationDelay: { mean: 100, cv: 0 } } })
    b.connect(b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 50 } }), s3)
    b.connect(s3.port("events"), b.add("common.http-endpoint", { id: "slow", settings: { latency: { mean: 20_000, cv: 0 } } }))
    b.connect(s3.port("events"), b.add("common.http-endpoint", { id: "fast", settings: { latency: { mean: 5, cv: 0 } } }))
    const all = await frames(b.build(), 10_000)
    expect(mean(all, "nodes", "fast", "rates", "ok", 3_000)).toBeCloseTo(50, -1)
  })

  it("works with nothing wired to the events port", async () => {
    const all = await frames(bucket({ load: { rps: 100 } }), 5_000)
    expect(rate(all, "put", 1_000)).toBeCloseTo(100, -1)
  })
})

/** a client -> a bucket that replicates to another, and optionally back */
const replicating = (s: { readonly source?: Record<string, unknown>; readonly load?: Record<string, unknown>; readonly rule?: Record<string, unknown>; readonly twoWay?: boolean; readonly account?: Record<string, unknown> }) => {
  const b = Builder.make("s3", { seed: 5 })
  const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 100, ...s.load } })
  const a = b.add("aws.s3", { id: "bucket", settings: { replicationDelay: { mean: 2_000, cv: 0 }, ...s.source } })
  const r = b.add("aws.s3", { id: "replica", settings: { replicationDelay: { mean: 2_000, cv: 0 } } })
  b.connect(web, a)
  b.connect(a.port("replication"), r, s.rule)
  if (s.twoWay) b.connect(r.port("replication"), a)
  if (s.account !== undefined) b.account("aws:us-east-1", s.account)
  return b.build()
}

describe("aws.s3: replication", () => {
  it("writes each new object to the destination after the replication delay", async () => {
    const all = await frames(replicating({}), 20_000)
    expect(mean(all, "nodes", "replica", "rates", "put", 0, 1_900)).toBe(0)
    expect(mean(all, "nodes", "replica", "rates", "put", 6_000)).toBeCloseTo(100, -1)
    expect(mean(all, "nodes", "bucket", "rates", "replicated", 6_000)).toBeCloseTo(100, -1)
    expect(dist(all, "bucket", "replicationLag", 6_000).p50).toBeGreaterThan(2_000) // delay plus the network and the destination
    expect(dist(all, "bucket", "replicationLag", 6_000).p50).toBeLessThan(2_400)
  })

  it("replicates a share of objects when the rule has a filter", async () => {
    const all = await frames(replicating({ rule: { filter: 0.3 } }), 15_000)
    expect(mean(all, "nodes", "replica", "rates", "put", 6_000) / 100).toBeCloseTo(0.3, 1)
  })

  it("does not replicate a replica, so two buckets replicating to each other do not loop", async () => {
    const all = await frames(replicating({ twoWay: true }), 20_000)
    expect(mean(all, "nodes", "bucket", "rates", "put", 6_000)).toBeCloseTo(100, -1)
    expect(mean(all, "nodes", "replica", "rates", "put", 6_000)).toBeCloseTo(100, -1)
  })

  it("does not replicate deletes or reads", async () => {
    const deletes = await frames(replicating({ source: { deleteShare: 1 } }), 12_000)
    expect(mean(deletes, "nodes", "replica", "rates", "in", 0)).toBe(0)
  })

  it("is off when nothing is wired to the replication port", async () => {
    const all = await frames(bucket({ load: { rps: 100 } }), 5_000)
    expect(rate(all, "replicated", 0)).toBe(0)
  })

  it("with Replication Time Control, a region replicating more than its 1 Gb/s quota falls behind; asking for more removes the lag", async () => {
    // 100 objects of 2 MiB a second is 210 MB/s; 1 Gb/s is 125 MB/s.
    const load = { rps: 100, payload: 2_048 }
    const rtc = { replicationTimeControl: true, replicationDelay: { mean: 100, cv: 0 } }
    const capped = await frames(replicating({ load, source: rtc }), 25_000)
    const raised = await frames(replicating({ load, source: rtc, account: { s3ReplicationTransferRate: 10 } }), 25_000)
    const without = await frames(replicating({ load, source: { ...rtc, replicationTimeControl: false } }), 25_000)
    expect(dist(capped, "bucket", "replicationLag", 20_000).p50).toBeGreaterThan(5_000)
    expect(dist(raised, "bucket", "replicationLag", 20_000).p50).toBeLessThan(1_000)
    expect(dist(without, "bucket", "replicationLag", 20_000).p50).toBeLessThan(1_000)
  })
})

describe("aws.s3: probe state", () => {
  it("reports what it served, refused and still has to deliver", () =>
    sim(
      notifying({ load: { rps: 7_000 }, bucket: { deleteShare: 0.1, notificationDelay: { mean: 30_000, cv: 0 } } }, [{ id: "a" }]),
      (s) =>
        Effect.gen(function*() {
          yield* s.advanceTo(5_000)
          const state = (yield* s.probe("bucket")).state as {
            prefixes: number
            served: { writes: number; deletes: number }
            throttled: { reads: number; writes: number }
            notifications: { destinations: number; pending: number }
          }
          expect(state.prefixes).toBe(1)
          expect(state.served.writes).toBeGreaterThan(10_000)
          expect(state.served.deletes).toBeGreaterThan(1_000)
          expect(state.throttled.writes).toBeGreaterThan(10_000)
          expect(state.throttled.reads).toBe(0)
          expect(state.notifications.destinations).toBe(1)
          expect(state.notifications.pending).toBeGreaterThan(10_000)
        })
    ))
})

describe("aws.s3: failures a client sees", () => {
  it("a throttled request is Throttled (503), which the edge's retry policy retries", async () => {
    // A 3-second spike to 5,000 a second on a 3,500 a second prefix.
    const run = (doc: ReturnType<typeof bucket>) =>
      sim(doc, (s) =>
        Effect.gen(function*() {
          const during = yield* burst(s, 5_000, 5_000, 8_000, 2_500)
          return [...during, ...(yield* s.advanceTo(20_000))]
        }))
    const plain = await run(bucket({ load: { rps: 2_500 } }))
    const retried = await run(bucket({ load: { rps: 2_500 }, edge: { retry: { maxAttempts: 6, backoff: 200, jitter: true } } }))
    const failed = (all: Awaited<ReturnType<typeof frames>>) => mean(all, "nodes", "web", "rates", "fail", 0)
    expect(mean(plain, "nodes", "web", "rates", "fail.Throttled", 0)).toBeGreaterThan(0)
    expect(failed(retried)).toBeLessThan(failed(plain) / 3)
    // Each retry is another request on the prefix.
    expect(mean(retried, "nodes", "bucket", "rates", "requests", 0)).toBeGreaterThan(mean(plain, "nodes", "bucket", "rates", "requests", 0))
  })

  it("an outage is Unavailable and the Errors fault is a 500 (Failed)", () =>
    sim(bucket({ load: { rps: 100 } }), (s) =>
      Effect.gen(function*() {
        yield* s.faults.inject({ kind: "node", id: "bucket" }, { _tag: "Outage" }, "5 seconds")
        const down = yield* s.advanceTo(4_000)
        expect(mean(down, "nodes", "web", "rates", "fail.Unavailable", 1_000)).toBeCloseTo(100, -1)
        yield* s.advanceTo(8_000)
        yield* s.faults.inject({ kind: "node", id: "bucket" }, { _tag: "Errors", rate: 1 }, "5 seconds")
        const errors = yield* s.advanceTo(12_000)
        expect(mean(errors, "nodes", "web", "rates", "fail.Failed", 9_000)).toBeCloseTo(100, -1)
      })))

  it("giving up on a request cancels it when the edge is set to cancel, and leaves it running when not", async () => {
    // 10 MiB at 50 MiB/s takes 240 ms; the caller gives up after 100 ms.
    const run = (cancelOnTimeout: boolean) =>
      frames(bucket({ load: { rps: 10, payload: 10_240 }, edge: { timeout: 100, cancelOnTimeout }, bucket: { transferRate: 50, writeLatency: { mean: 40, cv: 0 } } }), 10_000)
    const cancelled = await run(true)
    const orphaned = await run(false)
    expect(rate(cancelled, "put", 2_000)).toBe(0)
    // A cancelled request stops transferring when the caller gives up (100 ms), an orphaned one runs on (240 ms).
    expect(mean(cancelled, "nodes", "bucket", "gauges", "transferring", 3_000)).toBeLessThan(0.6 * mean(orphaned, "nodes", "bucket", "gauges", "transferring", 3_000))
    expect(rate(orphaned, "put", 2_000)).toBeCloseTo(10, 0) // the work still happened
  })
})
