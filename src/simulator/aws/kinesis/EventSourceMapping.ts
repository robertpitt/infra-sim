import { Duration, Effect, Schema } from "effect"
import * as Connector from "../../Connector.ts"
import * as Edge from "../../Edge.ts"
import { type CallFailure, Failed, type ItemFailures, itemFailures, type Message } from "../../Message.ts"
import type { Counter } from "../../Telemetry.ts"
import {
  DISCARD_RECORD_BYTES,
  GET_RECORDS_MAX_RECORDS,
  LAMBDA_INVOKE_TIMEOUT_MS,
  LAMBDA_MAX_BATCH_BYTES,
  LAMBDA_POLL_MS,
  Mapping,
  type MappingConfig,
  MIN_RECORD_AGE_S,
  SOURCES
} from "./config.ts"
import { mappingDashboard } from "./dashboard.ts"
import { type Batch, collect, cut, type Lane, lowest, newLanes, oldestIn, poisonIn, type ShardWork } from "./lanes.ts"
import { laneCount } from "./log.ts"
import { streamOf } from "./pull.ts"
import { before, type Cursor, type Lag, type Subscription } from "./readers.ts"
import type { StreamModel } from "./stream.ts"

/**
 * Lambda's event source mapping for a Kinesis stream: the connector on the edge from a stream's `consumers` port to a
 * function (or anything that takes calls).
 *
 * What it models (with-kinesis, services-kinesis-parameters, kinesis-on-failure-destination):
 *  - one poller per shard, reading with GetRecords at a base rate of once a second and at once while it is behind, so
 *    it shares the shard's 2 MiB/s and five calls a second with every other standard reader; or, with enhanced fan-out,
 *    records pushed through a registered consumer with 2 MiB/s per shard of its own;
 *  - batches of up to the batch size and 6 MB, held for the batching window if one is set;
 *  - a parallelization factor: up to ten batches of a shard at once, the shard split by key into lanes so records of one
 *    partition key stay in order;
 *  - a failed batch blocks its lane (the whole shard with a factor of 1): it is retried until it succeeds, is older than
 *    the maximum record age, has used its retries, or expires from the stream; then its metadata goes to the stream's
 *    on-failure destination and the lane moves on. Bisect-on-error splits a failing batch until the bad record is
 *    alone. A throttled invocation is retried without using up retries;
 *  - with ReportBatchItemFailures, a reply naming failed records checkpoints before the first of them and retries from
 *    there; without it the reply counts as success;
 *  - IteratorAge: how old the oldest record not yet processed is, the metric that shows a consumer falling behind.
 */

/** A synchronous Invoke waits for the function: its own timeout (15 minutes at most) ends a slow batch first. */
const INVOKE = Edge.within(LAMBDA_INVOKE_TIMEOUT_MS)

type Context = Connector.Context<MappingConfig, "pull">

export const KinesisMapping = Connector.make({
  type: "aws.kinesis.event-source-mapping",
  provider: "aws",
  title: "Event source mapping (Kinesis)",
  description:
    "Lambda's poller between a Kinesis stream and a function: one poller per shard, batches in order, a parallelization factor, and a failing batch that blocks its shard until it succeeds, is split, or is discarded to the stream's on-failure destination.",
  icon: "reload",
  docs: SOURCES.lambda,
  from: { protocol: "pull", component: "aws.kinesis", port: "consumers" },
  // Lambda's poller: a fleet (an ECS service, an Auto Scaling group) reads a stream with workers of its own (core.poller).
  to: { protocol: "invoke", fleets: false },
  dashboard: mappingDashboard,
  config: Mapping,
  state: Schema.Struct({
    /** Shards this mapping is reading now. */
    shards: Schema.Number,
    /** Batches being invoked or retried. */
    inflight: Schema.Number,
    /** Age of the oldest record not yet processed (IteratorAge), ms. */
    iteratorAge: Schema.Number,
    /** Records written and not yet processed. */
    backlog: Schema.Number,
    /** Records in batches that have failed and are being retried: a blocked shard shows here. */
    blocked: Schema.Number,
    /** Reading through enhanced fan-out; refused when the stream already has 20 registered consumers. */
    enhancedFanOut: Schema.Boolean,
    refused: Schema.Boolean,
    totals: Schema.Struct({
      batches: Schema.Number,
      records: Schema.Number,
      retries: Schema.Number,
      bisected: Schema.Number,
      discarded: Schema.Number,
      expired: Schema.Number,
      itemFailures: Schema.Number
    })
  }),
  make: (ctx) =>
    Effect.sync(() => {
      const stream = streamOf(ctx.source)
      // The connector only fits a Kinesis stream's port, so this is always one; a source that isn't reads nothing.
      if (stream === undefined) return {}
      const mapping = new KinesisPoller(ctx, stream)
      ctx.meter.gaugeUnsafe("iteratorAge", () => mapping.lag(ctx.fast.now()).ageMs)
      ctx.meter.gaugeUnsafe("backlog", () => mapping.lag(ctx.fast.now()).records)
      ctx.meter.gaugeUnsafe("concurrency", () => mapping.inflight)
      // The most batches it can have in flight: a lane per shard and parallelization factor.
      ctx.meter.gaugeUnsafe("maxConcurrency", () => mapping.lanes())
      ctx.meter.gaugeUnsafe("blocked", () => mapping.blocked())
      ctx.meter.gaugeUnsafe("batchSize", () => ctx.fast.settings().batchSize)
      return { probe: Effect.sync(() => mapping.state()) }
    })
})

