import { useEffect, useSyncExternalStore } from "react"
import { Canvas } from "./canvas/Canvas.tsx"
import { useStore } from "./lib/store.ts"
import { doc, redo, removeSelection, select, undo } from "./state/document.ts"
import { client } from "./state/engine.ts"
import { fitView, openFileDialog, saveDesign } from "./state/files.ts"
import { run } from "./state/run.ts"
import { setPanel, ui } from "./state/ui.ts"
import { startSync } from "./state/sync.ts"
import { Dock } from "./ui/Dock.tsx"
import { ImportReportDialog } from "./ui/ImportReportDialog.tsx"
import { Icon } from "./ui/Icon.tsx"
import { Sidebar } from "./ui/Sidebar.tsx"
import { Toolbar } from "./ui/Toolbar.tsx"
import * as viewport from "./canvas/viewport.ts"

const typing = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null
  return el !== null && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)
}

function Banner() {
  const status = useStore(run, (s) => s.status)
  const diagnostics = useStore(run, (s) => s.diagnostics)
  const notice = useStore(run, (s) => s.notice)
  const errors = diagnostics.filter((d) => d.level === "error")
  if (status?.phase === "error" && errors.length > 0) {
    return (
      <div className="banner error">
        <Icon name="warn" size={15} />
        <div>
          <b>This design can't run yet</b>
          <ul>
            {errors.slice(0, 4).map((d, i) => (
              <li key={i}>
                <button
                  className="link"
                  onClick={() => select(d.node !== undefined ? { kind: "node", id: d.node } : d.edge !== undefined ? { kind: "edge", id: d.edge } : undefined)}
                >
                  {d.message}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    )
  }
  if (notice !== undefined) {
    return (
      <div className="banner warn">
        <Icon name="info" size={15} /> {notice}
      </div>
    )
  }
  return null
}

const NARROW = "(max-width: 1000px)"
const useNarrow = (): boolean =>
  useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(NARROW)
      query.addEventListener("change", notify)
      return () => query.removeEventListener("change", notify)
    },
    () => window.matchMedia(NARROW).matches
  )

export function App() {
  const narrow = useNarrow()
  const sidebar = useStore(ui, (s) => s.sidebar)
  const selected = useStore(doc, (s) => (s.selection === undefined ? "" : `${s.selection.kind}:${s.selection.id}`))
  // On narrow windows the sidebar is a drawer: selecting something brings up its settings.
  useEffect(() => {
    if (narrow && selected !== "") setPanel("sidebar", true)
  }, [narrow, selected])

  useEffect(() => {
    const stop = startSync()
    client.send({ _tag: "setSpeed", speed: 5 })
    client.send({ _tag: "play" })
    const frame = requestAnimationFrame(fitView)
    return () => {
      cancelAnimationFrame(frame)
      stop()
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target)) return
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault()
        return e.shiftKey ? redo() : undo()
      }
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault()
        return saveDesign(e.shiftKey ? "json" : "yaml")
      }
      if (mod && e.key.toLowerCase() === "o") {
        e.preventDefault()
        return void openFileDialog()
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault()
        return redo()
      }
      if (mod) return
      switch (e.key) {
        case " ": {
          e.preventDefault()
          const phase = run.get().status?.phase
          if (phase === "running") client.send({ _tag: "pause" })
          else if (phase === "paused") client.send({ _tag: "play" })
          return
        }
        case "Delete":
        case "Backspace":
          if (doc.get().selection !== undefined) {
            e.preventDefault()
            removeSelection()
          }
          return
        case "Escape":
          return select(undefined)
        case "f":
        case "F":
          return fitView()
        case "+":
        case "=":
          return viewport.zoomCenter(1.2)
        case "-":
          return viewport.zoomCenter(1 / 1.2)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const phase = useStore(run, (s) => s.status?.phase)
  const drawerOpen = narrow && sidebar

  return (
    <div
      className="app"
      data-phase={phase}
      data-narrow={narrow || undefined}
      data-sidebar={sidebar ? "on" : "off"}
    >
      <Toolbar />
      {drawerOpen && <div className="scrim" onClick={() => setPanel("sidebar", false)} />}
      <main className="stage">
        <div className="stage-canvas">
          <Canvas />
          <Banner />
        </div>
        <Dock />
      </main>
      <Sidebar />
      <ImportReportDialog />
    </div>
  )
}
