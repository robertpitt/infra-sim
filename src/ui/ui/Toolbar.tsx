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
import { KeyStats } from "./KeyStats.tsx"
import { SpeedSlider } from "./SpeedSlider.tsx"

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
        <Icon name={icon} size={14} /> {label}
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
      <div className="brand" title="Infra Simulator">
        <span className="logo">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 16l4.5-6 3.5 3.5L19 6" />
          </svg>
        </span>
        <span className="design-name">{name || "Untitled design"}</span>
      </div>

      <div className="transport">
        <button className="btn icon" title="Restart from t=0" disabled={!can} onClick={() => client.send({ _tag: "reset" })}>
          <Icon name="reset" size={14} />
        </button>
        <button
          className="btn primary"
          disabled={!can}
          onClick={() => client.send({ _tag: running ? "pause" : "play" })}
          title="Play / pause (Space)"
        >
          <Icon name={running ? "pause" : "play"} size={14} />
          <span className="btn-label">{running ? "Pause" : "Play"}</span>
        </button>
        <button className="btn icon" title="Step forward 1 second" disabled={phase !== "paused"} onClick={() => client.send({ _tag: "step", ms: 1000 })}>
          <Icon name="step" size={14} />
        </button>
        <div className="clock" data-slow={slow || undefined} title={slow ? `The simulation can't keep up: running at ${fmtRate(status!.effectiveSpeed)}×` : "Simulated time"}>
          {fmtClock(status?.t ?? 0)}
        </div>
        <SpeedSlider speed={status?.speed ?? 1} achieved={running ? status?.effectiveSpeed : undefined} disabled={status === undefined} />
      </div>

      <KeyStats />

      <div className="tools">
        <button className="btn icon" title="Undo (⌘Z)" disabled={!canUndo} onClick={undo}>
          <Icon name="undo" size={14} />
        </button>
        <button className="btn icon" title="Redo (⌘⇧Z)" disabled={!canRedo} onClick={redo}>
          <Icon name="redo" size={14} />
        </button>
        <span className="sep" />
        <button className="btn icon" title="Zoom out" onClick={() => viewport.zoomCenter(1 / 1.2)}>
          <Icon name="minus" size={14} />
        </button>
        <span className="zoom">{zoom}%</span>
        <button className="btn icon" title="Zoom in" onClick={() => viewport.zoomCenter(1.2)}>
          <Icon name="plus" size={14} />
        </button>
        <button className="btn icon" title="Fit to screen (F)" onClick={fitView}>
          <Icon name="fit" size={14} />
        </button>
        <button
          className="btn icon"
          title="Tidy layout"
          onClick={() => {
            applyLayout((d) => fitGroups(Layout.autoLayout(d, registry, { all: true }), catalog.get().byType))
            requestAnimationFrame(fitView)
          }}
        >
          <Icon name="layout" size={14} />
        </button>
        <span className="sep" />
        <button className="btn icon" data-on={dock || undefined} title="Charts" onClick={() => togglePanel("dockCollapsed")}>
          <Icon name="charts" size={14} />
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
          <Icon name="panelRight" size={14} />
        </button>
      </div>
      {message !== undefined && <div className="toast">{message}</div>}
    </header>
  )
}
