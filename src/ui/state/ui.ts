import { createStore } from "../lib/store.ts"

/** Which panels are showing. Defaults adapt to the window the app opens in. */
export interface UiState {
  /** The one sidebar: components when nothing is selected, settings when something is. */
  readonly sidebar: boolean
  readonly dockCollapsed: boolean
}

// The charts dock starts folded away so the canvas gets the room; once someone opens or closes it, that sticks.
const DOCK_KEY = "sim:ui:dock"
const savedDock = (): boolean | undefined => {
  try {
    const raw = localStorage.getItem(DOCK_KEY)
    return raw === null ? undefined : raw === "collapsed"
  } catch {
    return undefined
  }
}

export const ui = createStore<UiState>({
  sidebar: window.innerWidth >= 1000,
  dockCollapsed: savedDock() ?? true
})

ui.subscribe(() => {
  try {
    localStorage.setItem(DOCK_KEY, ui.get().dockCollapsed ? "collapsed" : "open")
  } catch {
    // Storage blocked: the dock just starts collapsed next time.
  }
})

export const togglePanel = (key: keyof UiState): void => ui.set((s) => ({ ...s, [key]: !s[key] }))
export const setPanel = (key: keyof UiState, value: boolean): void => ui.set((s) => (s[key] === value ? s : { ...s, [key]: value }))
