/**
 * A pod's life in an EKS workload (`Eks.ts`): what each pod template revision is, the phases a pod goes through once
 * scheduled, when it passes its readiness probe, and how often a crash-looping container has been restarted.
 */
import { Duration } from "effect"
import type { Phase } from "../../../fleet/Fleet.ts"
import type { Settings } from "./config.ts"
import { BACKOFF_CAP_S, BACKOFF_FIRST_S, CONTAINER_START_MS } from "./limits.ts"

/** A phase that never ends: a pod in CrashLoopBackOff or failing its readiness probe never becomes ready. */
const NEVER_MS = 1e13

const ms = (d: Duration.Duration): number => Duration.toMillis(d)

/** What a pod template revision is, kept from the settings when it was current. */
export interface Revision {
  readonly imageSize: number
  readonly pullRate: number
  readonly appStartMs: number
  readonly failure: Settings["pod"]["failure"]
}

/** The revision the settings describe now. */
export const revisionOf = (c: Settings): Revision => ({ imageSize: c.pod.imageSize, pullRate: c.pod.pullRate, appStartMs: ms(c.pod.appStart), failure: c.pod.failure })

/** See `Eks.readyAfter`. */
export const readyAfter = (appMs: number, initialDelayMs: number, periodMs: number): number =>
  initialDelayMs + Math.max(0, Math.ceil((appMs - initialDelayMs) / periodMs)) * periodMs

/** See `Eks.restartsAfter`. */
export const restartsAfter = (ms: number): number => {
  let n = 0
  let t = 0
  let gap = BACKOFF_FIRST_S * 1000
  while (t + gap <= ms && n < 10_000) {
    t += gap
    n++
    gap = Math.min(gap * 2, BACKOFF_CAP_S * 1000)
  }
  return n
}

/** A pod's start-up once scheduled on a node: its image (`pullMs`, 0 if the node has it), the container, then readiness. */
export const phases = (rev: Revision, pullMs: number, readiness: Settings["readiness"]): ReadonlyArray<Phase> => {
  if (rev.failure !== "none") {
    return [{ name: "pulling image", ms: pullMs }, { name: "starting", ms: CONTAINER_START_MS }, { name: rev.failure === "crash" ? "CrashLoopBackOff" : "not ready", ms: NEVER_MS }]
  }
  return [
    { name: "pulling image", ms: pullMs },
    { name: "starting", ms: CONTAINER_START_MS },
    { name: "readiness", ms: readyAfter(rev.appStartMs, ms(readiness.initialDelay), Math.max(1, ms(readiness.period))) }
  ]
}
