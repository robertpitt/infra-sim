import type { Message } from "../../../Message.ts"
import type { Lease, LeasedRecord, Pull, PullTraits } from "../../../Protocol.ts"
import type { TimerHandle } from "../../../VirtualTime.ts"
import type { Lag } from "../Readers.ts"
import { GENERIC_LEASE_MS, GET_RECORDS_MAX_RECORDS } from "./config.ts"
import { bornAt } from "./log.ts"
import { before, type Cursor, lagOf, type Subscription } from "./readers.ts"
import type { StreamModel } from "./stream.ts"

/**
 * The stream as its `consumers` port offers it.
 *
 * Connectors made for Kinesis (Lambda's event source mapping, Firehose's source) reach the stream itself through
 * `streamOf` and read it their own way: one subscription each, with a cursor per shard. Anything else wired to the port
 * (a `core.poller` chosen on the edge) sees a generic `Pull`: one shared consumer, like a Kinesis Client Library
 * application, that hands out a shard's records in order, one lease per shard at a time. An acknowledged lease is a
 * checkpoint; a failed or abandoned one is offered again from the same place after a while, as a restarted worker
 * resumes from its last checkpoint.
 */
export class StreamPull implements Pull {
  readonly traits: PullTraits = { ordered: true, maxTake: GET_RECORDS_MAX_RECORDS }
  private sub: Subscription<Place> | undefined
  private readonly listeners: Array<() => void> = []
  /** Where the next `take` starts looking, so shards are served in turn. */
  private turn = 0

  constructor(
    readonly stream: StreamModel,
    private readonly env: {
      readonly now: () => number
      readonly after: <A>(ms: number, fire: (arg: A) => void, arg: A) => TimerHandle
      readonly mint: (init: Partial<Pick<Message, "bytes" | "count" | "group" | "key" | "invocation" | "operation">>) => Message
    }
  ) {}

  /** The generic consumer registers on first use, so a stream nobody reads this way keeps nothing for it. */
  private ensure(): Subscription<Place> {
    this.sub ??= this.stream.subscribe<Place>({
      name: "consumers",
      efo: () => false,
      pollMs: 1_000,
      catchUp: true,
      start: (cursor) => ({ seg: cursor.fetched, off: 0, lease: undefined, receives: 1, base: before(cursor), done: 0 }),
      wake: (cursor) => this.settle(cursor),
      sealed: () => this.wake(),
      lag: (now) => this.lag(now)
    })
    return this.sub
  }

  take(max: number, bytes: number): Lease | undefined {
    const sub = this.ensure()
    const cursors = [...sub.active()]
    for (let i = 0; i < cursors.length; i++) {
      const cursor = cursors[(this.turn + i) % cursors.length]!
      const place = cursor.local
      if (place.lease !== undefined) continue
      const lease = this.lease(cursor, Math.max(1, max), bytes)
      if (lease === undefined) {
        sub.want(cursor)
        continue
      }
      this.turn = (this.turn + i + 1) % cursors.length
      return lease
    }
    return undefined
  }

  available(): boolean {
    const sub = this.ensure()
    for (const cursor of sub.active()) {
      if (cursor.local.lease !== undefined) continue
      if (cursor.shard.sealed > cursor.fetched || this.hasRecords(cursor)) return true
    }
    return false
  }

  backlog(): number {
    return this.lag(this.env.now()).records
  }

  ready(listener: () => void): () => void {
    this.listeners.push(listener)
    return () => {
      const i = this.listeners.indexOf(listener)
      if (i >= 0) this.listeners.splice(i, 1)
    }
  }

  /** Empty receives aren't counted for a stream: an idle reader's GetRecords calls are already counted. */
  idle(): void {}

  private wake(): void {
    for (const listener of this.listeners.slice()) listener()
  }

  /** Records fetched or a shard closed: finish a shard read to its end, and let takers look. */
  private settle(cursor: Cursor<Place>): void {
    const place = cursor.local
    if (cursor.exhausted && place.lease === undefined && !this.hasRecords(cursor)) this.sub!.finish(cursor)
    this.wake()
  }

  private hasRecords(cursor: Cursor<Place>): boolean {
    const shard = cursor.shard
    const place = cursor.local
    for (let seg = Math.max(place.seg, shard.first); seg < cursor.fetched; seg++) {
      if (shard.at(seg)!.count > (seg === place.seg ? place.off : 0)) return true
    }
    return false
  }

