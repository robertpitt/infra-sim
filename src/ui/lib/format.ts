export const fmtRate = (n: number): string => {
  if (!Number.isFinite(n)) return "—"
  if (n >= 10_000) return `${(n / 1000).toFixed(0)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  if (n >= 100) return n.toFixed(0)
  if (n >= 10) return n.toFixed(0)
  if (n >= 0.1) return n.toFixed(1)
  return n === 0 ? "0" : "<0.1"
}

export const fmtCount = (n: number): string => {
  if (!Number.isFinite(n)) return "—"
  if (n >= 100_000) return `${(n / 1000).toFixed(0)}k`
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`
  return Math.round(n).toLocaleString("en-US")
}

export const fmtMs = (ms: number): string => {
  if (!Number.isFinite(ms)) return "—"
  if (ms < 1) return "<1 ms"
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`
}

export const fmtPct = (fraction: number): string => {
  if (!Number.isFinite(fraction)) return "—"
  const p = fraction * 100
  if (p === 0) return "0%"
  if (p < 1) return `${p.toFixed(1)}%`
  return `${p.toFixed(0)}%`
}

/** Virtual time as m:ss.t */
export const fmtClock = (ms: number): string => {
  const total = Math.max(0, ms)
  const minutes = Math.floor(total / 60_000)
  const seconds = (total % 60_000) / 1000
  return `${String(minutes).padStart(2, "0")}:${seconds.toFixed(1).padStart(4, "0")}`
}

export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

/** Virtual time as m:ss, for points on a timeline. */
export const fmtTime = (ms: number): string => {
  const total = Math.round(Math.max(0, ms) / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

/** A measured value in the unit the engine says it has. */
export const fmtUnit = (unit: string, value: number): string =>
  unit === "ratio" ? fmtPct(value) : unit === "ms" ? fmtMs(value) : unit === "rate" ? `${fmtRate(value)}/s` : fmtCount(value)
