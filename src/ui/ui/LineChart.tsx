import { useEffect, useRef, useState } from "react"
import { fmtClock } from "../lib/format.ts"
import type { Point, Series } from "./charts.ts"

interface Props {
  readonly title: string
  readonly series: ReadonlyArray<Series>
  readonly tMin: number
  readonly tMax: number
  readonly spans: ReadonlyArray<{ readonly from: number; readonly to: number }>
  readonly format: (n: number) => string
  readonly height?: number
}

const M = { l: 46, r: 10, t: 6, b: 20 }

const niceMax = (v: number): number => {
  if (!(v > 0)) return 1
  const exp = 10 ** Math.floor(Math.log10(v))
  const f = v / exp
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp
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

export function LineChart({ title, series, tMin, tMax, spans, format, height = 150 }: Props) {
  const [ref, width] = useWidth()
  const [hover, setHover] = useState<number | undefined>()
  const w = width
  const innerW = w - M.l - M.r
  const innerH = height - M.t - M.b
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.points.map((p) => p.v))))
  const x = (t: number) => M.l + ((t - tMin) / (tMax - tMin)) * innerW
  const y = (v: number) => M.t + innerH - (Math.min(v, max) / max) * innerH

  const pathOf = (points: ReadonlyArray<Point>): string => {
    let d = ""
    let prev: number | undefined
    for (const p of points) {
      const gap = prev !== undefined && p.t - prev > 2500
      d += `${d === "" || gap ? "M" : "L"}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`
      prev = p.t
    }
    return d
  }

  const nearest = (points: ReadonlyArray<Point>, t: number): Point | undefined => {
    let best: Point | undefined
    for (const p of points) if (best === undefined || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p
    return best !== undefined && Math.abs(best.t - t) < 2000 ? best : undefined
  }

  // Small integer ranges would otherwise print duplicate labels (0, 1, 1).
  const seen = new Set<string>()
  const ticks = [0, 0.5, 1].map((f) => f * max).filter((v) => !seen.has(format(v)) && seen.add(format(v)))
  const xTicks = [0, 1 / 3, 2 / 3, 1].map((f) => tMin + f * (tMax - tMin))
  const hoverT = hover === undefined ? undefined : tMin + ((hover - M.l) / innerW) * (tMax - tMin)

  return (
    <div className="chart" ref={ref}>
      <div className="chart-head">
        <span className="chart-title">{title}</span>
        <span className="legend">
          {series.map((s) => {
            const last = s.points[s.points.length - 1]
            return (
              <span key={s.key} className="legend-item">
                <i style={{ background: s.color }} />
                {s.label}
                {last !== undefined && <b>{format(last.v)}</b>}
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
        {spans.map((s, i) => {
          const a = Math.max(x(s.from), M.l)
          const b = Math.min(x(s.to), w - M.r)
          return b > a ? <rect key={i} className="fault-band" x={a} y={M.t} width={b - a} height={innerH} /> : null
        })}
        {ticks.map((v) => (
          <g key={v}>
            <line className="grid" x1={M.l} x2={w - M.r} y1={y(v)} y2={y(v)} />
            <text className="axis" x={M.l - 6} y={y(v) + 3.5} textAnchor="end">
              {format(v)}
            </text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text key={i} className="axis" x={x(t)} y={height - 5} textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}>
            {fmtClock(t).replace(/\.\d$/, "")}
          </text>
        ))}
        {series.map((s) => (
          <path key={s.key} className="line" d={pathOf(s.points)} stroke={s.color} strokeDasharray={s.dashed ? "4 3" : undefined} />
        ))}
        {hoverT !== undefined && hover !== undefined && (
          <g>
            <line className="cursor" x1={hover} x2={hover} y1={M.t} y2={M.t + innerH} />
            {series.map((s) => {
              const p = nearest(s.points, hoverT)
              return p === undefined ? null : <circle key={s.key} cx={x(p.t)} cy={y(p.v)} r="3" fill={s.color} />
            })}
          </g>
        )}
      </svg>
      {hoverT !== undefined && hover !== undefined && (
        <div className="tooltip" style={{ left: Math.min(hover + 10, w - 150), top: 26 }}>
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
