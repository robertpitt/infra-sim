import { examples } from "#examples"
import { Design } from "#simulator"
import { type ReactNode, useMemo, useState } from "react"
import { PALETTE_MIME } from "../canvas/Canvas.tsx"
import { NODE_W, nodeHeight } from "../canvas/geometry.ts"
import { GROUP_DEFAULT, isContainer, regionOf } from "../canvas/groups.ts"
import { freeSpot } from "../canvas/placement.ts"
import { useStats } from "../canvas/stats.ts"
import * as viewport from "../canvas/viewport.ts"
import { useStore } from "../lib/store.ts"
import {
  addNode,
  doc,
  removeSelection,
  renameNode,
  resetAccount,
  resetNodeSettings,
  select,
  setAccountSetting,
  setDesignName,
  setEdgeSetting,
  setNodeRegion,
  setNodeSetting,
  setSeed
} from "../state/document.ts"
import { accountFields, catalog, registry } from "../state/engine.ts"
import { openExample } from "../state/files.ts"
import { run } from "../state/run.ts"
import type { ComponentManifest } from "../state/types.ts"
import { FaultPanel } from "./FaultPanel.tsx"
import { Icon } from "./Icon.tsx"
import { Metrics } from "./Metrics.tsx"
import { SettingsForm } from "./SettingsForm.tsx"

/**
 * The one sidebar. With nothing selected it is the component picker (a condensed one); select a node, a
 * container or a connection on the canvas and it becomes that thing's settings.
 */
export function Sidebar() {
  const selection = useStore(doc, (s) => s.selection)
  return (
    <aside className="sidebar">
      {selection === undefined ? <Picker /> : selection.kind === "node" ? <NodePanel id={selection.id} /> : <EdgePanel id={selection.id} />}
    </aside>
  )
}

// ---------------------------------------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------------------------------------

