import { Effect } from "effect"
import * as Builder from "../../Builder.ts"
import { sim } from "../../components/testing.ts"
import type { Frame } from "../../Telemetry.ts"
import { merge } from "../ecs/testkit.ts"
import type { State } from "./Eks.ts"

export { firstAt, gauge, maxGauge, minGauge, rate } from "../ecs/testkit.ts"

/** Helpers for the EKS tests: a client calling a workload directly, run through a list of live edits. */

export type Probe = typeof State.Type

/**
 * 50 ms a request; pods of 500m and 512 MiB (5 workers each); a 100 MiB image (4 s to pull); 5 s to start, so ready at the
 * 10 s readiness probe. m7i.large nodes have 1.93 vCPUs allocatable: three pods a node. A node joins in 90 s.
 */
export const DEFAULTS = { fanOut: "none", pod: { serviceTime: { mean: 50, cv: 0 }, imageSize: 100 } }
export const QUOTA = { ec2OnDemandStandardVcpus: 10_000, ec2SpotStandardVcpus: 10_000 }

export interface Options {
  readonly rps?: number
  readonly seed?: number
  readonly account?: Record<string, unknown>
  /** A target-tracking controller (the HPA) on replicas. */
  readonly hpa?: Record<string, unknown>
}

export const workload = (settings: Record<string, unknown>, o: Options = {}) => {
  const b = Builder.make("eks", { seed: o.seed ?? 9 })
  const web = b.add("common.client", { id: "web", region: "us-east", settings: { rps: o.rps ?? 100, arrival: "constant" } })
  const region = b.add("aws.region", { id: "region", settings: { region: "us-east-1" } })
  const app = b.add("aws.eks", { id: "svc", parent: region, settings: merge(DEFAULTS, settings) })
  b.connect(web, app, { timeout: "30 seconds" })
  b.account("aws:us-east-1", o.account ?? QUOTA)
  if (o.hpa !== undefined) b.control("core.target-tracking", app, { setting: "replicas", ...o.hpa }, { id: "hpa" })
  return b.build()
}

/** The HPA as target tracking: CPU per pod against 70% of the request, every 15 s, scale-down held 5 minutes. */
export const HPA = { metric: "cpuPods", per: "unit", targetValue: 0.7, min: 3, max: 60, window: "30 seconds", period: "15 seconds", tolerance: 0.1, scaleOutCooldown: 0, scaleInCooldown: "5 minutes" }

export const run = (
  doc: ReturnType<typeof workload>,
  base: Record<string, unknown>,
  steps: ReadonlyArray<readonly [at: number, settings: Record<string, unknown>]>,
  until: number,
  extra: ReadonlyArray<readonly [at: number, act: "zone-down" | "zone-up" | "web", value?: Record<string, unknown>]> = []
) =>
  sim(doc, (s) =>
    Effect.gen(function*() {
      const all: Array<Frame> = []
      const events = [
        ...steps.map(([at, settings]) => ({ at, apply: s.configureNode("svc", merge(merge(DEFAULTS, base), settings)) as Effect.Effect<unknown, unknown> })),
        ...extra.map(([at, act, value]) => ({
          at,
          apply: (act === "zone-down"
            ? s.faults.inject({ kind: "zone", id: "aws:us-east-1:us-east-1a" }, { _tag: "Outage" })
            : act === "zone-up"
            ? s.faults.clearAll
            : s.configureNode("web", value ?? {})) as Effect.Effect<unknown, unknown>
        }))
      ].sort((a, b) => a.at - b.at)
      for (const e of events) {
        all.push(...(yield* s.advanceTo(e.at)))
        yield* e.apply.pipe(Effect.orDie)
      }
      all.push(...(yield* s.advanceTo(until)))
      return { all, probe: (yield* s.probe("svc")).state as Probe }
    }))
