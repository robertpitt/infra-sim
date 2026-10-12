export const fmtRate = (n: number): string => {
  if (!Number.isFinite(n)) return "—"
  if (n >= 999_500) return fmtMillions(n)
  if (n >= 9_950) return `${(n / 1000).toFixed(0)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  if (n >= 100) return n.toFixed(0)
  if (n >= 10) return n.toFixed(0)
  if (n >= 0.1) return n.toFixed(1)
  return n === 0 ? "0" : "<0.1"
}

/** A million or more: 1.2M, 20M, 3.4B. */
const fmtMillions = (n: number): string => {
  const [v, suffix] = n >= 999_500_000 ? [n / 1e9, "B"] : [n / 1e6, "M"]
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}${suffix}`
}

export const fmtCount = (n: number): string => {
  if (!Number.isFinite(n)) return "—"
  if (n >= 999_500) return fmtMillions(n)
  if (n >= 99_950) return `${(n / 1000).toFixed(0)}k`
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

/** A size in bytes, in binary units: 512 B, 4.0 KB, 12 MB. */
export const fmtBytes = (n: number): string => {
  if (!Number.isFinite(n)) return "—"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let v = Math.max(0, n)
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${i === 0 || v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`
}

/** A dashboard value in its unit (see the engine's `Dashboard.Unit`). */
export const fmtValue = (unit: string, n: number): string => {
  switch (unit) {
    case "perSecond":
      return `${fmtRate(n)}/s`
    case "perMinute":
      return `${fmtRate(n)}/min`
    case "bytesPerSecond":
      return `${fmtBytes(n)}/s`
    case "bytes":
      return fmtBytes(n)
    case "ms":
      return fmtMs(n)
    case "ratio":
      return fmtPct(n)
    case "units":
      return fmtRate(n)
    default:
      return fmtCount(n)
  }
}

/** The same, shorter, for a chart's axis: the unit is in the chart's legend already, and round ticks need no ".0" (20k, 2 KB). */
export const fmtAxis = (unit: string, n: number): string =>
  (n === 0
    ? "0"
    : unit === "perSecond" || unit === "perMinute" || unit === "units"
      ? fmtRate(n)
      : unit === "bytesPerSecond"
        ? fmtBytes(n)
        : fmtValue(unit, n)
  ).replace(/\.0(?=\D|$)/, "")
