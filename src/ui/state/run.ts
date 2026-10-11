import type { ActiveFault, Alert, Diagnostic, Frame, ScenarioProgress, Stats, Status, Target } from "./types.ts"
import { createStore } from "../lib/store.ts"
import { Ring } from "../lib/ring.ts"
import { client } from "./engine.ts"

/** Frames kept for charts: 10 minutes of virtual time at 250ms per frame. */
export const history = new Ring<Frame>(2400)

export interface FaultSpan {
  readonly id: string
  readonly target: Target
  readonly kind: string
  readonly from: number
  /** Undefined while the fault is still active. */
  readonly to: number | undefined
}

export interface RunState {
  readonly status: Status | undefined
  /** Bumped (at most ~15x/s) whenever new frames arrive, so views can re-read `history`. */
  readonly version: number
  readonly faults: ReadonlyArray<ActiveFault>
  readonly spans: ReadonlyArray<FaultSpan>
  readonly diagnostics: ReadonlyArray<Diagnostic>
  /** The alarms watching the run: firing ones first, then recently resolved. */
  readonly alerts: ReadonlyArray<Alert>
  /** The scenario being played, if one is. */
  readonly scenario: ScenarioProgress | undefined
  /** Most recent refused command, shown briefly. */
  readonly notice: string | undefined
}

export const run = createStore<RunState>({
  status: undefined,
  version: 0,
  faults: [],
  spans: [],
  diagnostics: [],
  alerts: [],
  scenario: undefined,
  notice: undefined
})

/**
 * How often the screen is told that data changed. The engine may produce frames far faster than anyone can read them
 * (a fast simulation makes hundreds a second), so frames are stored as they arrive, which is cheap, and React hears
 * about them on this cadence only: every number, chart and edge redraws a few times a second, however fast the run.
 */
export const RENDER_MS = 60

let bumpTimer: ReturnType<typeof setTimeout> | undefined
let pendingStatus: Status | undefined

const tick = () => {
  bumpTimer = undefined
  // A hidden tab has nobody looking: keep the history, skip the rendering, and catch up when it is shown again.
  if (document.hidden) return
  run.set((s) => ({ ...s, version: s.version + 1, ...(pendingStatus === undefined ? {} : { status: pendingStatus }) }))
  pendingStatus = undefined
}
const bump = () => {
  if (bumpTimer === undefined) bumpTimer = setTimeout(tick, RENDER_MS)
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) bump()
})

let noticeTimer: ReturnType<typeof setTimeout> | undefined

client.subscribe((event) => {
  switch (event._tag) {
    case "reset":
      history.clear()
      run.set((s) => ({ ...s, spans: [], version: s.version + 1 }))
      return
    case "frames":
      for (const frame of event.frames) history.push(frame)
      bump()
      return
    case "status": {
      // A change of phase, speed or seed (play, pause, an error) shows at once; the clock merely ticking waits for the next render.
      const current = run.get().status
      const next = event.status
      if (current === undefined || current.phase !== next.phase || current.speed !== next.speed || current.seed !== next.seed) {
        pendingStatus = undefined
        run.set((s) => ({ ...s, status: next }))
      } else {
        pendingStatus = next
        bump()
      }
      return
    }
    case "diagnostics":
      run.set((s) => ({ ...s, diagnostics: event.diagnostics }))
      return
    case "alerts":
      run.set((s) => ({ ...s, alerts: event.alerts }))
      return
    case "scenario":
      run.set((s) => ({ ...s, scenario: event.progress }))
      return
    case "faults": {
      const now = history.last()?.t ?? run.get().status?.t ?? 0
      run.set((s) => {
        const active = new Set(event.faults.map((f) => f.id))
        const known = new Set(s.spans.map((span) => span.id))
        const spans = s.spans.map((span) => (span.to === undefined && !active.has(span.id) ? { ...span, to: now } : span))
        for (const f of event.faults) {
          if (!known.has(f.id)) spans.push({ id: f.id, target: f.target, kind: f.fault._tag, from: f.startedAt, to: undefined })
        }
        return { ...s, faults: event.faults, spans }
      })
      return
    }
    case "rejected":
      run.set((s) => ({ ...s, notice: `${event.command}: ${event.issues.join(" ")}` }))
      clearTimeout(noticeTimer)
      noticeTimer = setTimeout(() => run.set((s) => ({ ...s, notice: undefined })), 5000)
  }
})

// ---------------------------------------------------------------------------------------------------------
// Reading history
// ---------------------------------------------------------------------------------------------------------

/** Frames averaged for on-canvas numbers: one second of virtual time smooths out per-window noise. */
const SMOOTHING_FRAMES = 4

const EMPTY: Stats = { rates: {}, gauges: {}, dist: {} }

/** Rates averaged over the last second, gauges from the latest frame, distributions weighted by sample count. */
export const smoothed = (scope: "nodes" | "edges" | "controllers", id: string): Stats | undefined => {
  const frames = history.tail(SMOOTHING_FRAMES)
  const stats = frames.flatMap((f) => {
    const s = f[scope]?.[id]
    return s === undefined ? [] : [s]
  })
  const latest = stats[stats.length - 1]
  if (latest === undefined) return undefined
  const rates: Record<string, number> = {}
  for (const s of stats) for (const [k, v] of Object.entries(s.rates)) rates[k] = (rates[k] ?? 0) + v / stats.length
  const dist: Record<string, Stats["dist"][string]> = {}
  for (const key of new Set(stats.flatMap((s) => Object.keys(s.dist)))) {
    const withKey = stats.flatMap((s) => (s.dist[key] === undefined ? [] : [s.dist[key]!]))
    const n = withKey.reduce((sum, d) => sum + d.n, 0)
    const weighted = (pick: (d: Stats["dist"][string]) => number) => withKey.reduce((sum, d) => sum + pick(d) * d.n, 0) / n
    dist[key] = {
      n,
      mean: weighted((d) => d.mean),
      p50: weighted((d) => d.p50),
      p95: weighted((d) => d.p95),
      p99: weighted((d) => d.p99),
      max: Math.max(...withKey.map((d) => d.max))
    }
  }
  return { rates, gauges: latest.gauges, dist }
}

export const noStats = EMPTY
