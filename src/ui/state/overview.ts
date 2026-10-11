import type { Frame } from "./types.ts"

/**
 * The whole design at a glance, as its traffic sources see it: what they send, how much of it fails, and how long
 * answers take. Sources are where requests start, so their numbers are end to end.
 */
export interface Overview {
  /** Requests sent per second. */
  readonly rps: number
  /** Failures per second. */
  readonly fail: number
  /** Failed share of finished requests. */
  readonly errorRatio: number
  /** End-to-end latency, weighted by how many answers each source saw. Undefined until something has answered. */
  readonly p50: number | undefined
  readonly p95: number | undefined
  readonly p99: number | undefined
}

/** Totals over `frames` (rates averaged across them), or undefined when no source reported anything. */
export const overviewOf = (frames: ReadonlyArray<Frame>, sources: ReadonlyArray<string>): Overview | undefined => {
  let seen = false
  let sent = 0
  let ok = 0
  let fail = 0
  let n = 0
  let p50 = 0
  let p95 = 0
  let p99 = 0
  for (const f of frames) {
    for (const id of sources) {
      const s = f.nodes[id]
      if (s === undefined) continue
      seen = true
      sent += s.rates.sent ?? 0
      ok += s.rates.ok ?? 0
      fail += s.rates.fail ?? 0
      const d = s.dist.latency
      if (d !== undefined && d.n > 0) {
        n += d.n
        p50 += d.p50 * d.n
        p95 += d.p95 * d.n
        p99 += d.p99 * d.n
      }
    }
  }
  if (!seen) return undefined
  return {
    rps: sent / frames.length,
    fail: fail / frames.length,
    errorRatio: ok + fail > 0 ? fail / (ok + fail) : 0,
    p50: n > 0 ? p50 / n : undefined,
    p95: n > 0 ? p95 / n : undefined,
    p99: n > 0 ? p99 / n : undefined
  }
}

/** One overview per `size` frames, oldest first, ending with the newest frame: the points of a sparkline. */
export const overviewSeries = (frames: ReadonlyArray<Frame>, sources: ReadonlyArray<string>, size: number): Array<Overview | undefined> => {
  const out: Array<Overview | undefined> = []
  for (let end = frames.length; end > 0; end -= size) out.push(overviewOf(frames.slice(Math.max(0, end - size), end), sources))
  return out.reverse()
}
