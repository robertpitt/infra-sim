import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../../../Builder.ts"
import { mean, sim } from "../../../testing.ts"
import type * as Design from "../../../Design.ts"
import type { Frame } from "../../../Telemetry.ts"
import { MiB } from "../../internal/units.ts"

const near = { latency: { mean: 1, cv: 0 } }

interface Shape {
  readonly firehose?: Record<string, unknown>
  readonly load?: Record<string, unknown>
  /** The destination: an S3 bucket (default) or an HTTP endpoint. */
  readonly http?: Record<string, unknown>
  readonly bucket?: Record<string, unknown>
  /** A transformation Lambda on the transform port. */
  readonly transform?: Record<string, unknown>
  /** An S3 bucket on the backup port. */
  readonly backup?: boolean
  /** Feed it from a Kinesis stream with these settings instead of directly. */
  readonly kinesis?: Record<string, unknown>
  readonly region?: string
  readonly account?: Record<string, unknown>
}

/** clients -> [Kinesis stream ->] Firehose `f` -> S3 bucket `lake` (or HTTP endpoint `http`) */
const pipeline = (o: Shape = {}): Design.Doc => {
  const b = Builder.make("firehose", { seed: 6 })
  const region = o.region ?? "us-east-1"
  const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 100, payload: 1, ...o.load } })
  const f = b.add("aws.firehose", { id: "f", region, settings: { ...o.firehose } })
  if (o.kinesis !== undefined) {
    const s = b.add("aws.kinesis", { id: "s", region, settings: o.kinesis })
    b.connect(web, s, near)
    b.connect(s.port("consumers"), f, near)
  } else {
    b.connect(web, f, near)
  }
  if (o.http !== undefined) b.connect(f, b.add("common.http-endpoint", { id: "http", settings: { latency: { mean: 50, cv: 0 }, ...o.http } }), near)
  else b.connect(f, b.add("aws.s3", { id: "lake", region, settings: { ...o.bucket } }), near)
  if (o.transform !== undefined) b.connect(f.port("transform"), b.add("aws.lambda", { id: "fn", region, settings: { memory: 1024, duration: { mean: 50 }, ...o.transform } }), near)
  if (o.backup === true) b.connect(f.port("backup"), b.add("aws.s3", { id: "backup", region }), near)
  if (o.account !== undefined) b.account(`aws:${region}`, o.account)
  return b.build()
}

interface State {
  readonly source: string
  readonly buffers: number
  readonly held: { records: number; bytes: number; deliveries: number; failing: number }
  readonly dataFreshness: number
  readonly totals: Record<string, number>
}

const run = (doc: Design.Doc, ms: number, faults: ReadonlyArray<{ at: number; id: string; for: number }> = []) =>
  sim(doc, (s) =>
    Effect.gen(function*() {
      const frames: Array<Frame> = []
      for (const f of faults) {
        frames.push(...(yield* s.advanceTo(f.at)))
        yield* s.faults.inject({ kind: "node", id: f.id }, { _tag: "Outage" }, `${f.for} millis`)
      }
      frames.push(...(yield* s.advanceTo(ms)))
      return { frames, state: (yield* s.probe("f")).state as State }
    }))

const total = (frames: ReadonlyArray<Frame>, id: string, rate: string, scope: "nodes" | "edges" = "nodes"): number =>
  frames.reduce((n, f) => n + ((f[scope][id]?.rates[rate] ?? 0) * 250) / 1000, 0)

