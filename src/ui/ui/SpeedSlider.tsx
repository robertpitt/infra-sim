import { useEffect, useRef, useState } from "react"
import type { KeyboardEvent, PointerEvent } from "react"
import { clamp } from "../lib/format.ts"
import { client } from "../state/engine.ts"

const MIN = 0.1
const MAX = 100
/** Where the arrow keys stop, and what a drag snaps to when it passes close by. */
const STOPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100]
const TICKS = [1, 10]
/** How close (as a share of the track) a drag must come to a stop to land on it. */
const SNAP = 0.03

// The track is logarithmic: 0.1× to 1× takes as much room as 10× to 100×.
const toPos = (speed: number): number => clamp((Math.log(speed) - Math.log(MIN)) / (Math.log(MAX) - Math.log(MIN)), 0, 1)
const fromPos = (pos: number): number => MIN * (MAX / MIN) ** clamp(pos, 0, 1)

/** Two significant figures is as fine as anyone can tell speeds apart. */
const round = (speed: number): number => {
  const step = speed < 1 ? 0.01 : speed < 10 ? 0.1 : 1
  return Math.round(speed / step) * step
}

const snap = (pos: number): number => {
  const near = STOPS.find((s) => Math.abs(toPos(s) - pos) < SNAP)
  return near ?? round(fromPos(pos))
}

export const fmtSpeed = (speed: number): string =>
  `${speed < 1 ? speed.toFixed(2).replace(/0$/, "") : speed < 10 ? String(Math.round(speed * 10) / 10) : Math.round(speed)}×`

interface Props {
  /** The speed the engine was asked for. */
  readonly speed: number
  /** The speed it manages, when it can't keep up; marked on the track. */
  readonly achieved: number | undefined
  readonly disabled?: boolean
}

/**
 * Simulation speed as a bar to drag: virtual seconds per real second, on a log scale. The engine hears about it
 * at most once a frame while dragging; arrow keys step between round speeds and a double-click goes back to 1×.
 */
export function SpeedSlider({ speed, achieved, disabled }: Props) {
  const track = useRef<HTMLDivElement>(null)
  // The dragged value shows until the engine confirms it, so the thumb doesn't jump back for a frame on release.
  const [drag, setDrag] = useState<{ readonly value: number; readonly active: boolean } | undefined>()
  const pending = useRef<number | undefined>(undefined)
  const shown = drag?.value ?? speed
  useEffect(() => {
    if (drag === undefined || drag.active) return
    if (Math.abs(drag.value - speed) < 1e-9) return setDrag(undefined)
    const timer = setTimeout(() => setDrag(undefined), 600)
    return () => clearTimeout(timer)
  }, [drag, speed])

  /** Show `next` straight away and tell the engine on the next frame; the latest choice in a frame wins. */
  const choose = (next: number, active: boolean) => {
    setDrag({ value: next, active })
    if (pending.current === undefined) {
      requestAnimationFrame(() => {
        if (pending.current !== undefined) client.send({ _tag: "setSpeed", speed: pending.current })
        pending.current = undefined
      })
    }
    pending.current = next
  }
  const at = (e: PointerEvent) => {
    const r = track.current!.getBoundingClientRect()
    return snap((e.clientX - r.left) / r.width)
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.focus()
    choose(at(e), true)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag?.active) return
    const next = at(e)
    if (next !== drag.value) choose(next, true)
  }
  const onPointerUp = () => setDrag((d) => (d === undefined ? d : { ...d, active: false }))

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const up = STOPS.find((s) => s > shown * 1.001) ?? MAX
    const down = [...STOPS].reverse().find((s) => s < shown * 0.999) ?? MIN
    const next =
      e.key === "ArrowRight" || e.key === "ArrowUp" ? up
      : e.key === "ArrowLeft" || e.key === "ArrowDown" ? down
      : e.key === "Home" ? MIN
      : e.key === "End" ? MAX
      : undefined
    if (next === undefined || disabled) return
    e.preventDefault()
    choose(next, false)
  }

  const slow = achieved !== undefined && achieved < speed * 0.85
  return (
    <div className="speed" data-slow={slow || undefined} data-dragging={drag?.active || undefined}>
      <div
        ref={track}
        className="speed-track"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Simulation speed"
        aria-valuemin={MIN}
        aria-valuemax={MAX}
        aria-valuenow={shown}
        aria-valuetext={`${fmtSpeed(shown)} real time`}
        aria-disabled={disabled || undefined}
        title={
          slow
            ? `Asked for ${fmtSpeed(speed)}, the simulation manages ${fmtSpeed(achieved!)}`
            : "Simulation speed: virtual seconds per real second. Drag, or use the arrow keys; double-click for 1×"
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => !disabled && choose(1, false)}
        onKeyDown={onKeyDown}
      >
        <span className="speed-rail" />
        <span className="speed-fill" style={{ width: `${toPos(shown) * 100}%` }} />
        {slow && <span className="speed-achieved" style={{ width: `${toPos(achieved!) * 100}%` }} />}
        {TICKS.map((t) => (
          <span key={t} className="speed-tick" style={{ left: `${toPos(t) * 100}%` }} />
        ))}
        <span className="speed-thumb" style={{ left: `${toPos(shown) * 100}%` }} />
      </div>
      <output className="speed-value">{fmtSpeed(shown)}</output>
    </div>
  )
}
