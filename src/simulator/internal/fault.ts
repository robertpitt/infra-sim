/**
 * What active faults add up to, for `Fault.ts`: the arithmetic the call path runs (through `Faults.forNodeUnsafe` and
 * `forEdgeUnsafe`) whenever any fault is active. Plain functions that allocate nothing unless a fault applies.
 */
import { Duration } from "effect"
import type { ActiveFault, EdgeEffect, NodeEffect } from "../Fault.ts"

/** A node with no fault reaching it. */
export const NO_NODE: NodeEffect = { outage: false, extraMs: 0, extra: Duration.zero, errorRate: 0 }

/** An edge with no fault on it. */
export const NO_EDGE: EdgeEffect = { outage: false, blackhole: false, extraMs: 0, extra: Duration.zero, lossRate: 0 }

/** The faults on one target, if any. */
type Faulted = ReadonlyArray<ActiveFault> | undefined

/** Fold one target's faults into a running total. */
const add = (effect: { outage: boolean; extraMs: number; ok: number }, faults: Faulted): void => {
  if (faults === undefined) return
  for (const { fault } of faults) {
    if (fault._tag === "Outage") effect.outage = true
    else if (fault._tag === "Slow") effect.extraMs += Duration.toMillis(fault.extra)
    else if (fault._tag === "Errors") effect.ok *= 1 - fault.rate
  }
}

/** What up to three sets of faults (a node's own, its region's, its zone's) add up to. On the call path: no allocation unless something applies. */
export const sum = (a: Faulted, b: Faulted, c: Faulted): NodeEffect => {
  if (a === undefined && b === undefined && c === undefined) return NO_NODE
  const effect = { outage: false, extraMs: 0, ok: 1 }
  add(effect, a)
  add(effect, b)
  add(effect, c)
  return { outage: effect.outage, extraMs: effect.extraMs, extra: Duration.millis(effect.extraMs), errorRate: 1 - effect.ok }
}

/** What the faults on one edge add up to. */
export const sumEdge = (faults: ReadonlyArray<ActiveFault>): EdgeEffect => {
  let outage = false
  let blackhole = false
  let extra = 0
  let ok = 1
  for (const { fault } of faults) {
    if (fault._tag === "Outage") outage = true
    else if (fault._tag === "Blackhole") blackhole = true
    else if (fault._tag === "Slow") extra += Duration.toMillis(fault.extra)
    else if (fault._tag === "Loss") ok *= 1 - fault.rate
  }
  return { outage, blackhole, extraMs: extra, extra: Duration.millis(extra), lossRate: 1 - ok }
}
