import { Effect, Schema } from "effect"
import * as Builder from "../../Builder.ts"
import * as Component from "../../Component.ts"
import { builtins, providers } from "../../components/registry.ts"
import { codec, type Doc } from "../../Design.ts"
import * as Edge from "../../Edge.ts"
import * as Registry from "../../Registry.ts"
import * as Setting from "../../Setting.ts"
import * as Simulation from "../../Simulation.ts"
import type { Frame } from "../../Telemetry.ts"
import { VirtualTime } from "../../VirtualTime.ts"
import type { OpenSearch } from "./OpenSearch.ts"

/**
 * Helpers for the OpenSearch tests: a domain with traffic in front of it, run on a registry that also has a bulk
 * indexer (a test-only source: the standard client always sends one record per request).
 */

export type State = typeof OpenSearch.state.Type
export const read = { request: { operation: "read" } }

/**
 * Bulk requests at a constant rate, each carrying `docs` documents of `kb` KB; `hotKeys` of them share one routing key.
 * Calls are fired and forgotten: the edge and the domain count what happens to them.
 */
const BulkIndexer = Component.make({
  type: "test.bulk",
  title: "Bulk indexer",
  category: "traffic",
  inputs: false,
  config: Schema.Struct({
    rps: Setting.number({ default: 10, min: 0, max: 100_000 }),
    docs: Setting.int({ default: 100, min: 1, max: 1_000_000 }),
    kb: Setting.number({ default: 1, min: 0.001, max: 1_000_000 }),
    hotKeys: Setting.ratio({ default: 0 })
  }),
  make: (node) =>
    Effect.sync(() => {
      const { fast } = node
      const links = node.out("out")
      let next = fast.now()
      const fire = (): void => {
        const c = fast.settings()
        const link = Edge.pickUnsafe(links, fast.random)
        if (link !== undefined && c.rps > 0) {
          const hot = c.hotKeys > 0 && fast.random.nextDoubleUnsafe() < c.hotKeys
          link.send(fast.mint({ count: c.docs, bytes: Math.round(c.docs * c.kb * 1024), ...(hot ? { key: 0.1234, spread: 0 } : {}) }))
        }
        next += c.rps > 0 ? 1000 / c.rps : 100
        fast.after(Math.max(0, next - fast.now()), fire, undefined)
      }
      fast.after(0, fire, undefined)
      return {}
    })
})

const registry = Registry.make([...builtins, BulkIndexer], providers)
const layer = Registry.Registry.layer([...builtins, BulkIndexer], providers)

export interface Load {
  /** `client` sends one document (or one search) per request; `bulk` sends `docs` per request. */
  readonly kind: "client" | "bulk"
  readonly id: string
  readonly settings: Record<string, unknown>
  readonly edge?: Record<string, unknown>
}

/** A domain `d` in us-east-1 with the given loads in front of it, its node placed in `zone` if given. */
export const domain = (settings: Record<string, unknown>, loads: ReadonlyArray<Load>, seed = 7, zone?: string): Doc => {
  const b = Builder.make("opensearch", { seed })
  const region = b.add("aws.region", { id: "us-east-1", settings: { region: "us-east-1" }, size: { w: 800, h: 600 } })
  const d = b.add("aws.opensearch", { id: "d", parent: region, settings, ...(zone === undefined ? {} : { zone }) })
  for (const load of loads) {
    const source = load.kind === "client"
      ? b.add("common.client", { id: load.id, settings: { arrival: "constant", ...load.settings } })
      : b.add("test.bulk", { id: load.id, settings: load.settings })
    b.connect(source, d, load.edge)
  }
  return b.build()
}

/** Run a test body against a fresh simulation of `doc`. */
export const sim = <A, E>(doc: Doc, body: (sim: Simulation.Service) => Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const design = yield* Schema.decodeUnknownEffect(codec(registry))(doc, { errors: "all" }).pipe(Effect.orDie)
        const s = yield* Simulation.make(design).pipe(Effect.provide(VirtualTime.layer), Effect.provide(layer), Effect.orDie)
        return yield* body(s)
      })
    )
  )

/** Every frame of a run of `ms`. */
export const frames = (doc: Doc, ms: number): Promise<ReadonlyArray<Frame>> => sim(doc, (s) => s.advanceTo(ms))

/** The domain's state after `ms`. */
export const stateAt = (doc: Doc, ms: number): Promise<State> =>
  sim(doc, (s) =>
    Effect.gen(function*() {
      yield* s.advanceTo(ms)
      return (yield* s.probe("d")).state as State
    }))

/** Frames and the final state of one run. */
export const run = (doc: Doc, ms: number): Promise<{ readonly frames: ReadonlyArray<Frame>; readonly state: State }> =>
  sim(doc, (s) =>
    Effect.gen(function*() {
      const all = yield* s.advanceTo(ms)
      return { frames: all, state: (yield* s.probe("d")).state as State }
    }))

/** Largest value of a node's gauge over frames in [fromMs, toMs]. */
export const peak = (all: ReadonlyArray<Frame>, id: string, gauge: string, fromMs = 0, toMs = Infinity): number =>
  all.filter((f) => f.t >= fromMs && f.t <= toMs).reduce((m, f) => Math.max(m, f.nodes[id]?.gauges[gauge] ?? 0), 0)
