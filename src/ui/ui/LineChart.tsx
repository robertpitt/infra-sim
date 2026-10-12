import { type CSSProperties, useEffect, useId, useRef, useState } from "react"
import { fmtAxis, fmtClock, fmtValue } from "../lib/format.ts"
import { useSteady } from "../lib/steady.ts"
import type { Point, Series } from "./charts.ts"

interface Props {
  readonly title: string
  readonly unit: string
  readonly series: ReadonlyArray<Series>
  readonly tMin: number
  readonly tMax: number
  readonly spans: ReadonlyArray<{ readonly from: number; readonly to: number }>
  /** The CloudWatch metrics it stands for, shown on hover of the title. */
  readonly cloudwatch?: ReadonlyArray<string>
  readonly help?: string
  readonly height?: number
}

const M = { l: 46, r: 10, t: 6, b: 20 }

/** How wide a legend's value is at most, by unit ("1.2k/s", "512 KB/s", "100%"): kept that wide so the legend never reflows. */
const VALUE_CH: Record<string, number> = { perSecond: 6, perMinute: 8, bytesPerSecond: 8, bytes: 6, ms: 7, ratio: 4, units: 5, count: 5 }

/** The next round number at or above `v`: 1, 2, 2.5, 5, 10 times a power of ten. */
const niceMax = (v: number): number => {
  if (!(v > 0)) return 1
  const exp = 10 ** Math.floor(Math.log10(v))
  const f = v / exp
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp
}

/**
 * The top of the y axis, kept steady: it grows as soon as a line would go off the top, and shrinks only once every line
 * has stayed well below it (under 40%). A scale that followed the data exactly would rescale the whole chart several
 * times a second as a value wobbled around a round number.
 */
const useScale = (dataMax: number): number => {
  const top = useRef<number | undefined>(undefined)
  const wanted = niceMax(dataMax)
  if (top.current === undefined || dataMax > top.current || dataMax < top.current * 0.4) top.current = wanted
  return top.current
}

/**
 * Whether the y axis makes room for the dashed lines (a limit, a target). Yes while the data comes anywhere near them,
 * or there is no data yet; no while it stays far below: 14 connections under a max_connections of 3,411 would be a flat
 * line along the bottom. The legend still gives the limit, marked as off the chart. Steady too: a limit left out comes
 * back once the data reaches a third of it, and goes again only below a fifth.
 */
const useLimits = (data: number, limit: number): boolean => {
  const on = useRef(true)
  if (limit <= 0 || data <= 0) on.current = true
  else if (on.current && data < limit / 5) on.current = false
  else if (!on.current && data >= limit / 3) on.current = true
  return on.current
}

