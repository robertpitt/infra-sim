import type { Bucket, Entry } from "./types.ts"

/** Messages are filed by the second they were enqueued in. Retention is at least a minute, so a second is fine resolution. */
const BUCKET_MS = 1_000

/**
 * Every message in the queue, filed by enqueue time, so the two things that must look at "the oldest messages" never scan
 * the whole queue:
 *
 *  - the retention sweep deletes messages older than the retention period: it walks the buckets from the oldest and
 *    stops at the first that is still young, so a sweep costs what it expires and nothing more;
 *  - ApproximateAgeOfOldestMessage is read from the first bucket that holds anything countable.
 *
 * Buckets form a list in time order. Messages arrive in order nearly always, so a new bucket goes on the end; the one
 * exception is a message a standard queue's redrive policy moved here, which keeps its original (older) enqueue time and
 * is filed back from the end to where it belongs. A message leaves its bucket in O(1) (swap with the last one), which
 * is what a delete costs, so a queue that is drained as fast as it fills holds no memory beyond what is in it.
 */
export class RetentionIndex {
  private readonly byKey = new Map<number, Bucket>()
  private head: Bucket | undefined
  private tail: Bucket | undefined

  /** The bucket for a message enqueued at `t`, created (and linked in order) if it is the first of its second. */
  bucketFor(t: number): Bucket {
    const key = Math.floor(t / BUCKET_MS)
    const found = this.byKey.get(key)
    if (found !== undefined) return found
    const bucket: Bucket = { key, items: [], aged: 0, minAt: Infinity, prev: undefined, next: undefined }
    this.byKey.set(key, bucket)
    let after = this.tail
    while (after !== undefined && after.key > key) after = after.prev
    if (after === undefined) {
      bucket.next = this.head
      if (this.head !== undefined) this.head.prev = bucket
      this.head = bucket
      if (this.tail === undefined) this.tail = bucket
    } else {
      bucket.prev = after
      bucket.next = after.next
      if (after.next !== undefined) after.next.prev = bucket
      else this.tail = bucket
      after.next = bucket
    }
    return bucket
  }

  /** File an entry (already created with `bucket` from `bucketFor`). */
  insert(entry: Entry): void {
    const b = entry.bucket
    entry.slot = b.items.length
    b.items.push(entry)
    if (entry.enqueuedAt < b.minAt) b.minAt = entry.enqueuedAt
    if (entry.aged) b.aged++
  }

  remove(entry: Entry): void {
    const b = entry.bucket
    const last = b.items.pop()!
    if (last !== entry) {
      b.items[entry.slot] = last
      last.slot = entry.slot
    }
    if (entry.aged) {
      b.aged--
      entry.aged = false
    }
    if (b.items.length === 0) this.unlink(b)
  }

  /** Whether the entry counts towards the age of the oldest message. */
  setAged(entry: Entry, aged: boolean): void {
    if (entry.aged === aged) return
    entry.aged = aged
    entry.bucket.aged += aged ? 1 : -1
  }

  private unlink(b: Bucket): void {
    this.byKey.delete(b.key)
    if (b.prev !== undefined) b.prev.next = b.next
    else this.head = b.next
    if (b.next !== undefined) b.next.prev = b.prev
    else this.tail = b.prev
  }

  /** Call `expire` for every message enqueued at or before `cutoff`. `expire` must remove the entry from this index. */
  sweep(cutoff: number, expire: (entry: Entry) => void): void {
    let b = this.head
    while (b !== undefined && b.key * BUCKET_MS <= cutoff) {
      const next = b.next
      if ((b.key + 1) * BUCKET_MS - 1 <= cutoff) {
        while (b.items.length > 0) expire(b.items[b.items.length - 1]!)
      } else {
        for (const e of b.items.filter((x) => x.enqueuedAt <= cutoff)) expire(e)
      }
      b = next
    }
  }

  /** Enqueue time of the oldest message that counts towards the age gauge (to the second), if any. */
  oldestAt(): number | undefined {
    for (let b = this.head; b !== undefined; b = b.next) if (b.aged > 0) return b.minAt
    return undefined
  }

  /** The first `n` entries in age order, for the probe. */
  first(n: number): Array<Entry> {
    const out: Array<Entry> = []
    for (let b = this.head; b !== undefined && out.length < n; b = b.next) {
      for (let i = 0; i < b.items.length && out.length < n; i++) out.push(b.items[i]!)
    }
    return out
  }
}
