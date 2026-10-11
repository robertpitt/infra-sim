import type { ComponentManifest, NodeDoc } from "../state/types.ts"
import { memo } from "react"
import { useStore } from "../lib/store.ts"
import { run } from "../state/run.ts"
import { Icon } from "../ui/Icon.tsx"
import { GROUP_DEFAULT, GROUP_HEAD_H } from "./groups.ts"

interface Props {
  readonly id: string
  readonly spec: NodeDoc
  readonly manifest: ComponentManifest | undefined
  readonly selected: boolean
  /** The placement (`aws:us-east-1`) the box draws, so regional faults show on it. */
  readonly placement: string | undefined
  /** Short description under the name: the region, the address block. */
  readonly detail: string
  readonly level: "error" | "warning" | "info" | undefined
}

/**
 * A container on the canvas: a labelled box drawn behind the nodes inside it. Only its title bar takes pointer
 * input (to select and drag it, and what is inside moves too) and its corner (to resize), so the empty middle
 * stays part of the canvas: you can still pan, and drop things in.
 */
export const GroupView = memo(function GroupView({ id, spec, manifest, selected, placement, detail, level }: Props) {
  const down = useStore(run, (s) => s.faults.some((f) => f.target.kind === "region" && f.target.id === placement && f.fault._tag === "Outage"))
  const impaired = useStore(run, (s) => s.faults.some((f) => f.target.kind === "region" && f.target.id === placement))
  const at = spec.position ?? { x: 0, y: 0 }
  const size = spec.size ?? GROUP_DEFAULT
  return (
    <div
      className="group-box"
      data-group-id={id}
      data-selected={selected || undefined}
      data-down={down || undefined}
      style={{
        width: size.w,
        height: size.h,
        transform: `translate(${at.x}px, ${at.y}px)`,
        ["--accent" as string]: manifest?.accent ?? "#8893a5"
      }}
    >
      <div className="group-head" data-node-id={id} style={{ height: GROUP_HEAD_H }}>
        <span className="node-icon sm">
          <Icon name={manifest?.icon ?? "box"} size={14} />
        </span>
        <span className="group-title">
          <b>{spec.name ?? id}</b>
          <i>{detail}</i>
        </span>
        {impaired && (
          <span className="node-badge fault" title={down ? "Region outage injected" : "Region fault injected"}>
            <Icon name="bolt" size={12} />
          </span>
        )}
        {level !== undefined && level !== "info" && (
          <span className={`node-badge ${level}`} title="This region's quotas are exceeded: select it to see how">
            <Icon name="warn" size={12} />
          </span>
        )}
      </div>
      <span className="group-resize" data-resize-id={id} title="Drag to resize" />
    </div>
  )
})
