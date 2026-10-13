import { Duration, SubscriptionRef } from "effect"
import type { Fast } from "../../../Component.ts"
import type * as Edge from "../../../Edge.ts"
import type { CallFailure, Message } from "../../../Message.ts"
import type { Counter } from "../../../Telemetry.ts"
import type { TimerHandle } from "../../../VirtualTime.ts"
import { STREAM_BATCH_MAX_BYTES, STREAM_POLL_MS, STREAM_RETENTION_MS, type StreamConsumer } from "./config.ts"

/**
 * DynamoDB Streams, and the event source mapping that reads them.
 *
 * What AWS says (Streams, with-ddb, services-ddb-params, services-dynamodb-errors):
 *  - a stream holds every item change for 24 hours, in order per item, each record exactly once;
 *  - each open shard belongs to exactly one table partition, and shards are added as partitions are;
 *  - Lambda polls each shard four times a second when idle, invokes the function synchronously with a batch and, when
 *    that succeeds, polls again at once; a failing batch is retried until it succeeds, expires, or runs out of retries,
 *    and meanwhile nothing behind it in the shard is read ("a bad record can block processing on the affected shard for
 *    up to one day"); a consumer can read each shard concurrently (ParallelizationFactor) up to 10 batches;
 *  - at most two readers should read one shard (more may be throttled).
 *
 * What is modelled: a write appends a record to the shard of the partition it landed on; records are kept as segments
 * (one per shard per 100 ms), not objects, so a busy table costs a few words a second; every consumer wired to the
 * stream port has its own cursor in each shard and reads it the way the event source mapping does. The Lambda component
 * has no event source mapping for streams yet, so the port does the polling and calls the function with `link.send`.
 */

/** Settings of one consumer, as the port's edge carries them. */
export type ConsumerConfig = Edge.Config & typeof StreamConsumer.Type
export type ConsumerLink = Edge.Link<ConsumerConfig>
type DiscardLink = Edge.Link<Edge.Config>

/** Records written to one shard within a short span, which become readable together. */
interface Segment {
  /** When the first record was appended, for retention and the age of a record. */
  readonly at: number
  /** When it can be read: append time plus the stream's propagation delay. */
  readonly readyAt: number
  count: number
  bytes: number
  /** Creation time of the oldest message in it, so a consumer's end-to-end age is right. */
  born: number
}

/** The records one invocation carries. */
interface Batch {
  count: number
  bytes: number
  born: number
  /** When its oldest record entered the stream: the record age that `maxRecordAge` and the 24 hours measure. */
  firstAt: number
  /** Failed attempts so far. */
  attempts: number
}

class Shard {
  private segments: Array<Segment> = []
  /** Absolute index of `segments[0]`; cursors are absolute so trimming the front never moves them. */
  private offset = 0
  private head = 0
  /** Records appended, ever. */
  total = 0

  /** Absolute index one past the newest segment: where a reader that starts now begins (LATEST). */
  get end(): number {
    return this.offset + this.segments.length
  }

  at(abs: number): Segment | undefined {
    return this.segments[abs - this.offset]
  }

  get live(): number {
    return this.segments.length - this.head
  }

  /** Add records to the shard; ones close together join the last segment. Returns the segment they went into. */
  append(now: number, delay: () => number, count: number, bytes: number, born: number): Segment {
    this.total += count
    const last = this.segments[this.segments.length - 1]
    if (last !== undefined && now - last.at < SEGMENT_MS && this.segments.length > this.head) {
      last.count += count
      last.bytes += bytes
      if (born < last.born) last.born = born
      return last
    }
    const segment: Segment = { at: now, readyAt: now + delay(), count, bytes, born }
    this.segments.push(segment)
    return segment
  }

  /** Forget everything before `abs`: every reader is past it. */
  drop(abs: number): void {
    this.head = Math.min(this.segments.length, Math.max(this.head, abs - this.offset))
    if (this.head > 512 && this.head * 2 > this.segments.length) {
      this.segments = this.segments.slice(this.head)
      this.offset += this.head
      this.head = 0
    }
  }
}

/**
 * Records appended within this long of a segment's first join it: below the 250 ms poll interval a consumer can't tell
 * them apart, and it keeps a busy shard to a handful of segments a second.
 */