describe("aws.firehose: buffering", () => {
  it("delivers a buffer once it reaches the size hint: one object per buffer, one PUT to S3", async () => {
    // 1 MiB a second into a 5 MiB buffer: an object every five seconds.
    const { frames, state } = await run(pipeline({ load: { rps: 1_024, payload: 1 }, firehose: { bufferSize: 5 } }), 60_000)
    const objects = mean(frames, "nodes", "f", "rates", "objects", 10_000)
    expect(objects).toBeGreaterThan(0.17)
    expect(objects).toBeLessThan(0.23)
    expect(mean(frames, "nodes", "lake", "rates", "put", 10_000)).toBeCloseTo(objects, 2)
    expect(state.totals.deliveredBytes! / state.totals.objects!).toBeCloseTo(5 * MiB, -5)
    expect(state.totals.delivered! / state.totals.objects!).toBeCloseTo(5_120, -2)
  })

  it("or once the interval is up, whichever comes first", async () => {
    const { frames, state } = await run(pipeline({ load: { rps: 10, payload: 1 }, firehose: { bufferInterval: "60 seconds" } }), 300_000)
    expect(state.totals.objects).toBe(4) // at 60, 120, 180 and 240 seconds (the fifth is due as the run ends)
    expect(Math.max(...frames.map((f) => f.nodes.f!.gauges.dataFreshness ?? 0))).toBeGreaterThan(58_000)
    expect(Math.max(...frames.map((f) => f.nodes.f!.gauges.dataFreshness ?? 0))).toBeLessThan(62_000)
  })

  it("the defaults (5 MiB, 300 s) give one object every five minutes at a trickle", async () => {
    const { state } = await run(pipeline({ load: { rps: 5, payload: 1 } }), 610_000)
    expect(state.totals.objects).toBe(2)
  })

  it("an interval of 0 delivers within about a second", async () => {
    const { frames } = await run(pipeline({ load: { rps: 50, payload: 1 }, firehose: { bufferInterval: 0 } }), 30_000)
    expect(mean(frames, "nodes", "f", "rates", "objects", 5_000)).toBeCloseTo(1, 0)
    expect(Math.max(...frames.slice(20).map((f) => f.nodes.f!.gauges.dataFreshness ?? 0))).toBeLessThanOrEqual(1_100)
  })
})

describe("aws.firehose: Direct PUT quotas", () => {
  it("a stream takes 5 MiB/s in N. Virginia; past it, Throttled", async () => {
    // 8 MiB a second offered.
    const { frames } = await run(pipeline({ load: { rps: 256, payload: 32 }, firehose: { bufferSize: 128 } }), 30_000)
    const bytes = mean(frames, "nodes", "f", "rates", "incomingBytes", 5_000)
    expect(bytes).toBeGreaterThan(4.7 * MiB)
    expect(bytes).toBeLessThan(5.2 * MiB)
    expect(mean(frames, "nodes", "web", "rates", "fail.Throttled", 5_000)).toBeGreaterThan(80)
  })

  it("1 MiB/s in most other regions, and raising the quota raises it", async () => {
    const london = await run(pipeline({ region: "eu-west-2", load: { rps: 64, payload: 32 }, firehose: { bufferSize: 128 } }), 30_000)
    expect(mean(london.frames, "nodes", "f", "rates", "incomingBytes", 5_000)).toBeLessThan(1.1 * MiB)
    const raised = await run(pipeline({ region: "eu-west-2", load: { rps: 64, payload: 32 }, firehose: { bufferSize: 128 }, account: { firehoseDirectPutMiBps: 4 } }), 30_000)
    expect(mean(raised.frames, "nodes", "f", "rates", "incomingBytes", 5_000)).toBeCloseTo(2 * MiB, -5)
    expect(mean(raised.frames, "nodes", "f", "rates", "throttled", 5_000)).toBe(0)
  })

  it("2,000 requests a second in N. Virginia, however small", async () => {
    const { frames } = await run(pipeline({ load: { rps: 3_000, payload: 0.1 } }), 20_000)
    expect(mean(frames, "nodes", "f", "rates", "putRequests", 5_000)).toBeCloseTo(2_000, -2)
    expect(mean(frames, "nodes", "f", "rates", "throttled", 5_000)).toBeCloseTo(1_000, -2)
  })

  it("refuses records over 1,000 KiB", async () => {
    const { state } = await run(pipeline({ load: { rps: 5, payload: 1_100 } }), 5_000)
    expect(state.totals.rejected).toBeGreaterThan(20)
    expect(state.totals.incoming).toBe(0)
  })
})

