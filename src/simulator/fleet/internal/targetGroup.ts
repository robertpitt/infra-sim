import { Duration } from "effect"
import type { Cancel } from "../../Edge.ts"
import type { HealthAnswer, Unit } from "../../Protocol.ts"
import type { TimerHandle } from "../../VirtualTime.ts"
import type { Health, Settings } from "../TargetGroup.ts"

/**
 * The target group's choosing, for `TargetGroup.ts`: who may get requests (the pools, by zone, rebuilt only when something
 * changed) and how one target is picked from a pool (round robin by share, least outstanding requests, by share at a point:
 * a random draw or a flow's key), with slow start's shares. Plain functions over plain objects: they run per request.
 */

/** One registered unit. */
export interface Target {
  readonly unit: Unit
  health: Health
  /** Checks passed and failed in a row. */
  passes: number
  fails: number
  /** Requests sent to it and not yet answered: least outstanding requests counts these. */
  outstanding: number
  /** When it last became healthy, for slow start. */
  healthySince: number
  /** Smooth weighted round robin's running credit. */
  credit: number
  tick: TimerHandle | undefined
  ping: Cancel | undefined
  readonly answer: () => HealthAnswer
  readonly heard: (healthy: boolean) => void
}

/** A share of requests is never quite zero in slow start, so a target at the very start of it still gets one now and then. */
const MIN_WEIGHT = 0.01
/** No target: a pool nobody may get requests from. */
export const NONE: ReadonlyArray<Target> = []

/** A target's share: 1, or less while it is in slow start (growing linearly from when it became healthy). */
const weight = (t: Target, now: number, slow: number): number => {
  if (slow <= 0 || t.health !== "healthy") return 1
  const into = now - t.healthySince
  return into >= slow ? 1 : Math.max(MIN_WEIGHT, into / slow)
}

/** Round robin by share (nginx's smooth weighted round robin): each target's turns in proportion to its weight. */
export const weightedTurn = (pool: ReadonlyArray<Target>, now: number, slow: number): Target => {
  let best = pool[0]!
  let total = 0
  for (const t of pool) {
    const w = weight(t, now, slow)
    t.credit += w
    total += w
    if (t.credit > best.credit) best = t
  }
  best.credit -= total
  return best
}

/** The fewest requests in flight for its share, looking from `start`; ties go round, so equal targets take turns. */
export const leastOutstanding = (pool: ReadonlyArray<Target>, now: number, slow: number, start: number): Target => {
  const n = pool.length
  let best = pool[start]!
  let score = Infinity
  for (let k = 0; k < n; k++) {
    const t = pool[(start + k) % n]!
    const s = slow > 0 ? (t.outstanding + 1) / weight(t, now, slow) : t.outstanding
    if (s < score) {
      score = s
      best = t
    }
  }
  return best
}

/** The target at `u` of the way along the pool, by share: a random draw, or a flow's key. */
export const byShare = (pool: ReadonlyArray<Target>, now: number, slow: number, u: number): Target => {
  if (slow <= 0) return pool[Math.min(pool.length - 1, Math.floor(u * pool.length))]!
  let total = 0
  for (const t of pool) total += weight(t, now, slow)
  let r = u * total
  for (const t of pool) {
    r -= weight(t, now, slow)
    if (r < 0) return t
  }
  return pool[pool.length - 1]!
}

/** Who may get requests now, per zone, and until when anyone is in slow start. */
export class Pools {
  /** Who may get requests now: the healthy targets (or every registered one, failing open). */
  pool: ReadonlyArray<Target> = NONE
  readonly byZone = new Map<string, Array<Target>>()
  /**
   * Per zone, who a balancer node there sends to with cross-zone off: its zone's healthy targets, or (none healthy) every
   * registered one there, as ELB's routing failover does. Only used when the balancer says where a request arrived.
   */
  readonly zonePools = new Map<string, ReadonlyArray<Target>>()
  /** The zones a request can reach the balancer in: those with targets in the pool. */
  zones: ReadonlyArray<string> = []
  /** Until when some target in the pool is in slow start. */
  rampUntil = -Infinity

  /** Rebuild from the registered targets `order` (registration order) under `c`, with the balancer's zones `enabled`. */
  build(order: ReadonlyArray<Target>, c: Settings, enabled: ReadonlyArray<string> | undefined): void {
    // Targets in a zone the balancer has no node in are registered but unused.
    const used = enabled === undefined ? order : order.filter((t) => t.unit.zone === undefined || enabled.includes(t.unit.zone))
    const healthy = used.filter((t) => t.health === "healthy")
    this.pool = healthy.length > 0 ? healthy : c.failOpen ? used.filter((t) => t.health !== "draining") : NONE
    this.byZone.clear()
    const zones: Array<string> = []
    let rampUntil = -Infinity
    const slow = Duration.toMillis(c.slowStart)
    for (const t of this.pool) {
      if (t.health === "healthy" && slow > 0) rampUntil = Math.max(rampUntil, t.healthySince + slow)
      const z = t.unit.zone
      if (z === undefined) continue
      let inZone = this.byZone.get(z)
      if (inZone === undefined) {
        this.byZone.set(z, (inZone = []))
        zones.push(z)
      }
      inZone.push(t)
    }
    this.zones = zones
    this.rampUntil = rampUntil
    for (const t of order) t.credit = 0
    // Each zone's own pool, for requests a balancer says arrived there: healthy ones, else (failing open) all registered.
    this.zonePools.clear()
    const registered = new Map<string, Array<Target>>()
    for (const t of used) {
      const z = t.unit.zone
      if (z === undefined || t.health === "draining") continue
      let inZone = registered.get(z)
      if (inZone === undefined) registered.set(z, (inZone = []))
      inZone.push(t)
    }
    for (const [z, all] of registered) {
      const well = all.filter((t) => t.health === "healthy")
      this.zonePools.set(z, well.length > 0 ? well : c.failOpen ? all : NONE)
    }
  }
}
