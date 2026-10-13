import { Duration } from "effect"
import type * as Connector from "../../../Connector.ts"
import * as Edge from "../../../Edge.ts"
import { type CallFailure, Failed, type ItemFailures, itemFailures, type Message } from "../../../Message.ts"
import { Tally } from "../../../kit/Tally.ts"
import type { Lag } from "../Readers.ts"
import { DISCARD_RECORD_BYTES, LAMBDA_INVOKE_TIMEOUT_MS, LAMBDA_MAX_BATCH_BYTES, LAMBDA_POLL_MS, type MappingConfig, MIN_RECORD_AGE_S } from "./config.ts"
import { type Batch, collect, cut, type Lane, lowest, newLanes, oldestIn, poisonIn, type ShardWork } from "./lanes.ts"
import { laneCount } from "./log.ts"
import { before, type Cursor, lagMeter, type Subscription } from "./readers.ts"
import type { StreamModel } from "./stream.ts"

/**
 * Lambda's poller over a Kinesis stream, for the event source mapping connector (`EventSourceMapping.ts`): a
 * subscription to the stream whose shards are cut into lanes (`lanes.ts`), each sending one batch at a time to the
 * function, and what happens to a batch that fails.
 */

/** A synchronous Invoke waits for the function: its own timeout (15 minutes at most) ends a slow batch first. */
const INVOKE = Edge.within(LAMBDA_INVOKE_TIMEOUT_MS)

type Context = Connector.Context<MappingConfig, "pull">

/** Counters on the edge's meter, beside transport's own; and running totals for the probe. */
const counts = (ctx: Context) => {
  const c = (name: string) => new Tally(ctx.meter.counter(name))
  return {
    batches: c("batches"),
    records: c("records"),
    retries: c("batchRetries"),
    bisected: c("bisected"),
    discarded: c("discarded"),
    expired: c("expired"),
    itemFailures: c("itemFailures"),
    itemFailuresIgnored: c("itemFailuresIgnored"),
    throttledInvokes: c("throttledInvokes"),
    poison: c("poisonFailures"),
    // Lambda's event source mapping metrics: records read from the stream (PolledEventCount), sent to the function (a
    // batch retried counts again: InvokedEventCount), and in invocations that failed (FailedInvokeEventCount).
    polled: c("polledEvents"),
    invoked: c("invokedEvents"),
    failedInvoke: c("failedInvokeEvents")
  }
}

/** One mapping: its subscription to the stream, the lanes of each shard, and what it counts. */
export class KinesisPoller {
  private readonly sub: Subscription<ShardWork>
  private readonly counts: ReturnType<typeof counts>
  inflight = 0

  constructor(private readonly ctx: Context, private readonly stream: StreamModel) {
    this.counts = counts(ctx)
    this.sub = stream.subscribe<ShardWork>({
      name: ctx.id,
      efo: () => ctx.fast.settings().enhancedFanOut,
      pollMs: LAMBDA_POLL_MS,
      catchUp: true,
      start: (cursor) => ({ lanes: newLanes(cursor.fetched, ctx.fast.settings().parallelization), base: before(cursor), done: 0 }),
      wake: (cursor) => this.drive(cursor),
      lag: (now) => this.lag(now),
      read: (records) => this.counts.polled.add(records)
    })
  }

  // ---- reading -----------------------------------------------------------------------------------------------

  /** Records arrived for a shard, or something finished: start what can be started. */
  private drive(cursor: Cursor<ShardWork>): void {
    if (cursor.finished) return
    const c = this.ctx.fast.settings()
    const work = cursor.local
    if (work.lanes.length !== c.parallelization && !this.relane(cursor, c.parallelization)) {
      // A new factor waits for the shard's lanes to be idle: they finish the batches they hold but take nothing new, so a
      // mapping that is behind still gets there (Lambda applies a change to the mapping between batches).
      for (const lane of work.lanes) if (lane.queue.length > 0) this.driveLane(cursor, lane, c)
      this.sub.release(cursor, lowest(work))
      return
    }
    let hungry = false
    for (const lane of work.lanes) if (this.driveLane(cursor, lane, c)) hungry = true
    this.sub.release(cursor, lowest(work))
    if (!cursor.exhausted) {
      if (hungry) this.sub.want(cursor)
      return
    }
    // A closed shard read to its end: once every lane is done with it, its children can be read.
    for (const lane of work.lanes) if (lane.inflight || lane.queue.length > 0 || lane.seg < cursor.fetched) return
    this.sub.finish(cursor)
  }