describe("aws.firehose: transformation", () => {
  it("records go through the transformation Lambda in batches of about the transform buffer, at the size it makes them", async () => {
    // 1 MiB a second, 1 MB transform batches, the function halving them.
    const doc = pipeline({ load: { rps: 1_024, payload: 1 }, firehose: { bufferSize: 5, transform: { bufferSize: 1, outputRatio: 0.5 } }, transform: {} })
    const { frames, state } = await run(doc, 60_000)
    expect(mean(frames, "nodes", "fn", "rates", "invocations", 10_000)).toBeCloseTo(1, 0)
    expect(state.totals.transformedRecords).toBeGreaterThan(50_000)
    // Each record leaves the function at half its size, so 5 MiB objects take ten seconds of input to fill.
    expect(state.totals.deliveredBytes! / state.totals.delivered!).toBeCloseTo(512, 0)
    expect(mean(frames, "nodes", "f", "rates", "objects", 15_000)).toBeCloseTo(0.1, 1)
  })

  it("cuts a big arrival into transform batches of the buffer size, never one oversized invocation", async () => {
    // One 3 MiB PutRecordBatch a second (300 records of 10 KiB) against 1 MiB transform batches: three invocations each.
    const doc = pipeline({ load: { rps: 1, records: 300, payload: 3_072 }, firehose: { bufferSize: 5, transform: { bufferSize: 1 } }, transform: {} })
    const { frames, state } = await run(doc, 30_000)
    expect(mean(frames, "nodes", "fn", "rates", "invocations", 5_000)).toBeGreaterThan(2.5)
    expect(state.totals.transformFailed ?? 0).toBe(0)
    expect(state.totals.transformedRecords).toBeGreaterThan(8_000)
  })

  it("a failing transformation is retried, then its records are written to the error prefix", async () => {
    const doc = pipeline({ load: { rps: 200, payload: 1 }, firehose: { transform: { bufferSize: 0.2, retries: 3 } }, transform: { errorRate: 1 } })
    const { frames, state } = await run(doc, 60_000)
    const invocations = total(frames, "fn", "invocations")
    expect(invocations / (state.totals.transformFailed ?? 1)).toBeCloseTo(1, 1)
    expect(state.totals.processingFailed).toBeGreaterThan(9_000)
    expect(state.totals.backedUp).toBe(state.totals.processingFailed)
    expect(state.totals.delivered).toBe(0)
    // Four tries per batch: the first and three retries.
    expect(invocations / (state.totals.processingFailed! / 200)).toBeGreaterThan(3)
  })

  it("records the function reports failed (ProcessingFailed) are set aside; the rest are delivered", async () => {
    const doc = pipeline({ load: { rps: 500, payload: 1 }, firehose: { bufferSize: 1, transform: { bufferSize: 0.5 } }, transform: { errorRate: 0.1, batch: { errors: "report" } } })
    const { state } = await run(doc, 60_000)
    const share = state.totals.processingFailed! / (state.totals.processingFailed! + state.totals.transformedRecords!)
    expect(share).toBeGreaterThan(0.08)
    expect(share).toBeLessThan(0.12)
  })
})

describe("aws.firehose: delivery failures", () => {
  it("S3 down: deliveries are retried, freshness grows, and everything lands once it is back", async () => {
    const doc = pipeline({ load: { rps: 100, payload: 10 }, firehose: { bufferSize: 1, bufferInterval: "10 seconds" } })
    const { frames, state } = await run(doc, 300_000, [{ at: 30_000, id: "lake", for: 120_000 }])
    expect(Math.max(...frames.map((f) => f.nodes.f!.gauges.dataFreshness ?? 0))).toBeGreaterThan(100_000)
    expect(state.totals.deliveryFailed).toBeGreaterThan(5)
    expect(state.totals.lost).toBe(0)
    expect(state.totals.delivered).toBeGreaterThan(29_000)
    // Buffers that were ready while S3 was down went out merged into larger objects.
    const sizes = state.totals.deliveredBytes! / state.totals.objects!
    expect(sizes).toBeGreaterThan(1.05 * MiB)
  })

  it("an HTTP endpoint is retried for the retry duration, then the data is backed up to S3", async () => {
    const doc = pipeline({ load: { rps: 100, payload: 1 }, firehose: { destination: "http", bufferSize: 1, bufferInterval: "10 seconds", retryDuration: "30 seconds" }, http: {}, backup: true })
    const { state } = await run(doc, 300_000, [{ at: 30_000, id: "http", for: 120_000 }])
    expect(state.totals.backedUp).toBeGreaterThan(5_000)
    expect(state.totals.lost).toBe(0)
    expect(state.totals.delivered! + state.totals.backedUp!).toBeGreaterThan(28_000)
  })

  it("an HTTP endpoint's 413 is a permanent failure: not retried, not backed up", async () => {
    const doc = pipeline({ load: { rps: 100, payload: 10 }, firehose: { destination: "http", bufferSize: 1 }, http: { maxPayload: 500 }, backup: true })
    const { state } = await run(doc, 60_000)
    expect(state.totals.lost).toBeGreaterThan(4_000)
    expect(state.totals.backedUp).toBe(0)
    expect(state.totals.objects).toBe(0)
  })
})