const SEGMENT_MS = 100

/** One consumer's position in one shard, and what it has in flight. */
class Reader {
  abs: number
  off = 0
  inflight = 0
  /** Records handed out or expired, so `shard.total - taken` is what is still to read. */
  taken = 0
  timer: TimerHandle | undefined
  /** True when `timer` is the end of a batching window rather than a poll. */
  windowed = false
  /** Records still missing from a full batch while a window is open. */
  missing = 0
  readonly held = new Set<Batch>()
  readonly retries = new Set<TimerHandle>()

  constructor(readonly stream: Stream, readonly consumer: number, readonly index: number, readonly shard: Shard) {
    this.abs = shard.end
  }
}

export interface StreamCounters {
  readonly appended: Counter
  readonly delivered: Counter
  readonly batches: Counter
  readonly failedBatches: Counter
  readonly discarded: Counter
  readonly expired: Counter
}

export interface StreamDeps {
  readonly fast: Fast<unknown>
  readonly consumers: ReadonlyArray<ConsumerLink>
  readonly discards: ReadonlyArray<DiscardLink>
  readonly counters: StreamCounters
}

export class Stream {
  /** Running totals for probes: the meter's counters reset every frame, these never do. */
  readonly totals = { appended: 0, delivered: 0, discarded: 0, expired: 0 }
  private readonly shards = new Map<number, Shard>()
  private readonly readers: Array<Map<number, Reader>>

  constructor(private readonly deps: StreamDeps) {
    this.readers = deps.consumers.map(() => new Map())
  }

  get consumers(): number {
    return this.deps.consumers.length
  }

  /** Append `count` records of `bytes` to the shard of partition `shard`; `delay` draws the propagation delay of a new segment. */
  append(shard: number, count: number, bytes: number, born: number, delay: () => number): void {
    const { fast, counters } = this.deps
    let s = this.shards.get(shard)
    if (s === undefined) this.shards.set(shard, (s = new Shard()))
    const now = fast.now()
    // A consumer first seeing a shard starts at its end, so create it before this record is added.
    for (let i = 0; i < this.readers.length; i++) if (!this.readers[i]!.has(shard)) this.readers[i]!.set(shard, new Reader(this, i, shard, s))
    const segment = s.append(now, delay, count, bytes, born)
    counters.appended.n += count
    this.totals.appended += count
    for (const map of this.readers) this.kick(map.get(shard)!, count, Math.max(0, segment.readyAt - now))
  }

  /** Records waiting to be read by the slowest consumer, including ones not yet readable. */
  backlog(): number {
    let worst = 0
    for (const map of this.readers) {
      let sum = 0
      for (const r of map.values()) sum += r.shard.total - r.taken
      if (sum > worst) worst = sum
    }
    return worst
  }

  /** Records sitting in batches that have failed and are being retried: a blocked shard shows here. */
  blocked(): number {
    let sum = 0
    for (const map of this.readers) for (const r of map.values()) for (const b of r.held) if (b.attempts > 0) sum += b.count
    return sum
  }

  /** Age of the oldest record not yet processed, over every consumer and shard (IteratorAge). */
  iteratorAge(now: number): number {
    let oldest = now
    for (const map of this.readers) {
      for (const r of map.values()) {
        const next = r.shard.at(r.abs)
        if (next !== undefined && r.off < next.count && next.at < oldest) oldest = next.at
        for (const b of r.held) if (b.firstAt < oldest) oldest = b.firstAt
      }
    }
    return now - oldest
  }

  get shardCount(): number {
    return this.shards.size
  }

  /** Segments held across all shards. */
  segmentCount(): number {
    let sum = 0
    for (const s of this.shards.values()) sum += s.live
    return sum
  }

  /** Stop every timer: the simulation is ending. */
  cancelAll(): void {
    for (const map of this.readers) {
      for (const r of map.values()) {
        r.timer?.cancel()
        r.timer = undefined
        for (const t of r.retries) t.cancel()
        r.retries.clear()
      }
    }
  }

  // ---- polling -------------------------------------------------------------------------------------------------

  private config(reader: Reader): ConsumerConfig {
    return SubscriptionRef.getUnsafe(this.deps.consumers[reader.consumer]!.config)
  }

