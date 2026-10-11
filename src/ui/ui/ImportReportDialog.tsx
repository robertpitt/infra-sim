import { useEffect, useState } from "react"
import { useStore } from "../lib/store.ts"
import { importOutcome } from "../state/files.ts"
import { Icon } from "./Icon.tsx"

/**
 * What an import did, in plain terms: how much carried over, what was added or guessed, what was left out and why.
 * An import is only trustworthy if nothing is dropped silently, so this is the other half of the importer.
 */
export function ImportReportDialog() {
  const outcome = useStore(importOutcome, (o) => o)
  useEffect(() => {
    if (outcome === undefined) return
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && importOutcome.set(undefined)
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [outcome])
  if (outcome === undefined) return null
  const { report, fileName, importer } = outcome
  const loud = report.skipped.filter((s) => !s.quiet)
  const quiet = report.skipped.filter((s) => s.quiet)
  const close = () => importOutcome.set(undefined)

  return (
    <div className="dialog-scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog" role="dialog" aria-label="Import report">
        <header className="dialog-head">
          <span className="node-icon" style={{ ["--accent" as string]: "#5aa2ff" }}>
            <Icon name="upload" size={16} />
          </span>
          <div style={{ flex: 1 }}>
            <h2>Imported {fileName}</h2>
            <p>{importer}. Here is what became of it.</p>
          </div>
          <button className="icon-btn" onClick={close} title="Close (Esc)">
            <Icon name="x" size={15} />
          </button>
        </header>
        <div className="dialog-body">
          <div className="stats">
            <div className="stat-tile"><b>{report.converted.length}</b><span>resources became components</span></div>
            <div className="stat-tile"><b>{report.settings.preserved}</b><span>settings carried over</span></div>
            <div className="stat-tile"><b>{report.connections.declared + report.connections.inferred}</b><span>connections ({report.connections.inferred} inferred)</span></div>
            <div className="stat-tile"><b>{loud.length}</b><span>left out</span></div>
          </div>

          {report.warnings.length > 0 && (
            <Section title={`Worth a look (${report.warnings.length})`}>
              {report.warnings.map((w, i) => <li key={i} data-tone="warn">{w}</li>)}
            </Section>
          )}
          {report.added.length > 0 && (
            <Section title="Added, because the source doesn't say">
              {report.added.map((a, i) => <li key={i}>{a}</li>)}
            </Section>
          )}
          {(report.settings.adjusted.length > 0 || report.settings.unresolved.length > 0) && (
            <Section title="Settings that didn't carry over as written">
              {report.settings.adjusted.map((a, i) => <li key={`a${i}`} data-tone="warn">{a}</li>)}
              {report.settings.unresolved.map((a, i) => <li key={`u${i}`}>{a}; kept the default</li>)}
            </Section>
          )}
          {loud.length > 0 && (
            <Section title={`Left out: no component yet (${loud.length})`}>
              {loud.map((s) => <li key={s.id}><span className="id">{s.id}</span> <code>{s.type}</code> {s.reason}</li>)}
            </Section>
          )}
          {quiet.length > 0 && (
            <Section title={`Left out: doesn't change behaviour under load (${quiet.length})`} collapsed>
              {quiet.map((s) => <li key={s.id}><span className="id">{s.id}</span> <code>{s.type}</code> {s.reason}</li>)}
            </Section>
          )}
          <Section title={`Components (${report.converted.length})`} collapsed>
            {report.converted.map((c) => <li key={c.id}><span className="id">{c.id}</span> <code>{c.type}</code> → {c.node}</li>)}
          </Section>
        </div>
        <footer className="dialog-foot">
          <button className="btn primary" onClick={close}>Done</button>
        </footer>
      </div>
    </div>
  )
}

function Section({ title, children, collapsed = false }: { title: string; children: React.ReactNode; collapsed?: boolean }) {
  const [open, setOpen] = useState(!collapsed)
  return (
    <section className="report-section">
      <h4>
        <button onClick={() => setOpen(!open)} aria-expanded={open}>
          <Icon name={open ? "chevronDown" : "chevron"} size={11} />
          {title}
        </button>
      </h4>
      {open && <ul className="report-list">{children}</ul>}
    </section>
  )
}