describe("aws.firehose: Kinesis source", () => {
  it("reads every shard once a second and isn't held to the Direct PUT quota", async () => {
    // 2 MB/s through a two-shard stream into a Firehose stream in London (Direct PUT there: 1 MiB/s).
    const doc = pipeline({ region: "eu-west-2", kinesis: { shards: 2 }, load: { rps: 500, payload: 4 }, firehose: { bufferSize: 5 } })
    const { frames, state } = await run(doc, 120_000)
    expect(state.source).toBe("kinesis")
    expect(mean(frames, "nodes", "f", "rates", "incomingBytes", 20_000)).toBeCloseTo(2_000 * 1024, -5)
    expect(mean(frames, "nodes", "f", "rates", "in", 20_000)).toBeCloseTo(2, 0) // a call per shard per second
    expect(state.totals.throttled).toBe(0)
  })

  it("buffers per shard: at a trickle, every shard delivers its own object each interval", async () => {
    // 50 KB a second: three megabytes a minute, under the 5 MiB size hint, so the interval decides.
    const slow = { load: { rps: 100, payload: 0.5 }, firehose: { bufferInterval: "60 seconds" } }
    const direct = await run(pipeline(slow), 300_000)
    const fromStream = await run(pipeline({ ...slow, kinesis: { shards: 4 } }), 300_000)
    expect(direct.state.totals.objects).toBe(4)
    expect(fromStream.state.totals.objects).toBe(16) // four shards, four buffers, four times the objects at a quarter the size
  })

  it("once fed by a stream, Direct PUT is refused", async () => {
    const b = Builder.make("both", { seed: 1 })
    const f = b.add("aws.firehose", { id: "f" })
    const s = b.add("aws.kinesis", { id: "s" })
    b.connect(b.add("common.client", { id: "producer", settings: { rps: 50 } }), s, near)
    b.connect(s.port("consumers"), f, near)
    b.connect(b.add("common.client", { id: "direct", settings: { rps: 10 } }), f, near)
    const { frames } = await run(b.build(), 20_000)
    expect(mean(frames, "nodes", "direct", "rates", "fail.Rejected", 5_000)).toBeCloseTo(10, 0)
  })

  it("with S3 down it stops reading: records wait in the stream and nothing is lost", async () => {
    const doc = pipeline({ kinesis: { shards: 1 }, load: { rps: 100, payload: 10 }, firehose: { bufferSize: 1, bufferInterval: "10 seconds" } })
    const { frames, state } = await run(doc, 360_000, [{ at: 30_000, id: "lake", for: 120_000 }])
    const behind = Math.max(...frames.map((f) => f.edges["s.consumers->f"]?.gauges.millisBehindLatest ?? 0))
    expect(behind).toBeGreaterThan(60_000)
    expect(state.totals.refusedFromStream).toBeGreaterThan(0)
    expect(state.totals.lost).toBe(0)
    expect(state.totals.delivered).toBeGreaterThan(32_000)
  })
})

describe("aws.firehose: hardening", () => {
  it("a call with no records stores nothing; with no destination wired, deliveries go somewhere outside the design", async () => {
    const b = Builder.make("bare", { seed: 3 })
    b.connect(b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 1_024, payload: 1 } }), b.add("aws.firehose", { id: "f", settings: { bufferSize: 1 } }), near)
    const { state } = await run(b.build(), 20_000)
    expect(state.totals.objects).toBeGreaterThan(15)
    expect(state.totals.lost).toBe(0)
    expect(state.totals.delivered! + state.held.records).toBe(state.totals.incoming)
  })

  it("the same design and seed give the same result", async () => {
    const doc = pipeline({ kinesis: { shards: 2 }, load: { rps: 300, payload: 2 }, firehose: { bufferSize: 1, transform: { bufferSize: 0.5 } }, transform: { errorRate: 0.05 } })
    const one = await run(doc, 60_000, [{ at: 20_000, id: "lake", for: 10_000 }])
    const two = await run(doc, 60_000, [{ at: 20_000, id: "lake", for: 10_000 }])
    expect(two.state).toEqual(one.state)
  })
})
