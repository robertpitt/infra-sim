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

export const ui = createStore<UiState>({
  sidebar: window.innerWidth >= 1000,
  dockCollapsed: read(DOCK_KEY) !== "open",
  dockTab: savedTab === "alerts" || savedTab === "scenario" ? savedTab : "charts",
  view: "visual",
  settings: false
})

ui.subscribe(() => {
  try {
    localStorage.setItem(DOCK_KEY, ui.get().dockCollapsed ? "collapsed" : "open")
    localStorage.setItem(TAB_KEY, ui.get().dockTab)
  } catch {
    // Storage blocked: the dock just starts collapsed next time.
  }
})

type Panel = "sidebar" | "dockCollapsed" | "settings"
export const togglePanel = (key: Panel): void => ui.set((s) => ({ ...s, [key]: !s[key] }))
export const setPanel = (key: Panel, value: boolean): void => ui.set((s) => (s[key] === value ? s : { ...s, [key]: value }))

export const openSettings = (): void => setPanel("settings", true)
export const closeSettings = (): void => setPanel("settings", false)

/** Show a tab of the dock, opening the dock if it is folded away. */
export const setDockTab = (tab: DockTab): void =>
  ui.set((s) => (s.dockTab === tab && !s.dockCollapsed ? s : { ...s, dockTab: tab, dockCollapsed: false }))
