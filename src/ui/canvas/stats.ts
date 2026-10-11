import type { Stats } from "../state/types.ts"
import { useMemo } from "react"
import { useStore } from "../lib/store.ts"
import { run, smoothed } from "../state/run.ts"

/** Live, smoothed stats for a node or edge. Re-renders as new frames arrive. */
export const useStats = (scope: "nodes" | "edges", id: string): Stats | undefined => {
  const version = useStore(run, (s) => s.version)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the signal that history changed.
  return useMemo(() => smoothed(scope, id), [scope, id, version])
}

export type Health = "idle" | "ok" | "warn" | "bad"

/** Failure ratio of finished calls in the window. */
export const failRatio = (stats: Stats | undefined): number => {
  const ok = stats?.rates.ok ?? 0
  const fail = stats?.rates.fail ?? 0
  return ok + fail > 0 ? fail / (ok + fail) : 0
}

export const healthOf = (stats: Stats | undefined, down: boolean): Health => {
  if (down) return "bad"
  if (stats === undefined) return "idle"
  const ok = stats.rates.ok ?? 0
  const fail = stats.rates.fail ?? 0
  const traffic = ok + fail + (stats.rates.in ?? 0) + (stats.rates.sent ?? 0)
  if (traffic < 0.05) return "idle"
  const ratio = failRatio(stats)
  return ratio > 0.2 ? "bad" : ratio > 0.02 ? "warn" : "ok"
}
