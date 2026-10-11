import { useRef, useSyncExternalStore } from "react"

/** A tiny external store: the whole state management story for this app. */
export interface Store<S> {
  readonly get: () => S
  readonly set: (next: S | ((current: S) => S)) => void
  readonly subscribe: (listener: () => void) => () => void
}

export const createStore = <S>(initial: S): Store<S> => {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    set: (next) => {
      const value = typeof next === "function" ? (next as (s: S) => S)(state) : next
      if (Object.is(value, state)) return
      state = value
      for (const listener of [...listeners]) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    }
  }
}

/** Subscribe a component to a slice of a store. Re-renders only when the selected value changes. */
export const useStore = <S, T>(store: Store<S>, select: (state: S) => T, isEqual: (a: T, b: T) => boolean = Object.is): T => {
  const cache = useRef<{ state: S; select: (state: S) => T; value: T } | undefined>(undefined)
  const snapshot = (): T => {
    const state = store.get()
    const hit = cache.current
    if (hit !== undefined && hit.state === state && hit.select === select) return hit.value
    const value = select(state)
    if (hit !== undefined && isEqual(hit.value, value)) {
      cache.current = { state, select, value: hit.value }
      return hit.value
    }
    cache.current = { state, select, value }
    return value
  }
  return useSyncExternalStore(store.subscribe, snapshot, snapshot)
}

/** Shallow equality for selecting small records. */
export const shallow = <T extends object>(a: T, b: T): boolean => {
  if (Object.is(a, b)) return true
  const ak = Object.keys(a) as Array<keyof T>
  const bk = Object.keys(b)
  return ak.length === bk.length && ak.every((k) => Object.is(a[k], b[k]))
}
