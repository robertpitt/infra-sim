import type { Counter } from "../../../Telemetry.ts"
import { HASH_SLOTS } from "./config.ts"

/**
 * The key space and what one shard holds.
 *
 * A key is just its number (the application's key space cut into `keys` slices), so an entry is an expiry and a flag,
 * and a shard's data is one `Map`. Memory is counted in keys: every value has the configured size, so a shard holds
 * `capacity` keys before it must evict, and the map never grows past that however many keys arrive.
 */

/** maxmemory-policy, as numbers so the hot path compares integers. */
export const ALLKEYS_LRU = 0
export const VOLATILE_LRU = 1
export const NOEVICTION = 2
export const POLICIES = { "allkeys-lru": ALLKEYS_LRU, "volatile-lru": VOLATILE_LRU, noeviction: NOEVICTION } as const

/** How many keys from the front of a shard one second's active expiry looks at (Redis samples; this is its stand-in). */
const ACTIVE_EXPIRE_BUDGET = 200

/** The key a request is for, from its key hash in [0, 1). Skew above 1 piles requests onto the low numbers. */
export const keyOf = (hash: number, keys: number, skew: number): number => {
  let u = hash >= 0 ? (hash < 1 ? hash : 0.999999999999) : 0
  if (skew !== 1) u = u ** skew
  const id = Math.floor(u * keys)
  return id < keys ? id : keys - 1
}

/**
 * The hash slot of a key. Valkey and Redis OSS take CRC16 of the key name mod 16,384; this takes the top 14 bits of a
 * multiplicative hash of the key's number, which scatters neighbouring (and equally popular) keys over the slots the
 * same way. Memcached clients hash keys over nodes with a consistent hash; the same scatter stands in for it.
 */
export const slotOf = (key: number): number => (Math.imul(key + 1, 2654435761) >>> 0) >>> 18

/** The shard that owns a slot: ElastiCache spreads the slots evenly, as contiguous ranges (0-8191, 8192-16383...). */
export const shardOfSlot = (slot: number, shards: number): number => Math.min(shards - 1, Math.floor((slot * shards) / HASH_SLOTS))

/**
 * What the shards have evicted, expired and refused, together: totals for the probe, and the node's counters for the
 * frames. One tally is shared by every shard and survives resharding.
 */
export class Tally {
  evictions = 0
  expired = 0
  oom = 0
  constructor(private readonly counters?: { readonly evictions: Counter; readonly expired: Counter; readonly oom: Counter }) {}

  evicted(): void {
    this.evictions++
    if (this.counters !== undefined) this.counters.evictions.n++
  }
  expiredOne(): void {
    this.expired++
    if (this.counters !== undefined) this.counters.expired.n++
  }
  refused(): void {
    this.oom++
    if (this.counters !== undefined) this.counters.oom.n++
  }
}

/** What a shard holds for one key. */
export class Entry {
  /** Set when the key is read or written; eviction gives such a key a second chance. */
  referenced = false
  constructor(
    /** When its TTL runs out, or `Infinity` for a key without one (which volatile-lru may not evict). */
    public expires: number
  ) {}
}

export class Store {
  readonly entries = new Map<number, Entry>()
  /** Keys with a TTL: what volatile-lru may evict. */
  volatile = 0

  constructor(readonly tally: Tally = new Tally()) {}

  get size(): number {
    return this.entries.size
  }

  /** GET: the entry if it is there and fresh. A key found expired is deleted on the spot (lazy expiry). */
  get(key: number, now: number): Entry | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    if (entry.expires <= now) {
      this.remove(key, entry)
      this.tally.expiredOne()
      return undefined
    }
    entry.referenced = true
    return entry
  }

  /**
   * SET with an expiry. A new key needs room: past `capacity` the policy decides what goes, and when nothing may go the
   * SET fails with OOM (`false`), as Valkey and Redis OSS answer "OOM command not allowed when used memory > maxmemory".
   */
  set(key: number, expires: number, capacity: number, policy: number, now: number): boolean {
    const held = this.entries.get(key)
    if (held !== undefined) {
      this.retime(held, expires)
      held.referenced = true
      return true
    }
    // A value bigger than the whole memory never fits.
    if (capacity < 1 || (this.entries.size >= capacity && !this.makeRoom(capacity - 1, policy, now))) {
      this.tally.refused()
      return false
    }
    this.entries.set(key, new Entry(expires))
    if (expires !== Infinity) this.volatile++
    return true
  }

  /** DEL. */
  delete(key: number): void {
    const entry = this.entries.get(key)
    if (entry !== undefined) this.remove(key, entry)
  }

  /** FLUSHALL, or a node that came back empty. */
  clear(): void {
    this.entries.clear()
    this.volatile = 0
  }

  /**
   * Evict down to `target` keys. A `Map` iterates in insertion order, so the front holds the keys set longest ago; one
   * requested since is moved to the back once instead of evicted (CLOCK, a cheap least-recently-used, as Redis's own
   * LRU is an approximation by sampling). A key whose TTL has passed is reclaimed whatever the policy. When the policy
   * leaves nothing evictable (noeviction, or volatile-lru with no key that has a TTL) only an expired key at the front
   * can go, so a full cache answers OOM at once instead of scanning every key.
   */
  makeRoom(target: number, policy: number, now: number): boolean {
    const { entries } = this
    const stuck = policy === NOEVICTION || (policy === VOLATILE_LRU && this.volatile === 0)
    let budget = stuck ? 1 : 2 * entries.size + 1
    while (entries.size > target && budget-- > 0) {
      const [key, entry] = entries.entries().next().value as [number, Entry]
      if (entry.expires <= now) {
        this.remove(key, entry)
        this.tally.expiredOne()
        continue
      }
      if (stuck) break
      const evictable = policy === ALLKEYS_LRU || entry.expires !== Infinity
      entries.delete(key)
      if (evictable && !entry.referenced) {
        if (entry.expires !== Infinity) this.volatile--
        this.tally.evicted()
        continue
      }
      entry.referenced = false
      entries.set(key, entry)
    }
    return entries.size <= target
  }

  /**
   * Active expiry: delete expired keys among the oldest few, as Redis's periodic job does by sampling, so memory is not
   * held by keys nobody reads again. It looks at a bounded number of keys a second, so its cost stays flat.
   */
  sweep(now: number): void {
    let budget = ACTIVE_EXPIRE_BUDGET
    for (const [key, entry] of this.entries) {
      if (budget-- <= 0) break
      if (entry.expires <= now) {
        this.remove(key, entry)
        this.tally.expiredOne()
      }
    }
  }

  private retime(entry: Entry, expires: number): void {
    if (entry.expires === Infinity && expires !== Infinity) this.volatile++
    else if (entry.expires !== Infinity && expires === Infinity) this.volatile--
    entry.expires = expires
  }

  private remove(key: number, entry: Entry): void {
    this.entries.delete(key)
    if (entry.expires !== Infinity) this.volatile--
  }
}
