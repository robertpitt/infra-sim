import { Effect } from "effect"
import * as Builder from "../../Builder.ts"
import { mean, sim } from "../../components/testing.ts"
import type * as Simulation from "../../Simulation.ts"
import type { Frame } from "../../Telemetry.ts"
import type { State } from "./config.ts"

/** Fixed, known latencies so expectations are exact. */
const FAST = { latency: { mean: 1, cv: 0 } }

export interface Options {
  /** Settings of the cache. */
  readonly settings?: Record<string, unknown>
  /** Settings of the reading client (constant arrivals, 1,000 a second unless changed). */
  readonly load?: Record<string, unknown>
  /** Settings of the read edge into the cache. */
  readonly edge?: Record<string, unknown>
  /** A second client that writes, at this rate. */
  readonly writes?: number
  readonly writeLoad?: Record<string, unknown>
  /** The database behind the cache (an HTTP endpoint, 20 ms), its settings, or none at all. */
  readonly db?: false | Record<string, unknown>
  /** A DynamoDB table instead of the endpoint. */
  readonly table?: Record<string, unknown>
  readonly account?: Record<string, unknown>
  readonly seed?: number
  /** The Availability Zone the cache's node is placed in (its first shard's first node); us-east-1a if not. */
  readonly zone?: string
}

/** Readers (and optionally writers) in front of a cache in front of a database. */
export const design = (o: Options = {}) => {
  const b = Builder.make("cache", { seed: o.seed ?? 5 })
  const app = b.add("common.client", { id: "app", settings: { arrival: "constant", rps: 1_000, ...o.load } })
  const cache = b.add("aws.elasticache", { id: "cache", settings: o.settings ?? {}, ...(o.zone === undefined ? {} : { zone: o.zone }) })
  b.connect(app, cache, { request: { operation: "read" }, ...FAST, ...o.edge }, { id: "app->cache" })
  if (o.writes !== undefined) {
    const writer = b.add("common.client", { id: "writer", settings: { arrival: "constant", rps: o.writes, ...o.writeLoad } })
    b.connect(writer, cache, { request: { operation: "write" }, ...FAST }, { id: "writer->cache" })
  }
  // The database behind it takes both the misses and the writes, each on its own edge.
  const db = o.table !== undefined
    ? b.add("aws.dynamodb", { id: "db", settings: o.table })
    : o.db !== false
    ? b.add("common.http-endpoint", { id: "db", settings: { latency: { mean: 20, cv: 0 }, ...o.db } })
    : undefined
  if (db !== undefined) {
    b.connect(cache.port("misses"), db, FAST, { id: "misses" })
    b.connect(cache.port("writes"), db, FAST, { id: "writes" })
  }
  if (o.account !== undefined) b.account("aws:us-east-1", o.account)
  return b.build()
}

export const stateOf = (s: Simulation.Service, id = "cache") => Effect.map(s.probe(id), (p) => p.state as State)

/** Run a design for `ms`; the cache's state at the end, and every frame. */
export const run = (doc: ReturnType<typeof design>, ms: number) =>
  sim(doc, (s) =>
    Effect.gen(function*() {
      const all = yield* s.advanceTo(ms)
      return { state: yield* stateOf(s), all }
    }))

/** A rate or gauge of a node, averaged over the frames ending in [from, to]. */
export const rate = (all: ReadonlyArray<Frame>, id: string, name: string, from = 0, to = Infinity) => mean(all, "nodes", id, "rates", name, from, to)
export const gauge = (all: ReadonlyArray<Frame>, id: string, name: string, from = 0, to = Infinity) => mean(all, "nodes", id, "gauges", name, from, to)

/** The largest value a rate reached in any one frame in [from, to]. */
export const peak = (all: ReadonlyArray<Frame>, id: string, name: string, from = 0, to = Infinity) =>
  all.filter((f) => f.t >= from && f.t <= to).reduce((most, f) => Math.max(most, f.nodes[id]?.rates[name] ?? 0), 0)