function Section({ title, children, aside, open: initial = true }: { title: ReactNode; children: ReactNode; aside?: ReactNode; open?: boolean }) {
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

const Diagnostics = ({ node, edge }: { node?: string; edge?: string }) => {
  const all = useStore(run, (s) => s.diagnostics)
  const mine = all.filter((d) => (node !== undefined ? d.node === node : edge !== undefined ? d.edge === edge : true))
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

// ---------------------------------------------------------------------------------------------------------
// Nothing selected: pick a component
// ---------------------------------------------------------------------------------------------------------

const addAtCentre = (m: ComponentManifest) => {
  const c = viewport.centre()
  if (isContainer(m)) return void addNode(m.type, { x: Math.round(c.x - GROUP_DEFAULT.w / 2), y: Math.round(c.y - GROUP_DEFAULT.h / 2) })
  const spot = freeSpot(doc.get().design, catalog.get().byType, m.type, { x: Math.round(c.x - NODE_W / 2), y: Math.round(c.y - nodeHeight(m) / 2) })
  addNode(m.type, { x: Math.round(spot.x), y: Math.round(spot.y) })
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
      .map((p) => ({
        provider: p,
        // Boundaries first, then the rest in the order the provider lists them.
        items: manifests.filter((m) => m.provider === p.id && matches(m)).sort((a, b) => Number(isContainer(b)) - Number(isContainer(a)))
      }))
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
        {sections.map(({ provider, items }) => (
          <section key={provider.id} className="picker-group">
            <h4>{provider.title}</h4>
            <div className="tiles">
              {items.map((m) => (
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

// ---------------------------------------------------------------------------------------------------------
// Something selected
// ---------------------------------------------------------------------------------------------------------

const Back = () => (
  <button className="back" onClick={() => select(undefined)} title="Back to components (Esc)">
    <Icon name="back" size={14} /> Components
  </button>
)

function NodePanel({ id }: { id: string }) {
  const design = useStore(doc, (s) => s.design)
  const manifests = useStore(catalog, (s) => s.byType)
  const providers = useStore(catalog, (s) => s.providers)
  const stats = useStats("nodes", id)
  const spec = design.nodes[id]
  if (spec === undefined) return null
  const manifest = manifests[spec.type]
  const box = isContainer(manifest)
  const provider = providers.find((p) => p.id === manifest?.provider)
  const { region, decidedBy } = regionOf(design, manifests, (p) => registry.provider(p)?.defaultRegion, id)
  const placement = manifest === undefined || region === undefined ? undefined : `${manifest.provider}:${region}`
  const inside = Object.entries(design.nodes).filter(([, n]) => n.parent === id)

  return (
    <>
      <div className="side-bar">
        <Back />
        <button className="icon-btn" title="Delete (Del)" onClick={removeSelection}>
          <Icon name="trash" size={15} />
        </button>
      </div>
      <div className="side-scroll">
        <header className="panel-head" style={{ ["--accent" as string]: manifest?.accent ?? "#8893a5" }}>
          <span className="node-icon">
            <Icon name={manifest?.icon ?? "box"} size={16} />
          </span>
          <div className="panel-title">
            <input className="title-input" value={spec.name ?? id} onChange={(e) => renameNode(id, e.target.value)} aria-label="Name" />
            <span className="muted small">
              {manifest === undefined ? `Unknown component “${spec.type}”` : `${provider?.title ?? manifest.provider} · ${manifest.service}`}
              {manifest?.docs !== undefined && (
                <a className="doc-link" href={manifest.docs} target="_blank" rel="noreferrer" title="Open the documentation">
                  <Icon name="link" size={11} />
                </a>
              )}
            </span>
          </div>
        </header>
        {manifest?.description && <p className="description">{manifest.description}</p>}
        <Diagnostics node={id} />

        {!box && provider !== undefined && region !== undefined && (
          <Section title="Placement">
            <div className="field row">
              <span className="field-lead">
                <label className="field-label">Region</label>
                <span className="hint" title="Where this runs. It sets the default latency to the nodes it talks to and which regional quotas and outages apply.">
                  <Icon name="info" size={11} />
                </span>
              </span>
              <select
                value={region}
                disabled={decidedBy !== undefined}
                onChange={(e) => setNodeRegion(id, e.target.value === provider.defaultRegion ? undefined : e.target.value)}
                aria-label="Region"
              >
                {provider.regions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id} · {r.name}
                  </option>
                ))}
              </select>
            </div>
            {decidedBy !== undefined && (
              <p className="help">
                Set by <button className="link" onClick={() => select({ kind: "node", id: decidedBy })}>{design.nodes[decidedBy]?.name ?? decidedBy}</button>. Drag the node out of the box to choose its own.
              </p>
            )}
          </Section>
        )}

        {manifest !== undefined && manifest.settings.length > 0 && (
          <Section
            title="Settings"
            aside={
              Object.keys(spec.settings ?? {}).length > 0 && (
                <button className="link" onClick={() => resetNodeSettings(id)}>
                  Reset all
                </button>
              )
            }
          >
            <SettingsForm fields={manifest.settings} values={spec.settings ?? {}} onChange={(path, value) => setNodeSetting(id, path, value)} />
          </Section>
        )}

        {box && manifest?.container?.decidesRegion && placement !== undefined && region !== undefined && (
          <Quotas placement={placement} provider={manifest.provider} region={region} />
        )}

        {box && (
          <Section title={`Inside (${inside.length})`} open={inside.length > 0}>
            {inside.length === 0 ? (
              <p className="help">Drag components into the box to place them here.</p>
            ) : (
              <ul className="members">
                {inside.map(([memberId, member]) => (
                  <li key={memberId}>
                    <button className="link" onClick={() => select({ kind: "node", id: memberId })}>
                      {member.name ?? memberId}
                    </button>
                    <span className="muted small">{manifests[member.type]?.title ?? member.type}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}

        {manifest !== undefined && manifest.limits.length > 0 && (
          <Section title="Service limits" open={false}>
            <ul className="limits">
              {manifest.limits.map((l) => (
                <li key={l.label}>
                  <span className="limit-label">
                    {l.label}
                    {l.source !== undefined && (
                      <a className="doc-link" href={l.source} target="_blank" rel="noreferrer" title={l.note ?? "Open the documentation"}>
                        <Icon name="link" size={11} />
                      </a>
                    )}
                  </span>
                  <span className="limit-value">{l.value}</span>
                  <span className="pill" data-kind={l.adjustable ? "quota" : "hard"} title={l.note}>
                    {l.adjustable ? "quota" : "hard"}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {box ? (
          manifest?.container?.decidesRegion && placement !== undefined && <FaultPanel target={{ kind: "region", id: placement }} />
        ) : (
          <>
            <FaultPanel target={{ kind: "node", id }} />
            <Section title="Live metrics">
              <Metrics stats={stats} />
            </Section>
          </>
        )}
      </div>
    </>
  )
}

/** The account-level quotas of the placement a Region box draws: the totals everything inside shares. */
function Quotas({ placement, provider, region }: { placement: string; provider: string; region: string }) {
  const overrides = useStore(doc, (s) => s.design.accounts?.[placement])
  const fields = useMemo(() => accountFields(provider, region), [provider, region])
  if (fields.length === 0) return null
  return (
    <Section
      title="Account quotas"
      aside={
        overrides !== undefined && (
          <button className="link" onClick={() => resetAccount(placement)}>
            Reset all
          </button>
        )
      }
    >
      <p className="help">Shared by everything in {region}. Defaults are the published ones for this region; the “quota” ones can be raised on request, so they're yours to change.</p>
      <SettingsForm fields={fields} values={overrides ?? {}} onChange={(path, value) => setAccountSetting(placement, path, value)} />
    </Section>
  )
}

function EdgePanel({ id }: { id: string }) {
  const design = useStore(doc, (s) => s.design)
  const manifests = useStore(catalog, (s) => s.byType)
  const edgeForm = useStore(catalog, (s) => s.edge)
  const stats = useStats("edges", id)
  const edge = design.edges[id]
  if (edge === undefined) return null
  const from = design.nodes[edge.from.node]
  const to = design.nodes[edge.to]
  const port = Design.portOf(edge)
  const portManifest = from === undefined ? undefined : manifests[from.type]?.outputs.find((o) => o.port === port)
  const fields = [...(portManifest?.settings ?? []), ...edgeForm]
  return (
    <>
      <div className="side-bar">
        <Back />
        <button className="icon-btn" title="Delete (Del)" onClick={removeSelection}>
          <Icon name="trash" size={15} />
        </button>
      </div>
      <div className="side-scroll">
        <header className="panel-head">
          <span className="node-icon edge-icon">
            <Icon name="chevron" size={16} />
          </span>
          <div className="panel-title">
            <span className="title-static">
              {from?.name ?? edge.from.node} <Icon name="chevron" size={12} /> {to?.name ?? edge.to}
            </span>
            <span className="muted small">
              Connection{(manifests[from?.type ?? ""]?.outputs.length ?? 1) > 1 ? ` · ${portManifest?.label ?? port}` : ""}
            </span>
          </div>
        </header>
        <Diagnostics edge={id} />
        <Section title="Policy">
          <SettingsForm fields={fields} values={edge.settings ?? {}} onChange={(path, value) => setEdgeSetting(id, path, value)} />
        </Section>
        <FaultPanel target={{ kind: "edge", id }} />
        <Section title="Live metrics">
          <Metrics stats={stats} />
        </Section>
      </div>
    </>
  )
}
