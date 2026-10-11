import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../../Builder.ts"
import * as Component from "../../Component.ts"
import { builtins, providers } from "../../components/registry.ts"
import { codec } from "../../Design.ts"
import type { CallFailure, Message } from "../../Message.ts"
import * as Registry from "../../Registry.ts"
import * as Simulation from "../../Simulation.ts"
import { VirtualTime } from "../../VirtualTime.ts"
import { GiB, MAX_OBJECT_BYTES, MiB, TiB } from "./limits.ts"

/**
 * Calls made to a bucket with exactly the message a test wants, including ones no client component would send
 * (a count of 0, a body over 5 GB, a key outside [0, 1)). A test-only source component sends a script of messages
 * and records how each one ended.
 */
type Init = Partial<Pick<Message, "bytes" | "count" | "key" | "group">>
interface Sent {
  readonly init: Init
  readonly at?: number
}
let script: ReadonlyArray<Sent> = []
let outcomes: Array<{ readonly init: Init; readonly failure: CallFailure | undefined }> = []

const Source = Component.make({
  type: "test.s3-source",
  title: "Scripted source",
  category: "traffic",
  inputs: false,
  config: Schema.Struct({}),
  make: (node) =>
    Effect.sync(() => {
      const links = node.out("out")
      for (const sent of script) {
        node.fast.after(sent.at ?? 0, () => {
          links[0]!.send(node.fast.mint(sent.init), (failure) => void outcomes.push({ init: sent.init, failure }))
        }, undefined)
      }
      return {}
    })
})

/** Records every message that reaches it. */
let captured: Array<Message> = []
const Sink = Component.make({
  type: "test.s3-sink",
  title: "Recording sink",
  category: "other",
  config: Schema.Struct({}),
  make: () => Effect.succeed({ call: (message: Message) => Effect.sync(() => void captured.push(message)) })
})

const components = [...builtins, Source, Sink]

/** A source wired to one bucket (and any extras the caller adds to the builder). */
const run = (
  sends: ReadonlyArray<Sent>,
  settings: Record<string, unknown> = {},
  ms = 5_000,
  decorate: (b: Builder.Builder, bucket: Builder.NodeRef) => void = () => {},
  operation: "read" | "write" = "write"
) => {
  script = sends
  outcomes = []
  captured = []
  const b = Builder.make("inputs", { seed: 3 })
  const source = b.add("test.s3-source", { id: "source" })
  const bucket = b.add("aws.s3", { id: "bucket", settings })
  b.connect(source, bucket, { retry: { maxAttempts: 1 }, timeout: "10 minutes", request: { operation } })
  decorate(b, bucket)
  const doc = b.build()
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const design = yield* Schema.decodeUnknownEffect(codec(Registry.make(components, providers)))(doc, { errors: "all" })
        const s = yield* Simulation.make(design).pipe(Effect.provide(VirtualTime.layer), Effect.provide(Registry.Registry.layer(components, providers)), Effect.orDie)
        const all = yield* s.advanceTo(ms)
        const probe = yield* s.probe("bucket")
        return { all, state: probe.state as Record<string, any>, outcomes: [...outcomes], inflight: probe.inflight }
      })
    ).pipe(Effect.orDie)
  )
}

const tag = (o: { readonly failure: CallFailure | undefined }) => o.failure?._tag ?? "ok"
const total = (all: Awaited<ReturnType<typeof run>>["all"], name: string) => all.reduce((sum, f) => sum + (f.nodes.bucket?.rates[name] ?? 0) * (f.dt / 1000), 0)

