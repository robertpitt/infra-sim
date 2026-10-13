import { Effect } from "effect"
import * as Builder from "../../Builder.ts"
import { sim } from "../../testing.ts"
import type * as Design from "../../Design.ts"
import type * as Simulation from "../../Simulation.ts"
import type { Frame } from "../../Telemetry.ts"
import type { RdsProxy } from "./Proxy.ts"
import type { Rds } from "./Rds.ts"

/** Helpers shared by the RDS tests: a client calling a database (directly, or through a proxy), and reading the result. */

/** Settings that make query and connection times exact, so rates and latencies can be checked to the millisecond. */
export const exact = {
  query: { readCpu: { mean: 1, cv: 0 }, readWait: { mean: 2, cv: 0 }, writeCpu: { mean: 1, cv: 0 }, writeWait: { mean: 2, cv: 0 }, readIos: 0, writeIos: 0 },
  connection: { handshake: { mean: 20, cv: 0 }, cpu: { mean: 3, cv: 0 } }
}
/** An edge's settings that make its requests reads, or writes. */
export const read = { request: { operation: "read" } }
export const write = { request: { operation: "write" } }

export type DbState = typeof Rds.state.Type
export type ProxyState = typeof RdsProxy.state.Type
type Settings = Record<string, unknown>

export interface Shape {
  /** The database's settings. */
  readonly db?: Settings
  /** The client's settings (constant arrivals unless set). */
  readonly load?: Settings
  /** The client edge's settings: the plain link's and the client connector's (`client: {...}`). */
  readonly edge?: Settings
  /** Put an RDS Proxy between the client and the database, with these settings. */
  readonly proxy?: Settings
  /** The proxy-to-database edge's settings. */
  readonly target?: Settings
  /** A second client calling the database directly, with its edge's settings. */
  readonly other?: { readonly load: Settings; readonly edge?: Settings }
  readonly account?: Settings
  readonly seed?: number
  /** The Availability Zone the database's node is placed in (its primary's); us-east-1a, the region's first, if not. */
  readonly zone?: string
}

/** web -> db, or web -> proxy -> db. Node ids: `web`, `proxy`, `db`, `other`. */
export const design = (s: Shape = {}): Design.Doc => {
  const b = Builder.make("rds", { seed: s.seed ?? 5 })
  const web = b.add("common.client", { id: "web", settings: { arrival: "constant", ...s.load } })
  const db = b.add("aws.rds", { id: "db", settings: s.db ?? {}, ...(s.zone === undefined ? {} : { zone: s.zone }) })
  if (s.proxy !== undefined) {
    const proxy = b.add("aws.rds-proxy", { id: "proxy", settings: s.proxy })
    b.connect(web, proxy, s.edge)
    b.connect(proxy, db, s.target)
  } else b.connect(web, db, s.edge)
  if (s.other !== undefined) {
    const other = b.add("common.client", { id: "other", settings: { arrival: "constant", ...s.other.load } })
    b.connect(other, db, s.other.edge)
  }
  if (s.account !== undefined) b.account("aws:us-east-1", s.account)
  return b.build()
}

export interface Run {
  readonly frames: ReadonlyArray<Frame>
  readonly db: DbState
  readonly proxy: ProxyState | undefined
}

/**
 * Run a design for `ms`, applying `during` first (fault injections, live edits), and return the frames and the probes.
 * `steps` advances in stages, running each one's action at its time.
 */
export const run = (doc: Design.Doc, ms: number, steps: ReadonlyArray<{ readonly at: number; readonly act: (s: Simulation.Service) => Effect.Effect<unknown, unknown> }> = []): Promise<Run> =>
  sim(doc, (s) =>
    Effect.gen(function*() {
      const frames: Array<Frame> = []
      for (const step of [...steps].sort((a, b) => a.at - b.at)) {
        frames.push(...(yield* s.advanceTo(step.at)))
        yield* Effect.orDie(step.act(s))
      }
      frames.push(...(yield* s.advanceTo(ms)))
      const db = (yield* s.probe("db")).state as DbState
      const proxy = doc.nodes.proxy === undefined ? undefined : ((yield* s.probe("proxy")).state as ProxyState)
      return { frames, db, proxy }
    }))

/** An Outage on the database node for `ms`, at `at`: its primary failing. */
export const outage = (at: number, ms: number, id = "db") => ({
  at,
  act: (s: Simulation.Service) => s.faults.inject({ kind: "node", id }, { _tag: "Outage" }, ms)
})

/** An Outage on one Availability Zone of us-east-1 (where the test designs are) for `ms`, at `at`. */
export const zoneOutage = (at: number, ms: number, zone = "us-east-1a") => ({
  at,
  act: (s: Simulation.Service) => s.faults.inject({ kind: "zone", id: `aws:us-east-1:${zone}` }, { _tag: "Outage" }, ms)
})
