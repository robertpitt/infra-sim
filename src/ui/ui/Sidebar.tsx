import { examples } from "#examples"
import { Fragment, useMemo, useState } from "react"
import { PALETTE_MIME } from "../canvas/Canvas.tsx"
import { NODE_W, nodeHeight } from "../canvas/geometry.ts"
import { GROUP_DEFAULT, isContainer } from "../canvas/groups.ts"
import { freeSpot } from "../canvas/placement.ts"
import * as viewport from "../canvas/viewport.ts"
import { useStore } from "../lib/store.ts"
import { addNode, doc, setDesignName, setSeed } from "../state/document.ts"
import { catalog } from "../state/engine.ts"
import { openExample } from "../state/files.ts"
import { run } from "../state/run.ts"
import type { ComponentManifest } from "../state/types.ts"
import { Icon } from "./Icon.tsx"
import { Diagnostics, Section } from "./Panel.tsx"

/**
 * The sidebar: the components to drag onto the canvas, the examples, and the design's own name and checks. What is
 * selected is configured in the settings dialog (the gear on it, or a double-click), so the sidebar stays a picker.
 */
export function Sidebar() {
  return (
    <aside className="sidebar">
      <Picker />
    </aside>
  )
}

// ---------------------------------------------------------------------------------------------------------
// Nothing selected: pick a component
// ---------------------------------------------------------------------------------------------------------

const addAtCentre = (m: ComponentManifest) => {
  const c = viewport.centre()
  if (isContainer(m)) return void addNode(m.type, { x: Math.round(c.x - GROUP_DEFAULT.w / 2), y: Math.round(c.y - GROUP_DEFAULT.h / 2) })
  const spot = freeSpot(doc.get().design, catalog.get().byType, m.type, { x: Math.round(c.x - NODE_W / 2), y: Math.round(c.y - nodeHeight(m) / 2) })
  addNode(m.type, { x: Math.round(spot.x), y: Math.round(spot.y) })
}

/** Past this many components a provider's tiles are grouped by category. */
const GROUP_ABOVE = 10
const CATEGORY_ORDER: ReadonlyArray<ComponentManifest["category"]> = ["network", "compute", "messaging", "storage", "traffic", "external", "other"]
const CATEGORY_LABEL: Record<ComponentManifest["category"], string> = {
  network: "Network and edge",
  compute: "Compute",
  messaging: "Integration and streaming",
  storage: "Data",
  traffic: "Traffic",
  external: "Outside services",
  other: "Other"
}

function Picker() {
  const manifests = useStore(catalog, (s) => s.list)
  const providers = useStore(catalog, (s) => s.providers)
  const design = useStore(doc, (s) => s.design)
  const diagnostics = useStore(run, (s) => s.diagnostics)
  const status = useStore(run, (s) => s.status)
  const [query, setQuery] = useState("")
  const nodes = Object.keys(design.nodes).length
  const edges = Object.keys(design.edges).length
  const problems = diagnostics.filter((d) => d.level !== "info").length

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matches = (m: ComponentManifest) =>
      q === "" || [m.title, m.service, m.description, m.provider, m.category].some((t) => t.toLowerCase().includes(q))
    return providers
      .map((p) => {
        // Boundaries first, then the rest in the order the provider lists them.
        const items = manifests.filter((m) => m.provider === p.id && matches(m)).sort((a, b) => Number(isContainer(b)) - Number(isContainer(a)))
        // A provider with many components is easier to scan by what they do.
        const groups = items.length <= GROUP_ABOVE
          ? [{ label: undefined, items }]
          : CATEGORY_ORDER.map((c) => ({ label: CATEGORY_LABEL[c], items: items.filter((m) => m.category === c) })).filter((g) => g.items.length > 0)
        return { provider: p, items, groups }
      })
      .filter((s) => s.items.length > 0)
  }, [manifests, providers, query])

  return (
    <>
      <header className="side-head">
        <input
          className="title-input"
          value={design.name ?? ""}
          placeholder="Untitled design"
          onChange={(e) => setDesignName(e.target.value)}
          aria-label="Design name"
        />
        <span className="muted small">
          {nodes} component{nodes === 1 ? "" : "s"} · {edges} connection{edges === 1 ? "" : "s"}
          {problems > 0 && <b className="problems"> · {problems} issue{problems === 1 ? "" : "s"}</b>}
        </span>
        <label className="search">
          <Icon name="search" size={13} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search components" aria-label="Search components" />
        </label>
      </header>
      <div className="side-scroll">
        {sections.map(({ provider, groups }) => (
          <section key={provider.id} className="picker-group">
            <h4>{provider.title}</h4>
            {groups.map((group) => (
            <Fragment key={group.label ?? "all"}>
            {group.label !== undefined && <h5>{group.label}</h5>}
            <div className="tiles">
              {group.items.map((m) => (
                <button
                  key={m.type}
                  className="tile"
                  draggable
                  data-container={isContainer(m) || undefined}
                  style={{ ["--accent" as string]: m.accent }}
                  title={`${m.title}: ${m.description}`}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(PALETTE_MIME, m.type)
                    e.dataTransfer.effectAllowed = "copy"
                  }}
                  onClick={() => addAtCentre(m)}
                >
                  <span className="node-icon sm">
                    <Icon name={m.icon} size={14} />
                  </span>
                  <span className="tile-text">
                    <b>{m.title}</b>
                    {m.service !== m.title && <small>{m.service}</small>}
                  </span>
                </button>
              ))}
            </div>
            </Fragment>
            ))}
          </section>
        ))}
        {sections.length === 0 && <p className="muted small pad">Nothing matches “{query}”.</p>}

        <Section title="Examples" open={false}>
          <div className="examples">
            {examples.map((e) => (
              <button key={e.id} className="example" onClick={() => openExample(e)} title={e.blurb}>
                <b>{e.title}</b>
                <small>{e.blurb}</small>
              </button>
            ))}
          </div>
        </Section>

        <Section title="Design" open={false}>
          <div className="field row">
            <span className="field-lead">
              <label className="field-label">Seed</label>
              <span className="hint" title="The same design and seed always play out identically. Change it for a different random run.">
                <Icon name="info" size={11} />
              </span>
            </span>
            <div className="number-box">
              <input
                type="text"
                inputMode="numeric"
                defaultValue={String(status?.seed ?? design.seed ?? 1)}
                key={design.seed ?? 1}
                aria-label="Seed"
                onBlur={(e) => {
                  const n = Number(e.target.value)
                  if (Number.isInteger(n) && n !== (design.seed ?? 1)) setSeed(n)
                }}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              />
            </div>
          </div>
          <ul className="tips">
            <li>Drag a component in, then drag from its right-hand dot to connect it.</li>
            <li>Drop components inside a Region to run them there; a region's box holds its account quotas.</li>
            <li><kbd>Space</kbd> play/pause · <kbd>Del</kbd> delete · <kbd>⌘Z</kbd> undo · <kbd>F</kbd> fit</li>
          </ul>
        </Section>

        {diagnostics.length > 0 && (
          <Section title={`Checks (${diagnostics.length})`}>
            <Diagnostics />
          </Section>
        )}
      </div>
    </>
  )
}
