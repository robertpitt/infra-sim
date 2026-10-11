import { Layout } from "#simulator"
import { useEffect, useRef, useState } from "react"
import type { ReactNode } from "react"
import { fmtClock, fmtRate } from "../lib/format.ts"
import { useStore } from "../lib/store.ts"
import { applyLayout, doc, redo, undo } from "../state/document.ts"
import { catalog, client, registry } from "../state/engine.ts"
import { importers } from "#simulator"
import { copyMermaid, fitView, importFileDialog, openDesign, openFileDialog, saveDesign, say, toast } from "../state/files.ts"
import { run } from "../state/run.ts"
import { fitGroups } from "../canvas/groups.ts"
import * as viewport from "../canvas/viewport.ts"
import { togglePanel, ui } from "../state/ui.ts"
import { Icon } from "./Icon.tsx"

const SPEEDS = [0.25, 0.5, 1, 2, 5, 10, 25, 50]

function Menu({ label, icon, children }: { label: string; icon: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener("pointerdown", away)
    return () => window.removeEventListener("pointerdown", away)
  }, [open])
  return (
    <div className="menu" ref={ref}>
      <button className="btn" data-on={open || undefined} onClick={() => setOpen((o) => !o)}>
        <Icon name={icon} size={15} /> {label}
      </button>
      {open && <div className="menu-pop">{children(() => setOpen(false))}</div>}
    </div>
  )
}

export function Toolbar() {
  const status = useStore(run, (s) => s.status)
  const canUndo = useStore(doc, (s) => s.past.length > 0)
  const canRedo = useStore(doc, (s) => s.future.length > 0)
  const zoom = useStore(viewport.view, (v) => Math.round(v.k * 100))
  const name = useStore(doc, (s) => s.design.name)
  const sidebar = useStore(ui, (s) => s.sidebar)
  const dock = useStore(ui, (s) => !s.dockCollapsed)
  const message = useStore(toast, (t) => t)

  const phase = status?.phase ?? "empty"
  const running = phase === "running"
  const can = phase === "running" || phase === "paused"
  const slow = running && status !== undefined && status.effectiveSpeed < status.speed * 0.85

  return (
    <header className="toolbar">
      <div className="brand">
        <span className="logo">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 16l4.5-6 3.5 3.5L19 6" />
          </svg>
        </span>
        <span className="brand-name">Infra Simulator</span>
        {name && <span className="design-name">{name}</span>}
      </div>

      <div className="transport">
        <button className="btn icon" title="Restart from t=0" disabled={!can} onClick={() => client.send({ _tag: "reset" })}>
          <Icon name="reset" size={15} />
        </button>
        <button
          className="btn primary"
          disabled={!can}
          onClick={() => client.send({ _tag: running ? "pause" : "play" })}
          title="Play / pause (Space)"
        >
          <Icon name={running ? "pause" : "play"} size={15} />
          {running ? "Pause" : "Play"}
        </button>
        <button className="btn icon" title="Step forward 1 second" disabled={phase !== "paused"} onClick={() => client.send({ _tag: "step", ms: 1000 })}>
          <Icon name="step" size={15} />
        </button>
        <label className="speed" title="Virtual seconds per real second">
          <select value={String(status?.speed ?? 1)} onChange={(e) => client.send({ _tag: "setSpeed", speed: Number(e.target.value) })}>
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
        <div className="clock" data-slow={slow || undefined} title={slow ? "The simulation can't keep up with this speed" : "Simulated time"}>
          <b>{fmtClock(status?.t ?? 0)}</b>
          {running && status !== undefined && (
            <small>{slow ? `running at ${fmtRate(status.effectiveSpeed)}×` : ""}</small>
          )}
        </div>
      </div>

      <div className="tools">
        <button className="btn icon" title="Undo (⌘Z)" disabled={!canUndo} onClick={undo}>
          <Icon name="undo" size={15} />
        </button>
        <button className="btn icon" title="Redo (⌘⇧Z)" disabled={!canRedo} onClick={redo}>
          <Icon name="redo" size={15} />
        </button>
        <span className="sep" />
        <button className="btn icon" title="Zoom out" onClick={() => viewport.zoomCenter(1 / 1.2)}>
          <Icon name="minus" size={15} />
        </button>
        <span className="zoom">{zoom}%</span>
        <button className="btn icon" title="Zoom in" onClick={() => viewport.zoomCenter(1.2)}>
          <Icon name="plus" size={15} />
        </button>
        <button className="btn icon" title="Fit to screen (F)" onClick={fitView}>
          <Icon name="fit" size={15} />
        </button>
        <button
          className="btn icon"
          title="Tidy layout"
          onClick={() => {
            applyLayout((d) => fitGroups(Layout.autoLayout(d, registry, { all: true }), catalog.get().byType))
            requestAnimationFrame(fitView)
          }}
        >
          <Icon name="layout" size={15} />
        </button>
        <span className="sep" />
        <button className="btn icon" data-on={dock || undefined} title="Charts" onClick={() => togglePanel("dockCollapsed")}>
          <Icon name="charts" size={15} />
        </button>
        <Menu label="File" icon="menu">
          {(close) => (
            <>
              <button className="menu-item" onClick={() => { close(); void openFileDialog() }}>
                <Icon name="upload" size={14} /> Open…<kbd className="menu-key">⌘O</kbd>
              </button>
              <button className="menu-item" onClick={() => { close(); saveDesign("yaml") }}>
                <Icon name="download" size={14} /> Save (YAML)<kbd className="menu-key">⌘S</kbd>
              </button>
              <button className="menu-item" onClick={() => { close(); saveDesign("json") }}>
                <Icon name="download" size={14} /> Save as JSON
              </button>
              <div className="menu-sep" />
              <div className="menu-label">Import</div>
              {importers.map((importer) => (
                <button key={importer.id} className="menu-item" onClick={() => { close(); void importFileDialog(importer) }}>
                  <Icon name="upload" size={14} /> {importer.title}…
                </button>
              ))}
              <div className="menu-sep" />
              <button
                className="menu-item"
                onClick={async () => {
                  close()
                  await copyMermaid()
                  say("Mermaid diagram copied", 2000)
                }}
              >
                <Icon name="copy" size={14} /> Copy as Mermaid
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  close()
                  openDesign({ version: 1, name: "Untitled", seed: 1, nodes: {}, edges: {} })
                }}
              >
                <Icon name="plus" size={14} /> New blank design
              </button>
            </>
          )}
        </Menu>
        <button className="btn icon" data-on={sidebar || undefined} title="Sidebar" onClick={() => togglePanel("sidebar")}>
          <Icon name="panelRight" size={15} />
        </button>
      </div>
      {message !== undefined && <div className="toast">{message}</div>}
    </header>
  )
}