  /**
   * Start the lane's next batch if it can. Returns true when the lane is waiting for records it hasn't got (so the
   * shard should be read), false when it is busy.
   */
  private driveLane(cursor: Cursor<ShardWork>, lane: Lane, c: MappingConfig): boolean {
    if (lane.inflight || lane.wait !== undefined) return false
    if (lane.queue.length > 0) {
      this.send(cursor, lane, lane.queue[0]!)
      return false
    }
    const now = this.ctx.fast.now()
    this.skipExpired(cursor, lane, now)
    this.skipTooOld(cursor, lane, now, c)
    const taken = collect(cursor, lane, c.batchSize)
    if (taken.count === 0) {
      lane.seg = taken.seg
      lane.off = taken.off
      return true
    }
    const window = Duration.toMillis(c.batchWindow)
    const full = taken.count >= c.batchSize || taken.bytes >= LAMBDA_MAX_BATCH_BYTES
    if (window > 0 && !full && !cursor.exhausted) {
      if (lane.gatherSince < 0) lane.gatherSince = now
      const due = lane.gatherSince + window
      if (now < due) {
        lane.window ??= this.ctx.fast.after(due - now, this.onWindow, { cursor, lane })
        return true
      }
    }
    lane.window?.cancel()
    lane.window = undefined
    lane.gatherSince = -1
    lane.seg = taken.seg
    lane.off = taken.off
    const batch: Batch = { count: taken.count, bytes: taken.bytes, born: taken.born, firstAt: taken.firstAt, lastAt: taken.lastAt, ordinal: lane.ordinal, attempts: 0, throttles: 0 }
    lane.ordinal += taken.count
    if (batch.bytes > LAMBDA_MAX_BATCH_BYTES) {
      // A single record over Lambda's 6 MB payload can't be invoked at all: it goes to the on-failure destination.
      this.discard(cursor, batch)
      return this.driveLane(cursor, lane, c)
    }
    lane.queue.push(batch)
    this.send(cursor, lane, batch)
    return false
  }

  private readonly onWindow = ({ cursor, lane }: { cursor: Cursor<ShardWork>; lane: Lane }): void => {
    lane.window = undefined
    this.drive(cursor)
  }

  /** Records older than the stream keeps are gone before this lane read them: skip them, counting them lost. */
  private skipExpired(cursor: Cursor<ShardWork>, lane: Lane, now: number): void {
    const shard = cursor.shard
    const cutoff = now - Duration.toMillis(this.stream.retention())
    const lanes = cursor.local.lanes.length
    for (;;) {
      if (lane.seg < shard.first) {
        lane.seg = shard.first
        lane.off = 0
      }
      if (lane.seg >= cursor.fetched) return
      const s = shard.at(lane.seg)!
      if (s.at > cutoff) return
      const lost = Math.max(0, laneCount(s, lane.index, lanes) - lane.off)
      if (lost > 0) {
        this.counts.expired.add(lost)
        this.stream.expired(lost)
        cursor.local.done += lost
        lane.ordinal += lost
      }
      lane.seg++
      lane.off = 0
    }
  }

  /**
   * Records older than the maximum record age aren't sent to the function at all ("the maximum age of a record that
   * Lambda sends to your function"): a mapping that has fallen behind skips them, and the on-failure destination hears
   * of each run it skipped. Whole segments only: the newest record of the segment is past the age.
   */
  private skipTooOld(cursor: Cursor<ShardWork>, lane: Lane, now: number, c: MappingConfig): void {
    if (c.maxRecordAge < 0) return
    const cutoff = now - Math.max(c.maxRecordAge, MIN_RECORD_AGE_S) * 1000
    const shard = cursor.shard
    const lanes = cursor.local.lanes.length
    let skipped = 0
    let born = Number.POSITIVE_INFINITY
    while (lane.seg < cursor.fetched) {
      const s = shard.at(lane.seg)!
      if (s.last > cutoff) break
      const n = Math.max(0, laneCount(s, lane.index, lanes) - lane.off)
      skipped += n
      if (n > 0 && s.born < born) born = s.born
      lane.seg++
      lane.off = 0
    }
    if (skipped === 0) return
    lane.ordinal += skipped
    this.discard(cursor, { count: skipped, bytes: 0, born, firstAt: cutoff, lastAt: cutoff, ordinal: lane.ordinal - skipped, attempts: 0, throttles: 0 })
  }

