import { Effect } from "effect"
import * as Builder from "../../Builder.ts"
import { mean, sim } from "../../components/testing.ts"
import type { Frame } from "../../Telemetry.ts"
import type { State } from "./Ecs.ts"

/** Helpers for the ECS tests: a client calling a service directly, run through a list of live edits. */

export type Probe = typeof State.Type

export const gauge = (all: ReadonlyArray<Frame>, name: string, from = 0, to = Infinity, id = "svc") => mean(all, "nodes", id, "gauges", name, from, to)
export const rate = (all: ReadonlyArray<Frame>, name: string, from = 0, to = Infinity, id = "svc") => mean(all, "nodes", id, "rates", name, from, to)
export const minGauge = (all: ReadonlyArray<Frame>, name: string, from = 0, to = Infinity, id = "svc") =>
  Math.min(...all.filter((f) => f.t >= from && f.t <= to).map((f) => f.nodes[id]?.gauges[name] ?? Infinity))
export const maxGauge = (all: ReadonlyArray<Frame>, name: string, from = 0, to = Infinity, id = "svc") =>
  Math.max(...all.filter((f) => f.t >= from && f.t <= to).map((f) => f.nodes[id]?.gauges[name] ?? -Infinity))
/** The first time a gauge meets a condition, at or after `from`. */
export const firstAt = (all: ReadonlyArray<Frame>, name: string, test: (v: number) => boolean, from = 0, id = "svc") =>
  all.find((f) => f.t >= from && test(f.nodes[id]?.gauges[name] ?? Number.NaN))?.t

/** 50 ms a request, no downstream calls, a 100 MiB image (4 s to pull), 5 s to start the application. */
export const DEFAULTS = { fanOut: "none", task: { serviceTime: { mean: 50, cv: 0 }, imageSize: 100 } }
export const BIG_QUOTA = { fargateOnDemandVcpus: 10_000, fargateSpotVcpus: 10_000, ec2OnDemandStandardVcpus: 10_000, ec2SpotStandardVcpus: 10_000 }

/** Settings merged one level deep, so a test can say `task: { cpu: "512" }` and keep the defaults' other task fields. */
export const merge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...a }
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k]
    out[k] = v !== null && typeof v === "object" && !Array.isArray(v) && prev !== null && typeof prev === "object" && !Array.isArray(prev) ? { ...prev, ...v } : v
  }
  return out
}

export interface Options {
  readonly rps?: number
  readonly account?: Record<string, unknown>
  readonly seed?: number
  readonly arrival?: "constant" | "poisson"
  /** Put a target group on the edge (`core.target-group`) instead of a plain call. */
  readonly targetGroup?: Record<string, unknown>
  /** Attach a target-tracking controller on desiredCount with these settings. */
  readonly scaling?: Record<string, unknown>
}

export const service = (settings: Record<string, unknown>, o: Options = {}) => {
  const b = Builder.make("ecs", { seed: o.seed ?? 5 })
  const web = b.add("common.client", { id: "web", region: "us-east", settings: { rps: o.rps ?? 100, arrival: o.arrival ?? "constant" } })
  const region = b.add("aws.region", { id: "region", settings: { region: "us-east-1" } })
  const svc = b.add("aws.ecs", { id: "svc", parent: region, settings: merge(DEFAULTS, settings) })
  if (o.targetGroup === undefined) b.connect(web, svc, { timeout: "30 seconds" })
  else b.connect(web, svc, { timeout: "30 seconds", ...o.targetGroup }, { connector: "core.target-group" })
  b.account("aws:us-east-1", o.account ?? BIG_QUOTA)
  if (o.scaling !== undefined) b.control("core.target-tracking", svc, { setting: "desiredCount", ...o.scaling }, { id: "scaling" })
  return b.build()
}

/** Run a design, applying live edits at the given times (each restating the test's settings), and probe the service at the end. */
export const run = (
  doc: ReturnType<typeof service>,
  base: Record<string, unknown>,
  steps: ReadonlyArray<readonly [at: number, settings: Record<string, unknown>]>,
  until: number,
  extra: ReadonlyArray<readonly [at: number, act: "zone-down" | "zone-up" | "web", value?: Record<string, unknown>]> = []
) =>
  sim(doc, (s) =>
    Effect.gen(function*() {
      const all: Array<Frame> = []
      const events = [
        ...steps.map(([at, settings]) => ({ at, apply: s.configureNode("svc", merge(merge(DEFAULTS, base), settings)) })),
        ...extra.map(([at, act, value]) => ({
          at,
          apply: act === "zone-down"
            ? s.faults.inject({ kind: "zone", id: "aws:us-east-1:us-east-1a" }, { _tag: "Outage" })
            : act === "zone-up"
            ? s.faults.clearAll
            : s.configureNode("web", value ?? {})
        }))
      ].sort((a, b) => a.at - b.at)
      for (const e of events) {
        all.push(...(yield* s.advanceTo(e.at)))
        yield* (e.apply as Effect.Effect<unknown, unknown>).pipe(Effect.orDie)
      }
      all.push(...(yield* s.advanceTo(until)))
      return { all, probe: (yield* s.probe("svc")).state as Probe }
    }))
