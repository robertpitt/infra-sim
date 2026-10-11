import { type ReactNode, useState } from "react"
import { useStore } from "../lib/store.ts"
import { run } from "../state/run.ts"
import { Icon } from "./Icon.tsx"

/** Pieces of a panel, shared by the sidebar and the settings dialog: a section that folds, and the design checks. */

export function Section({ title, children, aside, open: initial = true }: { title: ReactNode; children: ReactNode; aside?: ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(initial)
  return (
    <section className="panel-section" data-open={open || undefined}>
      <h3>
        <button className="section-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Icon name="chevronDown" size={12} />
          {title}
        </button>
        {aside}
      </h3>
      {open && children}
    </section>
  )
}

export const Diagnostics = ({ node, edge, controller }: { node?: string; edge?: string; controller?: string }) => {
  const all = useStore(run, (s) => s.diagnostics)
  // A controller's problems name its node too; they are shown with the controller.
  const mine = all.filter((d) =>
    controller !== undefined ? d.controller === controller : node !== undefined ? d.node === node && d.controller === undefined : edge !== undefined ? d.edge === edge : true
  )
  if (mine.length === 0) return null
  return (
    <ul className="diagnostics">
      {mine.map((d, i) => (
        <li key={`${d.code}-${i}`} data-level={d.level}>
          <Icon name={d.level === "info" ? "info" : "warn"} size={14} />
          <span>{d.message}</span>
        </li>
      ))}
    </ul>
  )
}