  /**
   * A new parallelization factor: once every lane of the shard is idle, the shard is cut into the new number of lanes,
   * all starting where the slowest lane was (records some lanes had passed are read again: at-least-once). False while
   * a lane still holds a batch.
   */
  private relane(cursor: Cursor<ShardWork>, n: number): boolean {
    const work = cursor.local
    for (const lane of work.lanes) if (lane.inflight || lane.queue.length > 0 || lane.wait !== undefined) return false
    for (const lane of work.lanes) lane.window?.cancel()
    work.lanes = newLanes(lowest(work), n)
    return true
  }

  // ---- invoking ----------------------------------------------------------------------------------------------

  private send(cursor: Cursor<ShardWork>, lane: Lane, batch: Batch): void {
    lane.inflight = true
    this.inflight++
    this.counts.batches.add(1)
    this.counts.invoked.add(batch.count)
    const shard = cursor.shard
    const lanes = cursor.local.lanes.length
    const message: Message = {
      ...this.ctx.fast.mint({
        count: batch.count,
        bytes: batch.bytes,
        // A key inside the lane's slice of the shard's range, so whatever the function writes on is spread as the stream was.
        key: shard.lo + ((lane.index + 0.5) / lanes) * (shard.hi - shard.lo),
        group: shard.name,
        invocation: "sync",
        operation: "write"
      }),
      bornAt: batch.born,
      batched: true
    }
    this.ctx.sink.call(message, INVOKE, (failure, items) => this.outcome(cursor, lane, batch, failure, items))
  }

  /** The function answered for `batch`, the head of its lane. */
  private outcome(cursor: Cursor<ShardWork>, lane: Lane, batch: Batch, failure: CallFailure | undefined, items: ItemFailures | undefined): void {
    lane.inflight = false
    this.inflight--
    const c = this.ctx.fast.settings()
    if (failure === undefined && c.poisonRecords > 0) {
      // The function can't process a poison record: it throws, or with batch item failures it reports the record.
      const at = poisonIn(lane, batch, c.poisonRecords, this.ctx.fast.random)
      if (at >= 0) {
        this.counts.poison.add(1)
        if (c.reportBatchItemFailures) items = itemFailures([Math.min(at, ...(items?.failed ?? [at]))])
        else failure = Failed({ node: this.ctx.to, reason: "poison record" })
      }
    }
    if (failure === undefined) {
      if (items !== undefined && items.failed.length > 0) {
        if (c.reportBatchItemFailures) return this.partial(cursor, lane, batch, items, c)
        this.counts.itemFailuresIgnored.add(items.failed.length)
      }
      lane.queue.shift()
      this.processed(cursor, batch.count)
      return this.drive(cursor)
    }
    this.counts.failedInvoke.add(batch.count)
    const now = this.ctx.fast.now()
    if (this.tooOld(batch, now, c)) {
      lane.queue.shift()
      this.discard(cursor, batch)
      return this.drive(cursor)
    }
    if (failure._tag === "Throttled" || failure._tag === "Unavailable") {
      // The function never ran: retried until the records are too old, without using up retries.
      this.counts.throttledInvokes.add(1)
      batch.throttles++
      return this.backoff(cursor, lane, batch.throttles, c)
    }
    if (c.bisectOnError && batch.count > 1) {
      this.counts.bisected.add(1)
      const [a, b] = cut(batch, Math.floor(batch.count / 2))
      lane.queue.splice(0, 1, a, b)
      this.send(cursor, lane, a)
      return
    }
    batch.attempts++
    if (c.maxRetries >= 0 && batch.attempts > c.maxRetries) {
      lane.queue.shift()
      this.discard(cursor, batch)
      return this.drive(cursor)
    }
    this.backoff(cursor, lane, batch.attempts, c)
  }

