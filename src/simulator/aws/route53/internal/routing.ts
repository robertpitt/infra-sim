import type { Source } from "../../../Distribution.ts"
import type { Location, Policy } from "./config.ts"
import { NONE } from "./resolvers.ts"

/**
 * The records of one name and type as a query sees them: index i is the edge at position i on the `out` port. Plain
 * arrays updated in place, so answering a query allocates nothing.
 */
export interface Records {
  /** How many records take part: AWS caps a group of records with one name and type. */
  n: number
  readonly weight: Array<number>
  readonly secondary: Array<boolean>
  readonly location: Array<Location>
  /** The network latency from the callers to the endpoint, one way. */
  readonly latencyMs: Array<number>
  /** Whether Route 53 may answer with it: always true for a record without a health check. */
  readonly healthy: Array<boolean>
}

type Filter = (t: Records, i: number) => boolean
const any: Filter = () => true
const healthy: Filter = (t, i) => t.healthy[i]!
const healthyUnweighted: Filter = (t, i) => t.healthy[i]! && t.weight[i]! <= 0
const primary: Filter = (t, i) => !t.secondary[i]!
const secondary: Filter = (t, i) => t.secondary[i]!
const healthyPrimary: Filter = (t, i) => !t.secondary[i]! && t.healthy[i]!
const healthySecondary: Filter = (t, i) => t.secondary[i]! && t.healthy[i]!

/** One of the records `ok` allows, in proportion to its weight; `NONE` when none of them has a weight above 0. */
const byWeight = (t: Records, random: Source, ok: Filter): number => {
  let total = 0
  for (let i = 0; i < t.n; i++) if (t.weight[i]! > 0 && ok(t, i)) total += t.weight[i]!
  if (total <= 0) return NONE
  let r = random.nextDoubleUnsafe() * total
  let last = NONE
  for (let i = 0; i < t.n; i++) {
    if (!(t.weight[i]! > 0) || !ok(t, i)) continue
    last = i
    r -= t.weight[i]!
    if (r < 0) return i
  }
  return last
}

/** One of the records `ok` allows, each as likely as the next; `NONE` when it allows none. */
const evenly = (t: Records, random: Source, ok: Filter): number => {
  let count = 0
  for (let i = 0; i < t.n; i++) if (ok(t, i)) count++
  if (count === 0) return NONE
  let k = Math.floor(random.nextDoubleUnsafe() * count)
  for (let i = 0; i < t.n; i++) {
    if (!ok(t, i)) continue
    if (k-- === 0) return i
  }
  return NONE
}

/** By weight where there are weights, otherwise evenly: how several records of one failover role share the traffic. */
const shared = (t: Records, random: Source, ok: Filter): number => {
  const i = byWeight(t, random, ok)
  return i !== NONE ? i : evenly(t, random, ok)
}

/**
 * Weighted routing with health checks, as AWS documents it: the healthy records with a weight, by weight; if every
 * record with a weight is unhealthy, the healthy zero-weight records; and when no record is healthy, all of them are
 * treated as healthy. All weights zero is an even split.
 */
const weighted = (t: Records, random: Source): number => {
  let i = byWeight(t, random, healthy)
  if (i !== NONE) return i
  i = evenly(t, random, healthyUnweighted)
  if (i !== NONE) return i
  i = byWeight(t, random, any)
  return i !== NONE ? i : evenly(t, random, any)
}

/**
 * Failover: the primary while it is healthy; the secondary while the primary is unhealthy and the secondary is not;
 * and the primary when both are unhealthy ("regardless of the health of the primary"). A secondary without a health
 * check counts as healthy, so it is answered whenever the primary is down. AWS has one record of each role; several
 * share their role's traffic by weight. With no primary at all, the secondaries are the group.
 */
const failover = (t: Records, random: Source): number => {
  let i = shared(t, random, healthyPrimary)
  if (i !== NONE) return i
  i = shared(t, random, healthySecondary)
  if (i !== NONE) return i
  i = shared(t, random, primary)
  return i !== NONE ? i : shared(t, random, secondary)
}

/** The healthy record with the lowest latency to the callers (the first of equals); all records if none is healthy. */
const latency = (t: Records): number => {
  let best = NONE
  for (let i = 0; i < t.n; i++) if (t.healthy[i]! && (best === NONE || t.latencyMs[i]! < t.latencyMs[best]!)) best = i
  if (best !== NONE) return best
  for (let i = 0; i < t.n; i++) if (best === NONE || t.latencyMs[i]! < t.latencyMs[best]!) best = i
  return best
}

/**
 * Geolocation: the record for the callers' continent, or the default record. An unhealthy one falls back to the larger
 * region (here, the default); when every applicable record is unhealthy, the smallest region's record answers; when
 * none applies, there is no answer.
 */
const geolocation = (t: Records, continent: Location | undefined): number => {
  let own = NONE
  let fallback = NONE
  for (let i = 0; i < t.n; i++) {
    const at = t.location[i]
    if (own === NONE && continent !== undefined && at === continent) own = i
    else if (fallback === NONE && at === "default") fallback = i
  }
  if (own !== NONE && t.healthy[own]!) return own
  if (fallback !== NONE && t.healthy[fallback]!) return fallback
  return own !== NONE ? own : fallback
}

/**
 * The record Route 53 answers one query with, or `NONE` for no answer. Simple routing returns all its values in random
 * order and the client takes one, which is one at random; it has no health checks.
 */
export const choose = (policy: Policy, t: Records, random: Source, continent: Location | undefined): number => {
  if (t.n === 0) return NONE
  switch (policy) {
    case "simple":
      return evenly(t, random, any)
    case "weighted":
      return weighted(t, random)
    case "failover":
      return failover(t, random)
    case "latency":
      return latency(t)
    case "geolocation":
      return geolocation(t, continent)
  }
}