/** Counters on the edge's meter, beside transport's own; and running totals for the probe. */
const counts = (ctx: Context) => {
  const c = (name: string) => ({ rate: ctx.meter.counter(name), total: 0 })
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

const bump = (m: { rate: Counter; total: number }, n = 1): void => {
  m.rate.n += n
  m.total += n
}

class KinesisPoller {
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
      limit: () => GET_RECORDS_MAX_RECORDS,
      start: (cursor) => ({ lanes: newLanes(cursor.fetched, ctx.fast.settings().parallelization), base: before(cursor), done: 0 }),
      wake: (cursor) => this.drive(cursor),
      lag: (now) => this.lag(now),
      read: (records) => bump(this.counts.polled, records)
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
        bump(this.counts.expired, lost)
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
    bump(this.counts.batches)
    bump(this.counts.invoked, batch.count)
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
        bump(this.counts.poison)
        if (c.reportBatchItemFailures) items = itemFailures([Math.min(at, ...(items?.failed ?? [at]))])
        else failure = Failed({ node: this.ctx.to, reason: "poison record" })
      }
    }
    if (failure === undefined) {
      if (items !== undefined && items.failed.length > 0) {
        if (c.reportBatchItemFailures) return this.partial(cursor, lane, batch, items, c)
        bump(this.counts.itemFailuresIgnored, items.failed.length)
      }
      lane.queue.shift()
      this.processed(cursor, batch.count)
      return this.drive(cursor)
    }
    bump(this.counts.failedInvoke, batch.count)
    const now = this.ctx.fast.now()
    if (this.tooOld(batch, now, c)) {
      lane.queue.shift()
      this.discard(cursor, batch)
      return this.drive(cursor)
    }
    if (failure._tag === "Throttled" || failure._tag === "Unavailable") {
      // The function never ran: retried until the records are too old, without using up retries.
      bump(this.counts.throttledInvokes)
      batch.throttles++
      return this.backoff(cursor, lane, batch.throttles, c)
    }
    if (c.bisectOnError && batch.count > 1) {
      bump(this.counts.bisected)
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
    bump(this.counts.itemFailures, batch.count - first)
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
    bump(this.counts.retries)
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
    bump(this.counts.discarded, batch.count)
    cursor.local.done += batch.count
    this.stream.discard({
      ...this.ctx.fast.mint({ count: 1, bytes: DISCARD_RECORD_BYTES, group: cursor.shard.name, invocation: "async", operation: "write" }),
      bornAt: batch.born
    })
  }

  private processed(cursor: Cursor<ShardWork>, records: number): void {
    bump(this.counts.records, records)
    cursor.local.done += records
  }

  // ---- what it reports ---------------------------------------------------------------------------------------

  /** IteratorAge and the backlog: the oldest record not yet processed, over every shard; and how many there are. */
  lag(now: number): Lag {
    // Several gauges ask at each frame: work it out once an instant.
    if (now === this.lagAt) return this.lagWas
    this.lagAt = now
    this.lagWas = this.measure(now)
    return this.lagWas
  }

  private lagAt = -1
  private lagWas: Lag = { ageMs: 0, records: 0 }

  private measure(now: number): Lag {
    let oldest = now
    let records = 0
    for (const cursor of this.sub.cursors.values()) {
      if (cursor.finished) continue
      const shard = cursor.shard
      if (!cursor.active) {
        // A child shard waiting for its parents: everything in it is still to do.
        records += shard.total
        const s = shard.at(shard.first)
        if (s !== undefined && s.at < oldest) oldest = s.at
        continue
      }
      const work = cursor.local
      records += Math.max(0, shard.total - work.base - work.done)
      const waiting = oldestIn(cursor)
      if (waiting < oldest) oldest = waiting
      const unread = shard.at(Math.max(cursor.fetched, shard.first))
      if (unread !== undefined && cursor.fetched < shard.sealed && unread.at < oldest) oldest = unread.at
    }
    return { ageMs: now - oldest, records }
  }

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
    let shards = 0
    for (const _ of this.sub.active()) shards++
    const t = this.counts
    return {
      shards,
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
