import { createStore } from "../lib/store.ts"

export type DockTab = "charts" | "alerts" | "scenario"

/** Which panels are showing. Defaults adapt to the window the app opens in. */
export interface UiState {
  /** The one sidebar: components when nothing is selected, settings when something is. */
  readonly sidebar: boolean
  readonly dockCollapsed: boolean
  /** What the dock under the canvas shows. */
  readonly dockTab: DockTab
  /** The design as a canvas, or as YAML in an editor. */
  readonly view: "visual" | "editor"
  /** The settings dialog of what is selected. */
  readonly settings: boolean
  /** How tall the dock's body is, in pixels: its top edge drags. */
  readonly dockHeight: number
}

// The dock starts folded away so the canvas gets the room; once someone opens or closes it, or picks a tab, that sticks.
const DOCK_KEY = "sim:ui:dock"
const TAB_KEY = "sim:ui:dock-tab"
const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const savedTab = read(TAB_KEY)
const HEIGHT_KEY = "sim:ui:dock-height"
/** The dock's body: tall enough for a row of key figures and a row of charts, and never most of the window. */
export const DOCK_MIN = 140
export const dockMax = (): number => Math.max(DOCK_MIN, Math.round(window.innerHeight * 0.7))
const savedHeight = Number(read(HEIGHT_KEY))

export const ui = createStore<UiState>({
  sidebar: window.innerWidth >= 1000,
  dockCollapsed: read(DOCK_KEY) !== "open",
  dockTab: savedTab === "alerts" || savedTab === "scenario" ? savedTab : "charts",
  view: "visual",
  settings: false,
  dockHeight: Number.isFinite(savedHeight) && savedHeight >= DOCK_MIN ? savedHeight : 300
})

ui.subscribe(() => {
  try {
    localStorage.setItem(DOCK_KEY, ui.get().dockCollapsed ? "collapsed" : "open")
    localStorage.setItem(TAB_KEY, ui.get().dockTab)
    localStorage.setItem(HEIGHT_KEY, String(ui.get().dockHeight))
  } catch {
    // Storage blocked: the dock just starts collapsed next time.
  }
})

type Panel = "sidebar" | "dockCollapsed" | "settings"
export const togglePanel = (key: Panel): void => ui.set((s) => ({ ...s, [key]: !s[key] }))
export const setPanel = (key: Panel, value: boolean): void => ui.set((s) => (s[key] === value ? s : { ...s, [key]: value }))

export const openSettings = (): void => setPanel("settings", true)
export const closeSettings = (): void => setPanel("settings", false)

export const setDockHeight = (px: number): void => {
  const h = Math.round(Math.min(dockMax(), Math.max(DOCK_MIN, px)))
  ui.set((s) => (s.dockHeight === h ? s : { ...s, dockHeight: h }))
}

/** Show a tab of the dock, opening the dock if it is folded away. */
export const setDockTab = (tab: DockTab): void =>
  ui.set((s) => (s.dockTab === tab && !s.dockCollapsed ? s : { ...s, dockTab: tab, dockCollapsed: false }))
