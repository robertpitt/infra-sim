import { bucketOf, SALT_CACHE } from "./hash.ts"

/** Which cache entry a request asks for, as an index in [0, keys). */
export const cacheKeyOf = (key: number, keys: number): number => bucketOf(key, SALT_CACHE, keys)

/**
 * A REST API stage cache: which responses are held and until when.
 *
 * Entries are keyed by the cache key parameters (here: an index in [0, keys)) and live for the TTL. The cluster holds a
 * fixed number of entries for its size and response size; when it is full the oldest entry makes room (AWS publishes no
 * eviction policy, so first in, first out is an assumption). A replaced entry counts as new. An expired entry is dropped when it is asked for or pushed out
 * by a newer one. Changing the cluster size empties it, as AWS does when it
 * replaces the instance.
 */
export interface ResponseCache {
  /** Whether `entry` is cached and fresh at `now`. */
  readonly has: (entry: number, now: number) => boolean
  /** Hold `entry` until `expiresAt`, evicting the oldest if there are already `capacity` entries. */
  readonly put: (entry: number, expiresAt: number, capacity: number) => void
  /** Empty the cache (a resize, or a flush). */
  readonly flush: () => void
  readonly size: () => number
}

export const makeResponseCache = (): ResponseCache => {
  // A Map iterates in insertion order, which is exactly the eviction order: deleting and re-inserting moves an entry to the back.
  const entries = new Map<number, number>()
  return {
    has: (entry, now) => {
      const expiresAt = entries.get(entry)
      if (expiresAt === undefined) return false
      if (now < expiresAt) return true
      entries.delete(entry)
      return false
    },
    put: (entry, expiresAt, capacity) => {
      entries.delete(entry)
      while (entries.size >= capacity) {
        const oldest = entries.keys().next()
        if (oldest.done === true) break
        entries.delete(oldest.value)
      }
      entries.set(entry, expiresAt)
    },
    flush: () => entries.clear(),
    size: () => entries.size
  }
}
