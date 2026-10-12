import { Effect } from "effect"
import * as Builder from "../../Builder.ts"
import { sim } from "../../components/testing.ts"
import type * as Design from "../../Design.ts"
import type { Frame } from "../../Telemetry.ts"

/** Helpers shared by the Kinesis tests: clients writing to a stream `s`, read by consumers, and a way to look at the result. */

/** A millisecond of network each way, so what a test measures is the stream and its consumers, not the distance. */
export const near = { latency: { mean: 1, cv: 0 } }

export interface Shape {
  readonly stream?: Record<string, unknown>
  /** The writer: a constant-rate client. */
  readonly load?: Record<string, unknown>
  /** Consumers: an HTTP endpoint (a function that always answers) per entry, wired with these edge settings. */
  readonly consumers?: ReadonlyArray<{ readonly id: string; readonly edge?: Record<string, unknown>; readonly fn?: Record<string, unknown>; readonly connector?: string }>
  /** Wire an on-failure destination `dlq` to the stream. */
  readonly dlq?: boolean
  readonly account?: Record<string, unknown>
  readonly seed?: number
}

export const stream = (o: Shape = {}): Design.Doc => {
  const b = Builder.make("kinesis", { seed: o.seed ?? 5 })
  const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 100, payload: 1, ...o.load } })
  const s = b.add("aws.kinesis", { id: "s", settings: { ...o.stream } })
  b.connect(web, s, near)
  for (const c of o.consumers ?? []) {
    const fn = b.add("common.http-endpoint", { id: c.id, settings: { latency: { mean: 20, cv: 0 }, ...c.fn } })
    b.connect(s.port("consumers"), fn, { ...near, ...c.edge }, c.connector === undefined ? {} : { connector: c.connector })
  }
  if (o.dlq === true) b.connect(s.port("discarded"), b.add("common.http-endpoint", { id: "dlq", settings: { latency: { mean: 5, cv: 0 } } }), near)
  if (o.account !== undefined) b.account("aws:us-east-1", o.account)
  return b.build()
}

/** Run for `ms`, and return the frames and the probes of the stream and of each consumer edge. */
export const run = (doc: Design.Doc, ms: number, edges: ReadonlyArray<string> = []) =>
  sim(doc, (s) =>
    Effect.gen(function*() {
      const frames: ReadonlyArray<Frame> = yield* s.advanceTo(ms)
      const stream = (yield* s.probe("s")).state as StreamState
      const probes: Record<string, MappingState> = {}
      for (const id of edges) probes[id] = (yield* s.probeEdge(`s.consumers->${id}`)).state as MappingState
      return { frames, stream, edges: probes }
    }))

export interface StreamState {
  readonly mode: string
  readonly shards: number
  readonly closedShards: number
  readonly updating: boolean
  readonly updatesToday: number
  readonly updatesWaiting: boolean
  readonly iteratorAge: number
  readonly backlog: number
  readonly retained: number
  readonly totals: Record<
    | "incoming"
    | "incomingBytes"
    | "throttled"
    | "rejected"
    | "getRecords"
    | "outgoing"
    | "outgoingBytes"
    | "readThrottled"
    | "pushed"
    | "expired"
    | "splits"
    | "reshards"
    | "onFailureSent"
    | "onFailureFailed",
    number
  >
  readonly consumers: ReadonlyArray<{ name: string; efo: boolean; refused: boolean; iteratorAge: number; backlog: number }>
  readonly hottest: ReadonlyArray<{ shard: string; lo: number; hi: number; bytesPerSecond: number; recordsPerSecond: number }>
}

export interface MappingState {
  readonly shards: number
  readonly inflight: number
  readonly iteratorAge: number
  readonly backlog: number
  readonly blocked: number
  readonly enhancedFanOut: boolean
  readonly refused: boolean
  readonly totals: Record<"batches" | "records" | "retries" | "bisected" | "discarded" | "expired" | "itemFailures", number>
}

/** The largest value a gauge reached in frames ending in [from, to]. */
export const peak = (all: ReadonlyArray<Frame>, scope: "nodes" | "edges", id: string, name: string, from = 0, to = Number.POSITIVE_INFINITY): number =>
  all.filter((f) => f.t >= from && f.t <= to).reduce((m, f) => Math.max(m, f[scope][id]?.gauges[name] ?? 0), 0)