describe("aws.s3: size limits", () => {
  it("refuses a write over 5 GB as EntityTooLarge (Rejected), and accepts 5 GB exactly", async () => {
    // The 5 GB write takes about a minute to move; a 6 GB read has no such limit (a GET can be any size).
    const r = await run([{ init: { bytes: 5 * GiB + 1 } }, { init: { bytes: 5 * GiB } }], {}, 100_000)
    expect(r.outcomes.map(tag).sort()).toEqual(["Rejected", "ok"])
    const read = await run([{ init: { bytes: 6 * GiB } }], {}, 100_000, undefined, "read")
    expect(read.outcomes.map(tag)).toEqual(["ok"])
    expect(r.state.refused.tooLarge).toBe(1)
    expect(total(r.all, "4xxErrors")).toBeCloseTo(1, 5)
  })

  it("refuses a COPY over 5 GB too, since a copy of more needs multipart as well", async () => {
    const r = await run([{ init: { bytes: 6 * GiB } }], { copyShare: 1 })
    expect(r.outcomes.map(tag)).toEqual(["Rejected"])
  })

  it("takes an object over 5 GB as parts when multipart is on, up to 48.8 TiB, and no further", async () => {
    const r = await run(
      // Spaced out: parts are charged to the prefix when a transfer starts, so two huge uploads at once would share one bucket.
      [{ init: { bytes: 6 * GiB } }, { init: { bytes: 40 * TiB }, at: 2_000 }, { init: { bytes: MAX_OBJECT_BYTES }, at: 4_000 }, { init: { bytes: MAX_OBJECT_BYTES + 1 }, at: 6_000 }],
      { multipart: { enabled: true, partSize: 5_120, concurrency: 1_000 }, transferRate: 12_500 },
      400_000
    )
    expect(r.outcomes.map(tag).sort()).toEqual(["Rejected", "ok", "ok", "ok"])
    expect(r.state.refused.tooLarge).toBe(1)
  })

  it("never uses more than 10,000 parts: the part size grows with the object", async () => {
    // 1 TiB in 8 MiB parts would be 131,072 parts. It is cut into 10,000 (about 105 MiB each).
    const r = await run([{ init: { bytes: TiB } }], { multipart: { enabled: true, partSize: 8, concurrency: 100 }, transferRate: 12_500 }, 60_000)
    expect(r.state.served.multipartParts).toBe(10_000)
    expect(total(r.all, "post")).toBeCloseTo(2, 5)
  })
})

describe("aws.s3: odd inputs", () => {
  it("treats a count of zero or less as one request, and a negative or missing body as empty", async () => {
    const r = await run([
      { init: { count: 0 } },
      { init: { count: -3 } },
      { init: { bytes: -100 } },
      { init: { bytes: Number.NaN } },
      { init: { bytes: 0 } }
    ])
    expect(r.outcomes.map(tag)).toEqual(["ok", "ok", "ok", "ok", "ok"])
    expect(r.state.served.writes).toBe(5)
    // Only the two with the default 1 KiB body count; a negative, missing or empty one is empty.
    expect(total(r.all, "bytesUploaded")).toBe(2_048)
    expect(r.state.transferring).toBe(0)
  })

  it("puts a key outside [0, 1), or not a number, on a valid prefix", async () => {
    const r = await run([{ init: { key: -1 } }, { init: { key: 1 } }, { init: { key: 7.5 } }, { init: { key: Number.NaN } }, { init: { key: Number.POSITIVE_INFINITY } }], { prefixes: 3 })
    expect(r.outcomes.map(tag)).toEqual(["ok", "ok", "ok", "ok", "ok"])
  })

  it("a batch counts as that many requests on the prefix and in the metrics", async () => {
    const r = await run([{ init: { count: 3_000 } }, { init: { count: 1_000 } }], { prefixes: 1 })
    // 3,000 requests leave 500 in a bucket of 3,500; a call is all or nothing, so 1,000 more is refused.
    expect(r.outcomes.map(tag).sort()).toEqual(["Throttled", "ok"])
    expect(r.state.throttled.writes).toBe(1_000)
    expect(total(r.all, "requests")).toBeCloseTo(4_000, 3)
    expect(total(r.all, "put")).toBeCloseTo(3_000, 3)
  })

  it("works with the minimum and maximum of every setting", async () => {
    const lo = { prefixes: 1, transferRate: 1, multipart: { enabled: true, threshold: 5, partSize: 5, concurrency: 1 }, prefixScaling: { enabled: true, splitAfter: "1 second", maxSplits: 1 } }
    const hi = { prefixes: 100_000, transferRate: 12_500, multipart: { enabled: true, threshold: 5_120, partSize: 5_120, concurrency: 1_000 }, prefixScaling: { enabled: true, splitAfter: "1 day", maxSplits: 30 } }
    const sends = [{ init: { bytes: 20 * MiB } }, { init: {} }, { init: { bytes: 0 } }]
    for (const settings of [lo, hi]) {
      const r = await run(sends, settings, 30_000)
      expect(r.outcomes.map(tag)).toEqual(["ok", "ok", "ok"])
    }
  })

  it("a shares mix over 1 starves the later kinds instead of failing", async () => {
    const r = await run(Array.from({ length: 50 }, () => ({ init: {} })), { deleteShare: 1, copyShare: 1 })
    expect(r.outcomes.map(tag).every((t) => t === "ok")).toBe(true)
    expect(r.state.served.deletes).toBe(50)
    expect(r.state.served.copies).toBe(0)
  })
})

