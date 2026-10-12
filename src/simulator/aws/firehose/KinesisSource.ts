import { Duration, Effect, Schema } from "effect"
import * as Connector from "../../Connector.ts"
import * as Edge from "../../Edge.ts"
import type { Message } from "../../Message.ts"
import type { Counter } from "../../Telemetry.ts"
import type { TimerHandle } from "../../VirtualTime.ts"
import { GET_RECORDS_MAX_RECORDS } from "../kinesis/config.ts"
import { streamOf } from "../kinesis/pull.ts"
import { before, type Cursor, type Lag, type Subscription } from "../kinesis/readers.ts"
import type { StreamModel } from "../kinesis/stream.ts"
import { KINESIS_POLL_MS, SOURCES } from "./config.ts"
import { fromKinesis } from "./marker.ts"

/**
 * A Firehose stream reading a Kinesis data stream (a "Kinesis Data Streams as source" stream): the connector a wire
 * from a stream's `consumers` port to a Firehose stream gets.
 *
 * As AWS describes it (writing-with-kinesis-streams): Firehose starts at LATEST and calls GetRecords once a second on
 * each shard, a standard consumer sharing the shard's 2 MiB/s and five calls a second with everyone else. What it reads
 * goes into a buffer per shard. If Firehose can't take it (its delivery for that shard is failing) the records are kept
 * and offered again a second later, so they stay in the stream, KinesisMillisBehindLatest grows, and nothing is lost
 * until the stream's retention runs out.
 */
export const KinesisSource = Connector.make({
  type: "aws.firehose.kinesis-source",
  provider: "aws",
  title: "Firehose source (Kinesis)",
  description: "Firehose reading a Kinesis stream: GetRecords once a second per shard from LATEST, sharing the shard's read limits with other standard consumers, into a buffer per shard.",
  icon: "reload",
  docs: SOURCES.kinesisSource,
  from: { protocol: "pull", component: "aws.kinesis", port: "consumers" },
  to: { protocol: "invoke", component: "aws.firehose" },
  config: Schema.Struct({}),
  state: Schema.Struct({
    /** Shards being read. */
    shards: Schema.Number,
    /** KinesisMillisBehindLatest: age of the oldest record read or still to read and not yet taken by Firehose. */
    behindMs: Schema.Number,
    /** Records written and not yet taken by Firehose. */
    backlog: Schema.Number,
    totals: Schema.Struct({ records: Schema.Number, bytes: Schema.Number, refused: Schema.Number })
  }),
  make: (ctx) =>
    Effect.sync(() => {
      const stream = streamOf(ctx.source)
      // The connector only fits a Kinesis stream's port; anything else reads nothing.
      if (stream === undefined) return {}
      const source = new Source(ctx, stream)
      ctx.meter.gaugeUnsafe("millisBehindLatest", () => source.lag(ctx.fast.now()).ageMs)
      ctx.meter.gaugeUnsafe("backlog", () => source.lag(ctx.fast.now()).records)
      return { probe: Effect.sync(() => source.state()) }
    })
})

/** One call to Firehose: a GetRecords' worth, handed over once (a failed hand-over is offered again). */
const HAND_OVER = Edge.within(60_000)

/** Firehose's place in one shard: records below `fetched` and from `taken` on are read but not yet taken by Firehose. */
interface Place {
  taken: number
  sending: boolean
  retry: TimerHandle | undefined
  readonly base: number
  done: number
}

type Context = Connector.Context<Record<string, never>, "pull">

class Source {
  private readonly sub: Subscription<Place>
  private readonly counts: { records: Counter; bytes: Counter; refused: Counter }
  private readonly totals = { records: 0, bytes: 0, refused: 0 }

  constructor(private readonly ctx: Context, private readonly stream: StreamModel) {
    this.counts = {
      records: ctx.meter.counter("records"),
      bytes: ctx.meter.counter("bytes"),
      refused: ctx.meter.counter("refused")
    }
    this.sub = stream.subscribe<Place>({
      name: ctx.id,
      efo: () => false,
      pollMs: KINESIS_POLL_MS,
      catchUp: false,
      limit: () => GET_RECORDS_MAX_RECORDS,
      start: (cursor) => ({ taken: cursor.fetched, sending: false, retry: undefined, base: before(cursor), done: 0 }),
      wake: (cursor) => this.hand(cursor),
      lag: (now) => this.lag(now)
    })
  }

  /** Hand what has been read to Firehose, or ask for more. */
  private hand(cursor: Cursor<Place>): void {
    const place = cursor.local
    if (cursor.finished || place.sending || place.retry !== undefined) return
    const shard = cursor.shard
    const cutoff = this.ctx.fast.now() - Duration.toMillis(this.stream.retention())
    let records = 0
    let bytes = 0
    let born = Number.POSITIVE_INFINITY
    for (let seg = Math.max(place.taken, shard.first); seg < cursor.fetched; seg++) {
      const s = shard.at(seg)!
      if (s.at <= cutoff && records === 0) {
        // Past the stream's retention before Firehose took it: lost.
        this.stream.expired(s.count)
        place.done += s.count
        place.taken = seg + 1
        continue
      }
      records += s.count
      bytes += s.bytes
      if (s.born < born) born = s.born
    }
    if (records === 0) {
      place.taken = cursor.fetched
      this.sub.release(cursor, place.taken)
      if (cursor.exhausted) return this.sub.finish(cursor)
      return this.sub.want(cursor)
    }
    const message: Message = {
      ...this.ctx.fast.mint({ count: records, bytes, key: (shard.lo + shard.hi) / 2, group: `${this.ctx.from}/${shard.name}`, invocation: "sync", operation: "write" }),
      bornAt: born
    }
    fromKinesis.add(message)
    const upTo = cursor.fetched
    place.sending = true
    this.ctx.sink.call(message, HAND_OVER, (failure) => {
      place.sending = false
      if (failure !== undefined) {
        // Kept: offered again at the next read, a second from now.
        this.counts.refused.n += records
        this.totals.refused += records
        place.retry = this.ctx.fast.after(KINESIS_POLL_MS, this.onRetry, cursor)
        return
      }
      this.counts.records.n += records
      this.counts.bytes.n += bytes
      this.totals.records += records
      this.totals.bytes += bytes
      place.done += records
      place.taken = upTo
      this.sub.release(cursor, upTo)
      this.hand(cursor)
    })
  }

  private readonly onRetry = (cursor: Cursor<Place>): void => {
    cursor.local.retry = undefined
    this.hand(cursor)
  }

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
      const from = cursor.active ? Math.max(cursor.local.taken, shard.first) : shard.first
      const s = shard.at(from)
      if (s !== undefined && from < shard.sealed && s.at < oldest) oldest = s.at
      records += cursor.active ? Math.max(0, shard.total - cursor.local.base - cursor.local.done) : shard.total
    }
    return { ageMs: now - oldest, records }
  }

  state() {
    const lag = this.lag(this.ctx.fast.now())
    let shards = 0
    for (const _ of this.sub.active()) shards++
    return { shards, behindMs: lag.ageMs, backlog: lag.records, totals: { ...this.totals } }
  }
}
