import type { NodeProps } from "@xyflow/react"
import { memo } from "react"
import { useStore } from "../lib/store.ts"
import { run } from "../state/run.ts"
import { Icon } from "../ui/Icon.tsx"
import type { ContainerNode } from "./flow.ts"
import { Gear } from "./NodeView.tsx"
import { GROUP_HEAD_H } from "./groups.ts"

/**
 * A container on the canvas: a labelled box drawn behind the wires and the nodes inside it. Only its title bar takes
 * pointer input (to select and drag it, and what is inside moves too), so the empty middle stays part of the canvas:
 * you can still pan, and drop things in. Its resize corner is drawn above everything (`BoxGrips`), where what is
 * inside the box can't cover it.
 */
export const GroupView = memo(function GroupView({ id, data, selected }: NodeProps<ContainerNode>) {
  const { spec, manifest, placement, detail, level } = data
  const down = useStore(run, (s) => s.faults.some((f) => f.target.kind === "region" && f.target.id === placement && f.fault._tag === "Outage"))
  const impaired = useStore(run, (s) => s.faults.some((f) => f.target.kind === "region" && f.target.id === placement))
  return (
    <div
      className="group-box"
      data-group-id={id}
      data-selected={selected || undefined}
      data-down={down || undefined}
      style={{ ["--accent" as string]: manifest?.accent ?? "#8893a5" }}
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
          <span className={`node-badge ${level}`} title="This region's quotas are exceeded: open its settings to see how">
            <Icon name="warn" size={12} />
          </span>
        )}
        {selected && <Gear />}
      </div>
    </div>
  )
})