describe("aws.s3: notifications and replicas, as messages", () => {
  it("sends one event per object created, however large the batch, in a bounded number of messages", async () => {
    const r = await run([{ init: { count: 3_000 } }, { init: { count: 1 } }, { init: { count: 7 } }], {}, 20_000, (b, bucket) => {
      b.connect(bucket.port("events"), b.add("common.http-endpoint", { id: "sink", settings: { latency: { mean: 1, cv: 0 } } }))
    })
    // 3,000 + 1 + 7 events, as 100 + 1 + 7 messages.
    expect(r.state.notifications.delivered).toBe(108)
    expect(r.state.notifications.pending).toBe(0)
  })

  it("strips the sender's message group and says the event is a small asynchronous write: an S3 notification has no group", async () => {
    await run([{ init: { group: "g1", bytes: 5 * MiB } }], {}, 10_000, (b, bucket) => {
      b.connect(bucket.port("events"), b.add("test.s3-sink", { id: "sink" }))
    })
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({ bytes: 1_024, count: 1, operation: "write", invocation: "async" })
    expect("group" in captured[0]!).toBe(false)
  })

  it("marks a replica with a group the destination does not replicate again", async () => {
    await run([{ init: { bytes: 5 * MiB } }], { replicationDelay: { mean: 100, cv: 0 } }, 10_000, (b, bucket) => {
      b.connect(bucket.port("replication"), b.add("test.s3-sink", { id: "replica" }))
    })
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({ bytes: 5 * MiB, operation: "write", group: "s3:replica" })
  })
})

describe("aws.s3: cleanup", () => {
  it("gives back everything an interrupted transfer held", async () => {
    // Timeout well inside the transfer, and the edge cancels: nothing is left transferring, nothing is counted as served.
    script = [{ init: { bytes: 100 * MiB } }]
    const b = Builder.make("cancel", { seed: 3 })
    const source = b.add("test.s3-source", { id: "source" })
    b.connect(source, b.add("aws.s3", { id: "bucket", settings: { transferRate: 10 } }), { timeout: 200, cancelOnTimeout: true })
    outcomes = []
    const out = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const design = yield* Schema.decodeUnknownEffect(codec(Registry.make(components, providers)))(b.build(), { errors: "all" })
          const s = yield* Simulation.make(design).pipe(Effect.provide(VirtualTime.layer), Effect.provide(Registry.Registry.layer(components, providers)), Effect.orDie)
          yield* s.advanceTo(30_000)
          return (yield* s.probe("bucket")).state as Record<string, any>
        })
      ).pipe(Effect.orDie)
    )
    expect(outcomes.map(tag)).toEqual(["Timeout"])
    expect(out.transferring).toBe(0)
    expect(out.served.writes).toBe(0)
  })

  it("holds no state per request: many requests leave the same footprint as a few", async () => {
    const r = await run(Array.from({ length: 2_000 }, (_, i) => ({ init: { key: i / 2_000 }, at: i })), { prefixes: 50 }, 10_000)
    expect(r.outcomes).toHaveLength(2_000)
    expect(r.state.transferring).toBe(0)
    expect(r.inflight).toBe(0)
  })
})