const useWidth = () => {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(300)
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const observer = new ResizeObserver(([entry]) => entry && setWidth(Math.max(120, Math.floor(entry.contentRect.width))))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

export function LineChart({ title, unit, series, tMin, tMax, spans, cloudwatch, help, height = 150 }: Props) {
  const [ref, width] = useWidth()
  const clip = `clip${useId().replace(/[^a-zA-Z0-9]/g, "")}`
  const [hover, setHover] = useState<number | undefined>()
  const w = width
  const innerW = w - M.l - M.r
  const innerH = height - M.t - M.b
  let dataMax = 0
  let limitMax = 0
  for (const s of series) {
    for (const p of s.points) {
      if (p.t < tMin) continue
      if (s.dashed) limitMax = Math.max(limitMax, p.v)
      else dataMax = Math.max(dataMax, p.v)
    }
  }
  const limits = useLimits(dataMax, limitMax)
  const max = useScale(limits ? Math.max(dataMax, limitMax) : dataMax)
  // A dashed line the axis leaves out is not drawn (it would sit along the top, as if it were there).
  const drawn = series.filter((s) => limits || !s.dashed)
  const x = (t: number) => M.l + ((t - tMin) / (tMax - tMin)) * innerW
  const y = (v: number) => M.t + innerH - (Math.min(v, max) / max) * innerH
  const format = (n: number) => fmtValue(unit, n)
  const axis = (n: number) => fmtAxis(unit, n)

  const pathOf = (points: ReadonlyArray<Point>): string => {
    let d = ""
    let prev: number | undefined
    for (const p of points) {
      if (p.t < tMin) continue
      // A gap of more than a few points' worth is drawn as a gap (nothing was recorded then).
      const gap = prev !== undefined && p.t - prev > (tMax - tMin) / 40
      d += `${d === "" || gap ? "M" : "L"}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`
      prev = p.t
    }
    return d
  }

  const nearest = (points: ReadonlyArray<Point>, t: number): Point | undefined => {
    let best: Point | undefined
    for (const p of points) if (best === undefined || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p
    return best !== undefined && Math.abs(best.t - t) < (tMax - tMin) / 30 ? best : undefined
  }

  // Small integer ranges would otherwise print duplicate labels (0, 1, 1).
  const seen = new Set<string>()
  const ticks = [0, 0.5, 1].map((f) => f * max).filter((v) => !seen.has(axis(v)) && seen.add(axis(v)))
  const xTicks = [0, 1 / 3, 2 / 3, 1].map((f) => tMin + f * (tMax - tMin))
  const hoverT = hover === undefined ? undefined : tMin + ((hover - M.l) / innerW) * (tMax - tMin)
  const tip = [help, cloudwatch === undefined ? undefined : `CloudWatch: ${cloudwatch.join(", ")}`].filter(Boolean).join("\n")
  // The legend's numbers: the latest point of each line, held long enough to read.
  const latest = useSteady(
    series.map((s) => s.points[s.points.length - 1]?.v),
    series.map((s) => s.key).join()
  )

  return (
    <div className="chart" ref={ref}>
      <div className="chart-head">
        <span className="chart-title" title={tip || undefined}>
          {title}
        </span>
        <span className="legend" style={{ "--value-w": `${VALUE_CH[unit] ?? 6}ch` } as CSSProperties}>
          {series.map((s, i) => {
            const last = latest[i]
            return (
              <span
                key={s.key}
                className="legend-item"
                data-dashed={s.dashed || undefined}
                data-off={(s.dashed && !limits) || undefined}
                title={s.dashed && !limits ? "Above the chart: the axis is scaled to the data, far below it" : undefined}
              >
                <i style={{ background: s.color, color: s.color }} />
                {s.label}
                <b>{last === undefined ? "—" : format(last)}</b>
              </span>
            )
          })}
        </span>
      </div>
      <svg
        width={w}
        height={height}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          const px = e.clientX - rect.left
          setHover(px >= M.l && px <= w - M.r ? px : undefined)
        }}
        onPointerLeave={() => setHover(undefined)}
      >
        <defs>
          <clipPath id={clip}>
            <rect x={M.l} y={M.t - 2} width={innerW} height={innerH + 4} />
          </clipPath>
        </defs>
        {spans.map((s, i) => {
          const a = Math.max(x(s.from), M.l)
          const b = Math.min(x(s.to), w - M.r)
          return b > a ? <rect key={i} className="fault-band" x={a} y={M.t} width={b - a} height={innerH} /> : null
        })}
        {ticks.map((v) => (
          <g key={v}>
            <line className="grid" x1={M.l} x2={w - M.r} y1={y(v)} y2={y(v)} />
            <text className="axis" x={M.l - 6} y={y(v) + 3.5} textAnchor="end">
              {axis(v)}
            </text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text key={i} className="axis" x={x(t)} y={height - 5} textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}>
            {fmtClock(Math.max(0, t)).replace(/\.\d$/, "")}
          </text>
        ))}
        <g clipPath={`url(#${clip})`}>
          {/* Dashed lines (limits, targets) last: a line at the same value shows through their gaps. */}
          {[...drawn.filter((s) => !s.dashed), ...drawn.filter((s) => s.dashed)].map((s) => (
            <path key={s.key} className="line" d={pathOf(s.points)} stroke={s.color} strokeDasharray={s.dashed ? "4 3" : undefined} />
          ))}
        </g>
        {hoverT !== undefined && hover !== undefined && (
          <g>
            <line className="cursor" x1={hover} x2={hover} y1={M.t} y2={M.t + innerH} />
            {drawn.map((s) => {
              const p = nearest(s.points, hoverT)
              return p === undefined ? null : <circle key={s.key} cx={x(p.t)} cy={y(p.v)} r="3" fill={s.color} />
            })}
          </g>
        )}
      </svg>
      {hoverT !== undefined && hover !== undefined && (
        <div className="tooltip" style={{ left: Math.min(hover + 10, w - 170), top: 26 }}>
          <div className="tooltip-time">{fmtClock(hoverT)}</div>
          {series.map((s) => {
            const p = nearest(s.points, hoverT)
            return (
              <div key={s.key}>
                <i style={{ background: s.color }} /> {s.label} <b>{p === undefined ? "—" : format(p.v)}</b>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
