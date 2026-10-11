/**
 * One cache: the objects an edge location, a regional edge cache or an Origin Shield holds, and the fetches in flight
 * for objects it does not hold.
 *
 * An object is just its number (the key space cut into `objects` slices), so an entry is a few numbers and the cache
 * is one `Map`. It is bounded: inserting past `capacity` evicts, and the cache never holds more than that however
 * many distinct keys arrive.
 */

/** What a cache holds for one object. */
export class Entry {
  /** The status of a cached error (404, 502...), or 0 for the object itself. */
  constructor(
    public expires: number,
    readonly status: number,
    /** Last moment a stale copy may be served when the origin is failing (stale-if-error). */
    readonly staleLimit: number
  ) {}

  /** Set when the entry is requested; eviction gives a requested entry a second chance. */
  referenced = false
}

/** A fetch in flight for one object. Requests that arrive meanwhile wait on it (request collapsing). */
export class Pending<W> {
  readonly waiters: Array<W> = []
  constructor(readonly startedAt: number) {}
}

export class Layer<W> {
  readonly entries = new Map<number, Entry>()
  readonly pending = new Map<number, Pending<W>>()
  evictions = 0

  /**
   * Keep an entry, evicting down to `capacity`. A `Map` iterates in insertion order, so the front is the oldest;
   * an entry requested since it was inserted is moved to the back once instead of being evicted (CLOCK, the usual
   * cheap approximation of least-recently-used). A hit therefore costs a lookup and a flag, never a reorder.
   */
  put(id: number, entry: Entry, capacity: number): void {
    const { entries } = this
    // Delete first so a refreshed object goes to the back of the line, not the slot its expired copy held.
    entries.delete(id)
    entries.set(id, entry)
    if (entries.size <= capacity) return
    // Two passes at most: the first clears every second-chance flag it meets, the second evicts.
    while (entries.size > capacity) {
      const oldest = entries.entries().next().value as [number, Entry]
      const [key, held] = oldest
      entries.delete(key)
      if (held.referenced && key !== id) {
        held.referenced = false
        entries.set(key, held)
      } else {
        this.evictions++
      }
    }
  }

  /** Drop the objects an invalidation covers: all of them, or the given share (spread evenly over the objects). */
  invalidate(share: number): void {
    if (share >= 1) return this.entries.clear()
    if (share <= 0) return
    for (const key of this.entries.keys()) if (spread(key) < share) this.entries.delete(key)
  }
}

/** A fixed, even scatter of object numbers over [0, 1), so "a share of the objects" is the same objects every time. */
const spread = (id: number): number => (Math.imul(id + 1, 2654435761) >>> 0) / 4294967296
