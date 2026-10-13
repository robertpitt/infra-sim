/**
 * What an Auto Scaling group (`Ec2.ts`) keeps of its instances, and the arithmetic over it: the purchase split the
 * next launch is decided by, the counts its gauges and probe show, and the phases a launch goes through.
 */
import { Duration } from "effect"
import type { Phase } from "../../../fleet/Fleet.ts"
import type { Purchase } from "../Vcpus.ts"
import type { Settings, WarmPoolState } from "./config.ts"

/** What the group knows of an instance from its launch to its termination. */
export interface Instance {
  readonly purchase: Purchase
  readonly vcpus: number
  readonly launchedAt: number
  /** How it started: there before the simulation, launched from scratch, or taken from the warm pool. */
  start: "initial" | "cold" | "warm"
  /** Let go (scale-in, replacement, interruption): no longer counted in the purchase split. */
  draining: boolean
}

const ms = (d: Duration.Duration): number => Duration.toMillis(d)

/** Live instances by purchase option, from what the group launched (draining ones don't count). */
export const split = (instances: ReadonlyMap<number, Instance>): { onDemand: number; total: number } => {
  let onDemand = 0
  let total = 0
  for (const i of instances.values()) {
    if (i.draining) continue
    total++
    if (i.purchase === "onDemand") onDemand++
  }
  return { onDemand, total }
}

/** Live instances of one purchase option (draining ones don't count). */
export const countOf = (instances: ReadonlyMap<number, Instance>, purchase: Purchase): number => {
  let n = 0
  for (const i of instances.values()) if (!i.draining && i.purchase === purchase) n++
  return n
}

/** The vCPUs of every instance the group launched, draining ones too, plus `extra` (the warm pool's). */
export const vcpusOf = (instances: ReadonlyMap<number, Instance>, extra: number): number => {
  let n = extra
  for (const i of instances.values()) n += i.vcpus
  return n
}

/** The phases a launch goes through: from scratch, or from the warm pool (which skips what was done before). */
export const launchPhases = (l: Settings["launch"], warm: WarmPoolState | undefined): ReadonlyArray<Phase> => {
  switch (warm) {
    case undefined:
      return [
        { name: "pending", ms: ms(l.pending) },
        { name: "boot", ms: ms(l.boot) },
        { name: "user data", ms: ms(l.userData) },
        { name: "application start", ms: ms(l.appStart) }
      ]
    case "Stopped":
      return [
        { name: "pending (from the warm pool)", ms: ms(l.pending) },
        { name: "boot", ms: ms(l.boot) },
        { name: "application start", ms: ms(l.appStart) }
      ]
    case "Hibernated":
      return [
        { name: "pending (from the warm pool)", ms: ms(l.pending) },
        { name: "resume from hibernation", ms: ms(l.boot) }
      ]
    case "Running":
      return []
  }
}

/** How long a launch from scratch takes, all its phases together. */
export const coldMs = (l: Settings["launch"]): number => ms(l.pending) + ms(l.boot) + ms(l.userData) + ms(l.appStart)
