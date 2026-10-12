import { useState } from "react"
import { fmtClock, fmtMs } from "../lib/format.ts"
import { useStore } from "../lib/store.ts"
import { catalog, client } from "../state/engine.ts"
import type { Target } from "../state/types.ts"
import { run } from "../state/run.ts"
import { Icon } from "./Icon.tsx"
import { SettingsForm } from "./SettingsForm.tsx"

const DURATIONS: ReadonlyArray<{ label: string; ms: number | undefined }> = [
  { label: "Until cleared", ms: undefined },
  { label: "10 s", ms: 10_000 },
  { label: "30 s", ms: 30_000 },
  { label: "1 min", ms: 60_000 },
  { label: "5 min", ms: 300_000 }
]

const describe = (key: string, value: unknown): string =>
  typeof value !== "number" ? String(value) : key.endsWith("ate") ? `${Math.round(value * 100)}%` : fmtMs(value)

/**
 * Inject and clear faults on a node, an edge or a region. The kinds and their parameters come from the engine's
 * catalogue. A region's panel is given its zones too: a fault then goes on the whole region or on one zone of it.
 */
export function FaultPanel({ target: region, zones = [], fleet = false }: { target: Target; zones?: ReadonlyArray<string>; fleet?: boolean }) {
  const [where, setWhere] = useState<string>("")
  const zone = region.kind === "region" && zones.includes(where) ? where : undefined
  const target: Target = zone === undefined ? region : { kind: "zone", id: `${region.id}:${zone}` }
  /** Faults on this target, and for a region on any of its zones too. */
  const mine = (f: { readonly target: Target }) =>
    (f.target.kind === region.kind && f.target.id === region.id) || (region.kind === "region" && f.target.kind === "zone" && f.target.id.startsWith(`${region.id}:`))
  const active = useStore(
    run,
    (s) => s.faults.filter(mine),
    (a, b) => a.length === b.length && a.every((f, i) => f.id === b[i]?.id)
  )
  const now = useStore(run, (s) => s.status?.t ?? 0)
  const [open, setOpen] = useState<string | undefined>()
  const [params, setParams] = useState<Record<string, unknown>>({})
  const [duration, setDuration] = useState<number | undefined>(undefined)
  const all = useStore(catalog, (s) => s.faults)
  const kinds = all.filter((k) => k.targets.includes(target.kind) && (fleet || k.fleetsOnly !== true))
  const choice = kinds.find((k) => k.tag === open)

  const inject = () => {
    if (choice === undefined) return
    client.send({ _tag: "inject", target, fault: { _tag: choice.tag, ...params } as never, ...(duration === undefined ? {} : { durationMs: duration }) })
    setOpen(undefined)
    setParams({})
  }

  return (
    <section className="panel-section">
      <h3>
        <Icon name="bolt" size={13} /> Faults
      </h3>
      {active.length > 0 && (
        <ul className="fault-list">
          {active.map((f) => (
            <li key={f.id}>
              <span className="fault-kind">
                {all.find((k) => k.tag === f.fault._tag)?.label ?? f.fault._tag}
                {f.target.kind === "zone" && <span className="muted"> · {f.target.id.slice(region.id.length + 1)}</span>}
              </span>
              <span className="fault-meta">
                {Object.entries(f.fault)
                  .filter(([key]) => key !== "_tag")
                  .map(([key, v]) => `${key.replace(/([A-Z])/g, " $1").toLowerCase()} ${describe(key, v)}`)
                  .join(", ")}
                {f.endsAt !== undefined && ` · ${fmtClock(Math.max(0, f.endsAt - now))} left`}
              </span>
              <button className="icon-btn" title="Clear fault" onClick={() => client.send({ _tag: "clearFault", id: f.id })}>
                <Icon name="x" size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {region.kind === "region" && zones.length > 0 && (
        <div className="field row">
          <span className="field-lead">
            <label className="field-label">Where</label>
            <span className="hint" title="A zone fault reaches the nodes placed in that zone and the replicas fleets run there; a region fault reaches everything in the region.">
              <Icon name="info" size={11} />
            </span>
          </span>
          <select value={where} onChange={(e) => setWhere(e.target.value)} aria-label="Where">
            <option value="">The whole region</option>
            {zones.map((z) => (
              <option key={z} value={z}>
                Zone {z}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="fault-buttons">
        {kinds.map((k) => (
          <button
            key={k.tag}
            className="btn small"
            data-on={open === k.tag || undefined}
            title={k.help}
            onClick={() => {
              if (open === k.tag) return setOpen(undefined)
              setOpen(k.tag)
              setParams({})
            }}
          >
            {k.label}
          </button>
        ))}
      </div>
      {choice !== undefined && (
        <div className="fault-form">
          <p className="help">{choice.help}</p>
          {choice.fields.length > 0 && <SettingsForm fields={choice.fields} values={params} onChange={(path, value) => setParams((p) => ({ ...p, [path[0]!]: value }))} />}
          <div className="field row">
            <span className="field-lead">
              <label className="field-label">Duration</label>
            </span>
            <select value={String(duration ?? "")} onChange={(e) => setDuration(e.target.value === "" ? undefined : Number(e.target.value))}>
              {DURATIONS.map((d) => (
                <option key={d.label} value={d.ms === undefined ? "" : String(d.ms)}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
          <button className="btn danger" onClick={inject}>
            <Icon name="bolt" size={13} /> Inject {choice.label.toLowerCase()}
          </button>
        </div>
      )}
      {active.length > 1 && (
        <button
          className="btn small ghost"
          onClick={() => active.forEach((f) => client.send({ _tag: "clearFault", id: f.id }))}
        >
          Clear all on this {region.kind}
        </button>
      )}
    </section>
  )
}