  /** New records arrived for `reader`: look for them at the next poll, or tell a waiting window they are here. */
  private kick(reader: Reader, count: number, wait: number): void {
    if (reader.timer !== undefined) {
      if (reader.windowed) {
        reader.missing -= count
        if (reader.missing <= 0) {
          reader.timer.cancel()
          reader.timer = undefined
          reader.windowed = false
          this.drive(reader)
        }
      }
      return
    }
    if (reader.inflight >= this.config(reader).parallelization) return
    // An idle consumer notices new records at its next poll, somewhere in the next 250 ms.
    this.arm(reader, wait + this.deps.fast.random.nextDoubleUnsafe() * STREAM_POLL_MS, false)
  }

  private arm(reader: Reader, ms: number, windowed: boolean): void {
    reader.windowed = windowed
    reader.timer = this.deps.fast.after(ms, onTimer, reader)
  }

  /** Hand out batches while there are records and free lanes. */
  drive(reader: Reader): void {
    const { fast } = this.deps
    const config = this.config(reader)
    const now = fast.now()
    this.skipExpired(reader, now)
    while (reader.inflight < config.parallelization) {
      this.skipRead(reader)
      const next = reader.shard.at(reader.abs)
      if (next === undefined || reader.off >= next.count) return
      if (next.readyAt > now) {
        if (reader.timer === undefined) this.arm(reader, next.readyAt - now, false)
        return
      }
      const taken = this.collect(reader, config, now)
      const batch = taken.batch
      const window = Duration.toMillis(config.batchWindow)
      if (window > 0 && batch.count < config.batchSize && batch.bytes < STREAM_BATCH_MAX_BYTES && now < next.readyAt + window) {
        // A window is open and the batch isn't full: wait for it to fill or to close, whichever comes first.
        reader.missing = config.batchSize - batch.count
        if (reader.timer === undefined) this.arm(reader, next.readyAt + window - now, true)
        return
      }
      this.commit(reader, taken)
      reader.inflight++
      this.send(reader, batch)
    }
  }

  /** Read what is readable from the cursor, without moving it: up to a full batch, within 6 MB. */
  private collect(reader: Reader, config: ConsumerConfig, now: number): { batch: Batch; abs: number; off: number } {
    let abs = reader.abs
    let off = reader.off
    let count = 0
    let bytes = 0
    let born = Infinity
    let firstAt = Infinity
    while (count < config.batchSize) {
      let seg = reader.shard.at(abs)
      // A segment read to its end is left behind, unless it is the newest: later records can still join that one.
      if (seg !== undefined && off >= seg.count && abs + 1 < reader.shard.end) {
        abs++
        off = 0
        seg = reader.shard.at(abs)
      }
      if (seg === undefined || off >= seg.count || seg.readyAt > now) break
      const perRecord = seg.bytes / seg.count
      let take = Math.min(seg.count - off, config.batchSize - count)
      // A batch stops growing at the payload limit, but always carries at least one record.
      if (count > 0 && bytes + take * perRecord > STREAM_BATCH_MAX_BYTES) take = Math.floor((STREAM_BATCH_MAX_BYTES - bytes) / perRecord)
      if (take <= 0) break
      count += take
      bytes += take * perRecord
      if (seg.born < born) born = seg.born
      if (seg.at < firstAt) firstAt = seg.at
      off += take
      if (bytes >= STREAM_BATCH_MAX_BYTES) break
    }
    return { batch: { count, bytes, born, firstAt, attempts: 0 }, abs, off }
  }

  private commit(reader: Reader, taken: { batch: Batch; abs: number; off: number }): void {
    reader.abs = taken.abs
    reader.off = taken.off
    reader.taken += taken.batch.count
    reader.held.add(taken.batch)
  }

  /** Move the cursor past segments it has read to the end, as far as the newest one (which may still grow). */
  private skipRead(reader: Reader): void {
    for (;;) {
      const seg = reader.shard.at(reader.abs)
      if (seg === undefined || reader.off < seg.count || reader.abs + 1 >= reader.shard.end) return
      reader.abs++
      reader.off = 0
    }
  }

