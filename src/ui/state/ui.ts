import { createStore } from "../lib/store.ts"

/** Which panels are showing. Defaults adapt to the window the app opens in. */
export interface UiState {
  /** The one sidebar: components when nothing is selected, settings when something is. */
  readonly sidebar: boolean
  readonly dockCollapsed: boolean
}

export const ui = createStore<UiState>({
  sidebar: window.innerWidth >= 1000,
  dockCollapsed: window.innerHeight < 760
})

export const togglePanel = (key: keyof UiState): void => ui.set((s) => ({ ...s, [key]: !s[key] }))
export const setPanel = (key: keyof UiState, value: boolean): void => ui.set((s) => (s[key] === value ? s : { ...s, [key]: value }))
