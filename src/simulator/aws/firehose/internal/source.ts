import { Duration } from "effect"
import type * as Connector from "../../../Connector.ts"
import * as Edge from "../../../Edge.ts"
import { Tally } from "../../../kit/Tally.ts"
import type { Message } from "../../../Message.ts"
import type { Counter } from "../../../Telemetry.ts"
import type { TimerHandle } from "../../../VirtualTime.ts"
import { before, type Cursor, type Lag, lagMeter, type StreamModel, type Subscription } from "../../kinesis/Readers.ts"
import { KINESIS_POLL_MS } from "./config.ts"
import { fromKinesis } from "./marker.ts"

/**
 * Firehose's reading of a Kinesis stream, for the source connector (`KinesisSource.ts`): one subscription to the stream,
 * a place per shard, and the hand-over of what it read to the Firehose stream, kept and offered again while Firehose
 * refuses it.
 */

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

/** One Firehose stream's subscription to a Kinesis stream. */
export class Source {
  private readonly sub: Subscription<Place>
  private readonly counts: { records: Tally; bytes: Tally; refused: Tally; throttled: Counter }

  constructor(private readonly ctx: Context, private readonly stream: StreamModel) {
    this.counts = {
      records: new Tally(ctx.meter.counter("records")),
      bytes: new Tally(ctx.meter.counter("bytes")),
      refused: new Tally(ctx.meter.counter("refused")),
      // ThrottledGetRecords: its GetRecords calls the shard's read limits refused (other consumers share them).
      throttled: ctx.meter.counter("throttledGetRecords")
    }
    this.sub = stream.subscribe<Place>({
      name: ctx.id,
      efo: () => false,
      pollMs: KINESIS_POLL_MS,
      catchUp: false,
      start: (cursor) => ({ taken: cursor.fetched, sending: false, retry: undefined, base: before(cursor), done: 0 }),
      wake: (cursor) => this.hand(cursor),
      lag: (now) => this.lag(now),
      readThrottled: () => this.counts.throttled.n++
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
        this.counts.refused.add(records)
        place.retry = this.ctx.fast.after(KINESIS_POLL_MS, this.onRetry, cursor)
        return
      }
      this.counts.records.add(records)
      this.counts.bytes.add(bytes)
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

  /** KinesisMillisBehindLatest and the backlog: the oldest record not yet taken by Firehose, and how many there are. */
  readonly lag: (now: number) => Lag = lagMeter(() => this.sub, (cursor) => {
    const shard = cursor.shard
    const from = cursor.active ? Math.max(cursor.local.taken, shard.first) : shard.first
    const s = shard.at(from)
    return s !== undefined && from < shard.sealed ? s.at : Number.POSITIVE_INFINITY
  })

  state() {
    const lag = this.lag(this.ctx.fast.now())
    const { records, bytes, refused } = this.counts
    return { shards: this.sub.reading, behindMs: lag.ageMs, backlog: lag.records, totals: { records: records.total, bytes: bytes.total, refused: refused.total } }
  }
}