  /** A reply naming failed records: checkpoint before the first of them, and retry the rest of the batch from there. */
  private partial(cursor: Cursor<ShardWork>, lane: Lane, batch: Batch, items: ItemFailures, c: MappingConfig): void {
    let first = batch.count
    for (const i of items.failed) if (i >= 0 && i < first) first = i
    if (first >= batch.count) {
      // The positions named nothing in the batch: as good as an empty list, a complete success.
      lane.queue.shift()
      this.processed(cursor, batch.count)
      return this.drive(cursor)
    }
    this.counts.itemFailures.add(batch.count - first)
    const [done, rest] = first > 0 ? cut(batch, first) : [undefined, batch]
    if (done !== undefined) this.processed(cursor, done.count)
    rest.attempts = batch.attempts + 1
    lane.queue[0] = rest
    if (this.tooOld(rest, this.ctx.fast.now(), c) || (c.maxRetries >= 0 && rest.attempts > c.maxRetries)) {
      lane.queue.shift()
      this.discard(cursor, rest)
      return this.drive(cursor)
    }
    this.backoff(cursor, lane, rest.attempts, c)
  }

  /** Whether a failing batch is past the maximum record age, or past the stream's retention. */
  private tooOld(batch: Batch, now: number, c: MappingConfig): boolean {
    const age = now - batch.firstAt
    if (age > Duration.toMillis(this.stream.retention())) return true
    return c.maxRecordAge >= 0 && age > Math.max(c.maxRecordAge, MIN_RECORD_AGE_S) * 1000
  }

  /** Wait before trying the lane's head batch again: the backoff doubles with each attempt, up to the cap. */
  private backoff(cursor: Cursor<ShardWork>, lane: Lane, attempt: number, c: MappingConfig): void {
    this.counts.retries.add(1)
    const base = Duration.toMillis(c.retryBackoff)
    const wait = Math.min(Duration.toMillis(c.maxRetryBackoff), base * 2 ** Math.max(0, attempt - 1))
    lane.wait = this.ctx.fast.after(wait, this.onRetry, { cursor, lane })
  }

  private readonly onRetry = ({ cursor, lane }: { cursor: Cursor<ShardWork>; lane: Lane }): void => {
    lane.wait = undefined
    this.drive(cursor)
  }

  /** Records given up on: the on-failure destination hears of the batch (its metadata, not its records). */
  private discard(cursor: Cursor<ShardWork>, batch: Batch): void {
    this.counts.discarded.add(batch.count)
    cursor.local.done += batch.count
    this.stream.discard({
      ...this.ctx.fast.mint({ count: 1, bytes: DISCARD_RECORD_BYTES, group: cursor.shard.name, invocation: "async", operation: "write" }),
      bornAt: batch.born
    })
  }

  private processed(cursor: Cursor<ShardWork>, records: number): void {
    this.counts.records.add(records)
    cursor.local.done += records
  }

  // ---- what it reports ---------------------------------------------------------------------------------------

  /** IteratorAge and the backlog: the oldest record not yet processed, over every shard; and how many there are. */
  readonly lag: (now: number) => Lag = lagMeter(() => this.sub, (cursor) => {
    const shard = cursor.shard
    // A child shard waiting for its parents: everything in it is still to do.
    if (!cursor.active) return shard.at(shard.first)?.at ?? Number.POSITIVE_INFINITY
    let oldest = oldestIn(cursor)
    const unread = shard.at(Math.max(cursor.fetched, shard.first))
    if (unread !== undefined && cursor.fetched < shard.sealed && unread.at < oldest) oldest = unread.at
    return oldest
  })

  /** Lanes across the shards it reads: the most batches it can have in flight at once. */
  lanes(): number {
    let n = 0
    for (const cursor of this.sub.active()) n += cursor.local.lanes.length
    return n
  }

  /** Records in batches that have failed at least once. */
  blocked(): number {
    let n = 0
    for (const cursor of this.sub.active()) for (const lane of cursor.local.lanes) for (const b of lane.queue) if (b.attempts > 0 || b.throttles > 0) n += b.count
    return n
  }

  state() {
    const now = this.ctx.fast.now()
    const lag = this.lag(now)
    const t = this.counts
    return {
      shards: this.sub.reading,
      inflight: this.inflight,
      iteratorAge: lag.ageMs,
      backlog: lag.records,
      blocked: this.blocked(),
      enhancedFanOut: this.stream.efoOf(this.sub),
      refused: this.stream.efoRefused(this.sub),
      totals: {
        batches: t.batches.total,
        records: t.records.total,
        retries: t.retries.total,
        bisected: t.bisected.total,
        discarded: t.discarded.total,
        expired: t.expired.total,
        itemFailures: t.itemFailures.total
      }
    }
  }
}
