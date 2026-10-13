import type { Unit } from "../../../Protocol.ts"
import type { Settings } from "./config.ts"
import { onDemandOf } from "./spot.ts"
import type { Purchase } from "../Vcpus.ts"
import { HOUR_MS } from "../../internal/units.ts"

/**
 * Which instance scale-in terminates (`ec2-auto-scaling-termination-policies.html`). Zones come first, whatever the
 * policy ("Maintaining Zonal balance takes precedence over the termination policy"): the fleet core picks the zone with
 * the most instances and skips protected ones, then asks this which of that zone's instances (oldest first) goes.
 *
 * 1. In a group with Spot, the purchase option out of proportion goes first: if the group has more On-Demand instances
 *    than the split wants for one fewer, an On-Demand one, otherwise a Spot one ("When the size of the group decreases,
 *    Amazon EC2 Auto Scaling first identifies which of the two types (Spot or On-Demand) should be terminated").
 * 2. Then the policy:
 *    - `Default`: instances with outdated configurations first (every instance here has the group's one launch template,
 *      so none is), then the one closest to its next billing hour, ties broken by launch order (AWS: at random).
 *    - `ClosestToNextInstanceHour`: the one closest to its next billing hour.
 *    - `OldestInstance`, `NewestInstance`: by launch time.
 */

/** What the policy needs to know of an instance. */
export interface Launched {
  readonly purchase: Purchase
  /** When it was launched (virtual ms). Instances there at the start launched at 0. */
  readonly launchedAt: number
}

/** How far into its current billing hour an instance is: the further, the closer to the next one. */
const intoHour = (launchedAt: number, now: number): number => (((now - launchedAt) % HOUR_MS) + HOUR_MS) % HOUR_MS

/**
 * Pick the instance to terminate from `candidates` (one zone's serving, unprotected instances, oldest first), given
 * every live instance's purchase option.
 */
export const pick = (
  c: Settings,
  candidates: ReadonlyArray<Unit>,
  info: (unit: Unit) => Launched | undefined,
  live: { readonly onDemand: number; readonly total: number },
  now: number
): Unit | undefined => {
  if (candidates.length === 0) return undefined
  let pool = candidates
  const spotConfigured = c.spot.onDemandPercentageAboveBase < 100 && !c.warmPool.enabled
  if (spotConfigured && live.total > 0) {
    const wanted = onDemandOf(live.total - 1, c.spot.onDemandBaseCapacity, c.spot.onDemandPercentageAboveBase)
    const purchase: Purchase = live.onDemand > wanted ? "onDemand" : "spot"
    const matching = candidates.filter((u) => info(u)?.purchase === purchase)
    if (matching.length > 0) pool = matching
  }
  switch (c.terminationPolicy) {
    case "OldestInstance":
      return oldestFirst(pool, info)[0]
    case "NewestInstance": {
      const sorted = oldestFirst(pool, info)
      return sorted[sorted.length - 1]
    }
    case "Default":
    case "ClosestToNextInstanceHour": {
      let best: Unit | undefined
      let furthest = -1
      for (const u of pool) {
        const into = intoHour(info(u)?.launchedAt ?? 0, now)
        if (into > furthest) {
          furthest = into
          best = u
        }
      }
      return best
    }
  }
}

/** By launch time, oldest first; equal times keep the fleet's order (launch order). */
const oldestFirst = (units: ReadonlyArray<Unit>, info: (unit: Unit) => Launched | undefined): Array<Unit> =>
  [...units].sort((a, b) => (info(a)?.launchedAt ?? 0) - (info(b)?.launchedAt ?? 0))