  /** Records older than the stream keeps are gone: skip them, counting them lost. */
  private skipExpired(reader: Reader, now: number): void {
    for (;;) {
      const seg = reader.shard.at(reader.abs)
      if (seg === undefined || now - seg.at <= STREAM_RETENTION_MS) return
      const lost = seg.count - reader.off
      reader.taken += lost
      this.deps.counters.expired.n += lost
      this.totals.expired += lost
      reader.abs++
      reader.off = 0
    }
  }

  private send(reader: Reader, batch: Batch): void {
    const { fast, counters } = this.deps
    const link = this.deps.consumers[reader.consumer]!
    counters.batches.n++
    const message: Message = {
      ...fast.mint({ count: batch.count, bytes: batch.bytes, key: (reader.index * 0.6180339887) % 1, group: `shard-${reader.index}`, invocation: "sync", operation: "write" }),
      bornAt: batch.born
    }
    link.send(message, (failure) => this.settle(reader, batch, failure))
  }

  /** The function answered for `batch`: move on, or retry, split or give up. */
  private settle(reader: Reader, batch: Batch, failure: CallFailure | undefined): void {
    const { fast, counters } = this.deps
    if (failure === undefined) {
      reader.inflight--
      reader.held.delete(batch)
      counters.delivered.n += batch.count
      this.totals.delivered += batch.count
      this.release(reader)
      return this.drive(reader)
    }
    counters.failedBatches.n++
    const config = this.config(reader)
    const now = fast.now()
    const age = now - batch.firstAt
    const expired = age >= STREAM_RETENTION_MS
    const tooOld = config.maxRecordAge >= 0 && age > config.maxRecordAge * 1000
    if (config.bisectOnError && batch.count > 1 && !expired && !tooOld) {
      // Two smaller batches, each with a fresh retry allowance: splitting doesn't use up retries.
      const half = Math.floor(batch.count / 2)
      const a: Batch = { ...batch, count: half, bytes: (batch.bytes * half) / batch.count, attempts: 0 }
      const b: Batch = { ...batch, count: batch.count - half, bytes: batch.bytes - a.bytes, attempts: 0 }
      reader.held.delete(batch)
      reader.held.add(a)
      reader.held.add(b)
      reader.inflight++
      this.send(reader, a)
      return this.send(reader, b)
    }
    batch.attempts++
    if (expired || tooOld || (config.maxRetries >= 0 && batch.attempts > config.maxRetries)) {
      this.discard(reader, batch, expired)
      reader.inflight--
      this.release(reader)
      return this.drive(reader)
    }
    // The shard (or this lane of it) stays blocked on the batch until it goes through.
    const base = Duration.toMillis(config.retryBackoff)
    const wait = Math.min(Duration.toMillis(config.maxRetryBackoff), base * 2 ** (batch.attempts - 1))
    const pending: Retry = { reader, batch, timer: undefined }
    pending.timer = fast.after(wait, onRetry, pending)
    reader.retries.add(pending.timer)
  }

  retry({ reader, batch, timer }: Retry): void {
    if (timer !== undefined) reader.retries.delete(timer)
    this.send(reader, batch)
  }

  /** Records that will never be delivered: dropped by the mapping's limits, or aged out of the stream. */
  private discard(reader: Reader, batch: Batch, expired: boolean): void {
    const { fast, counters, discards } = this.deps
    reader.held.delete(batch)
    ;(expired ? counters.expired : counters.discarded).n += batch.count
    if (expired) this.totals.expired += batch.count
    else this.totals.discarded += batch.count
    // The on-failure destination hears about the batch (its metadata, not the records), asynchronously.
    for (const link of discards) {
      link.send({ ...fast.mint({ count: 1, bytes: 1_024, invocation: "async", operation: "write" }), bornAt: batch.born })
    }
  }

  /** Free segments every consumer is past. */
  private release(reader: Reader): void {
    let until = reader.abs
    for (const map of this.readers) {
      const other = map.get(reader.index)
      if (other !== undefined && other.abs < until) until = other.abs
    }
    reader.shard.drop(until)
  }
}

const onTimer = (reader: Reader): void => {
  reader.timer = undefined
  reader.windowed = false
  reader.stream.drive(reader)
}

/** A failed batch waiting out its backoff. */
interface Retry {
  readonly reader: Reader
  readonly batch: Batch
  timer: TimerHandle | undefined
}

const onRetry = (pending: Retry): void => pending.reader.stream.retry(pending)