  /** A lease over the cursor's next records, at most `max` of them and `limit` bytes (at least one record). */
  private lease(cursor: Cursor<Place>, max: number, limit: number): Lease | undefined {
    const shard = cursor.shard
    const place = cursor.local
    let seg = Math.max(place.seg, shard.first)
    let off = seg === place.seg ? place.off : 0
    let count = 0
    let bytes = 0
    let born = Number.POSITIVE_INFINITY
    while (seg < cursor.fetched && count < max) {
      const s = shard.at(seg)!
      if (off >= s.count) {
        seg++
        off = 0
        continue
      }
      const per = s.bytes / s.count
      let take = Math.min(s.count - off, max - count)
      if (count > 0 && bytes + take * per > limit) take = Math.floor((limit - bytes) / per)
      if (take <= 0) break
      if (count === 0) born = bornAt(s, s.count > 1 ? off / (s.count - 1) : 0)
      count += take
      bytes += take * per
      off += take
    }
    if (count === 0) {
      place.seg = seg
      place.off = off
      return undefined
    }
    const message = { ...this.env.mint({ count, bytes, key: (shard.lo + shard.hi) / 2, group: shard.name, invocation: "sync", operation: "write" }), bornAt: born }
    const lease = new ShardLease(this, cursor, count, bytes, message, place.receives, { seg, off })
    place.lease = lease
    lease.expiry = this.env.after(GENERIC_LEASE_MS, expire, lease)
    return lease
  }

  /** @internal A lease ended: checkpoint after it, or leave the records to be offered again. */
  end(lease: ShardLease, ok: boolean): void {
    const cursor = lease.cursor
    const place = cursor.local
    if (place.lease !== lease) return
    place.lease = undefined
    lease.expiry?.cancel()
    if (ok) {
      place.seg = lease.to.seg
      place.off = lease.to.off
      place.receives = 1
      place.done += lease.count
      this.sub!.release(cursor, place.seg)
    } else {
      place.receives++
    }
    this.settle(cursor)
  }

  private lag(now: number): Lag {
    if (this.sub === undefined) return { ageMs: 0, records: 0 }
    return lagOf(this.sub, now, this.oldest)
  }

  /** The arrival of the oldest record not yet checkpointed in the cursor's shard. */
  private readonly oldest = (cursor: Cursor<Place>): number => {
    const shard = cursor.shard
    const seg = cursor.active ? cursor.local.seg : shard.first
    const s = shard.at(Math.max(seg, shard.first))
    return s !== undefined && (!cursor.active || seg < shard.sealed) ? s.at : Number.POSITIVE_INFINITY
  }
}

/** The generic consumer's place in one shard. */
interface Place {
  seg: number
  off: number
  lease: ShardLease | undefined
  /** How many times the records at this place have been handed out. */
  receives: number
  readonly base: number
  done: number
}

class ShardLease implements Lease {
  expiry: TimerHandle | undefined
  private readonly record: LeasedRecord

  constructor(
    readonly pull: StreamPull,
    readonly cursor: Cursor<Place>,
    readonly count: number,
    readonly bytes: number,
    message: Message,
    receives: number,
    readonly to: { readonly seg: number; readonly off: number }
  ) {
    this.record = { message, bytes: bytes / count, receives }
  }

  /** Every record shares one description: they are interchangeable, and a batch of them allocates nothing. */
  each(visit: (record: LeasedRecord) => void): void {
    if (this.cursor.local.lease !== this) return
    for (let i = 0; i < this.count; i++) visit(this.record)
  }

  /** A checkpoint after the lease, unless a record failed: then the whole lease is offered again. */
  ack(keep?: ReadonlySet<LeasedRecord>): void {
    this.pull.end(this, keep === undefined || keep.size === 0)
  }
}

const expire = (lease: ShardLease): void => {
  lease.expiry = undefined
  lease.pull.end(lease, false)
}

/** The stream behind a pull source, when the source is a Kinesis stream's port (`Readers.streamOf`). */
export const streamOf = (source: Pull): StreamModel | undefined => (source instanceof StreamPull ? source.stream : undefined)
