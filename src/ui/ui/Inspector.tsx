import { Connector, Controller, Design } from "#simulator"
import { useMemo } from "react"
import { isContainer, regionOf } from "../canvas/groups.ts"
import { useStats } from "../canvas/stats.ts"
import { useStore } from "../lib/store.ts"
import {
  addController,
  doc,
  removeController,
  renameNode,
  resetAccount,
  resetNodeSettings,
  select,
  setAccountSetting,
  setControllerSetting,
  setEdgeConnector,
  setEdgeSetting,
  setNodeRegion,
  setNodeSetting
} from "../state/document.ts"
import { accountFields, catalog, connectorOf, registry } from "../state/engine.ts"
import type { ControllerManifest } from "../state/types.ts"
import { FaultPanel } from "./FaultPanel.tsx"
import { Icon } from "./Icon.tsx"
import { Metrics } from "./Metrics.tsx"
import { Diagnostics, Section } from "./Panel.tsx"
import { SettingsForm } from "./SettingsForm.tsx"

// ---------------------------------------------------------------------------------------------------------
// The settings of a node (or a container) and of a connection, shown in the settings dialog
// ---------------------------------------------------------------------------------------------------------

/** A node's or a container's settings: its name, placement, settings, controllers, quotas, faults and live numbers. */
export function NodeSettings({ id }: { id: string }) {
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
            <Controllers target={id} type={spec.type} />
            <FaultPanel target={{ kind: "node", id }} />
            <Section title="Live metrics">
              <Metrics stats={stats} />
            </Section>
          </>
        )}
    </>
  )
}

/**
 * What changes this node while it runs: each controller attached to it with its settings and what it is doing, and a
 * way to attach another. A controller acts only through the node's settings, so its changes show in the run, not here.
 */
function Controllers({ target, type }: { target: string; type: string }) {
  const attached = useStore(doc, (s) => s.design.controllers)
  const available = useStore(catalog, (s) => s.controllers)
  const mine = Object.entries(attached ?? {}).filter(([, c]) => c.target === target)
  const fitting = available.filter((c) => Controller.fits(c, type))
  if (fitting.length === 0) return null
  return (
    <Section title="Controllers" open={mine.length > 0}>
      {mine.length === 0 && <p className="help">Nothing changes this while it runs. Attach a controller to scale one of its settings to its load.</p>}
      {mine.map(([id, c]) => (
        <AttachedController key={id} id={id} spec={c} manifest={available.find((m) => m.type === c.type)} />
      ))}
      <div className="field row">
        <span className="field-lead">
          <label className="field-label">Attach</label>
        </span>
        <select
          value=""
          aria-label="Attach a controller"
          onChange={(e) => {
            if (e.target.value !== "") addController(e.target.value, target)
          }}
        >
          <option value="">Choose…</option>
          {fitting.map((c) => (
            <option key={c.type} value={c.type}>
              {c.title}
            </option>
          ))}
        </select>
      </div>
    </Section>
  )
}

function AttachedController({ id, spec, manifest }: { id: string; spec: { readonly type: string; readonly settings?: Readonly<Record<string, unknown>> }; manifest: ControllerManifest | undefined }) {
  const stats = useStats("controllers", id)
  return (
    <div className="controller" data-controller-id={id}>
      <div className="controller-head">
        <Icon name={manifest?.icon ?? "charts"} size={14} />
        <span className="controller-title">{manifest?.title ?? spec.type}</span>
        <button className="icon-btn" title="Detach this controller" aria-label="Detach this controller" onClick={() => removeController(id)}>
          <Icon name="trash" size={13} />
        </button>
      </div>
      <Diagnostics controller={id} />
      {manifest !== undefined && (
        <SettingsForm fields={manifest.settings} values={spec.settings ?? {}} onChange={(path, value) => setControllerSetting(id, path, value)} />
      )}
      {stats !== undefined && <Metrics stats={stats} />}
    </div>
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

/** A connection's settings: what sits on it, its policy, faults and live numbers. */
export function EdgeSettings({ id }: { id: string }) {
  const design = useStore(doc, (s) => s.design)
  const manifests = useStore(catalog, (s) => s.byType)
  const transport = useStore(catalog, (s) => s.transport)
  const stats = useStats("edges", id)
  const edge = design.edges[id]
  if (edge === undefined) return null
  const from = design.nodes[edge.from.node]
  const to = design.nodes[edge.to]
  const port = Design.portOf(edge)
  const portManifest = from === undefined ? undefined : manifests[from.type]?.outputs.find((o) => o.port === port)
  // What sits on the edge: the one the document names, or the one that fits best. Its form follows the port's own.
  const on = from === undefined || to === undefined ? undefined : connectorOf({ type: from.type, port }, to.type, edge.connector)
  const fields = Connector.edgeFields(portManifest?.settings ?? [], on?.connector.settings ?? [], transport)
  const inferred = from === undefined || to === undefined ? undefined : connectorOf({ type: from.type, port }, to.type)?.connector
  return (
    <>
        <header className="panel-head">
          <span className="node-icon edge-icon">
            <Icon name={on?.connector.icon ?? "chevron"} size={16} />
          </span>
          <div className="panel-title">
            <span className="title-static">
              {from?.name ?? edge.from.node} <Icon name="chevron" size={12} /> {to?.name ?? edge.to}
            </span>
            <span className="muted small">
              {on?.connector.title ?? "Connection"}
              {(manifests[from?.type ?? ""]?.outputs.length ?? 1) > 1 ? ` · ${portManifest?.label ?? port}` : ""}
            </span>
          </div>
        </header>
        <Diagnostics edge={id} />
        {on !== undefined && on.choices.length > 1 && (
          <Section title="Between them">
            <div className="field row">
              <span className="field-lead">
                <label className="field-label">Connector</label>
                <span className="hint" title="What sits on this connection between the two components. By default the most specific one that fits.">
                  <Icon name="info" size={11} />
                </span>
              </span>
              <select
                value={edge.connector ?? ""}
                onChange={(e) => setEdgeConnector(id, e.target.value === "" ? undefined : e.target.value)}
                aria-label="Connector"
              >
                <option value="" title={inferred === undefined ? undefined : `${inferred.title}, the most specific connector that fits`}>
                  Best fit
                </option>
                {on.choices.map((c) => (
                  <option key={c.type} value={c.type}>
                    {c.title}
                  </option>
                ))}
              </select>
            </div>
            {on.connector.description !== "" && <p className="help">{on.connector.description}</p>}
          </Section>
        )}
        <Section title={on === undefined || Connector.isPlain(on.connector.type) ? "Policy" : on.connector.title}>
          <SettingsForm fields={fields} values={edge.settings ?? {}} onChange={(path, value) => setEdgeSetting(id, path, value)} />
        </Section>
        <FaultPanel target={{ kind: "edge", id }} />
        <Section title="Live metrics">
          <Metrics stats={stats} />
        </Section>
    </>
  )
}
