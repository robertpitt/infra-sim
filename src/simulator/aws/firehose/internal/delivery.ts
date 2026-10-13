import { Duration } from "effect"
import type { Fast } from "../../../Component.ts"
import type { Link } from "../../../Edge.ts"
import type { Tally } from "../../../kit/Tally.ts"
import type { Limiter } from "../../../Limiter.ts"
import { type CallFailure, type ItemFailures, type Message, Rejected, Throttled } from "../../../Message.ts"
import type { Counter, Sampler } from "../../../Telemetry.ts"
import type { Account } from "../../internal/account.ts"
import { type Chunk, type Delivery, keyOf, Lane } from "./buffers.ts"
import {
  BATCH_MAX_BYTES,
  BATCH_MAX_RECORDS,
  type DeliveryConfig,
  DIRECT_PUT_RETENTION_MS,
  directPutBase,
  ERROR_RECORD_OVERHEAD,
  HTTP_MAX_BUFFER_MIB,
  HTTP_MAX_RECORDS,
  MAX_BUFFER_MIB,
  MAX_RECORD_BYTES,
  RETRY_INITIAL_MS,
  RETRY_JITTER,
  RETRY_MAX_MS,
  TRANSFORM_CONCURRENCY,
  TRANSFORM_RETRY_MS,
  ZERO_BUFFER_MS
} from "./config.ts"
import { MiB } from "../../internal/units.ts"
import { fromKinesis } from "./marker.ts"

/**
 * What a Firehose stream does with the records it is given: buffer them, optionally hand them to a transformation
 * Lambda, and deliver each buffer as one object (or one HTTP request), retrying until it lands.
 *
 * Records are counts, not objects: a buffer is a few numbers (records, bytes, the oldest record's arrival and birth).
 * Records from a Direct PUT share one buffer; records read from a Kinesis stream are buffered per source shard, because
 * Firehose applies its buffering hints per shard. Each buffer (a "lane") delivers one object at a time, in order: while
 * one fails and is retried, what comes after keeps gathering, and buffers that are ready meanwhile are merged (up to the
 * largest buffer size), which is how Firehose "raises the buffer size dynamically to catch up".
 */

export type FirehoseTallies = Record<
  | "incoming"
  | "incomingBytes"
  | "putRequests"
  | "throttled"
  | "rejected"
  | "refusedFromStream"
  | "delivered"
  | "deliveredBytes"
  | "objects"
  | "deliveryFailed"
  | "transformInvocations"
  | "transformFailed"
  | "transformedRecords"
  | "processingFailed"
  | "backedUp"
  | "backupFailed"
  | "lost",
  Tally
>

export interface EngineEnv {
  readonly id: string
  readonly region: string
  readonly fast: Fast<DeliveryConfig>
  readonly limiter: Limiter
  readonly out: Link | undefined
  readonly transform: Link | undefined
  readonly backup: Link | undefined
  readonly tallies: FirehoseTallies
  /** Transformation invocations that succeeded (over all of them, ExecuteProcessing.Success) and how long each took (ExecuteProcessing.Duration). */
  readonly transformSucceeded: Counter
  readonly transformDuration: Sampler
}

const DIRECT = "direct-put"

export class Engine {
  private readonly lanes = new Map<string, Lane>()
  /** Set once the stream has been fed by a Kinesis source: from then on PutRecord is refused. */
  kinesisSource = false
  /** Set once a Direct PUT has been accepted: the Direct PUT throughput quota applies to this stream. */
  directPut = false
  /** The size of the last object (or HTTP request) delivered: deliveries are minutes apart, so a rate of them reads poorly. */
  lastObjectBytes = 0
  private readonly key: number

  constructor(private readonly env: EngineEnv) {
    this.key = keyOf(env.id)
  }

  // ---- ingestion -----------------------------------------------------------------------------------------------

  /** PutRecord / PutRecordBatch, or records read from a Kinesis stream. */
  accept(message: Message): CallFailure | undefined {
    const { fast, tallies } = this.env
    const records = message.count >= 1 ? Math.floor(message.count) : 0
    if (records === 0) return undefined
    const bytes = message.bytes > 0 ? message.bytes : 0
    let lane: Lane
    if (fromKinesis.has(message)) {
      this.kinesisSource = true
      lane = this.lane(message.group ?? "kinesis")
      // While a delivery is failing Firehose holds back from reading more: the records stay in the stream.
      if (lane.failing) {
        tallies.refusedFromStream.add(records)
        return Throttled({ node: this.env.id, reason: "delivery is failing; Firehose stops reading the source shard" })
      }
    } else {
      if (this.kinesisSource) {
        tallies.rejected.add(records)
        return Rejected({ node: this.env.id, reason: "PutRecord is disabled on a Firehose stream whose source is a Kinesis data stream" })
      }
      if (records > BATCH_MAX_RECORDS || bytes > BATCH_MAX_BYTES) {
        tallies.rejected.add(records)
        return Rejected({ node: this.env.id, reason: "PutRecordBatch takes at most 500 records and 4 MiB" })
      }
      if (bytes / records > MAX_RECORD_BYTES) {
        tallies.rejected.add(records)
        return Rejected({ node: this.env.id, reason: "record over 1,000 KiB" })
      }
      if (!this.withinQuota(records, bytes)) {
        tallies.throttled.add(records)
        return Throttled({ node: this.env.id, reason: "ServiceUnavailableException: Direct PUT throughput exceeded" })
      }
      tallies.putRequests.add(1)
      this.directPut = true
      lane = this.lane(DIRECT)
    }
    tallies.incoming.add(records)
    tallies.incomingBytes.add(bytes)
    this.ingest(lane, { records, bytes, born: message.bornAt, arrived: fast.now() })
    return undefined
  }

  /**
   * The Direct PUT quota: requests, records and MiB a second, all three, raised together from the region's base. Each is
   * a bucket that holds one second's worth.
   */
  private withinQuota(records: number, bytes: number): boolean {
    const { fast, limiter, id, region } = this.env
    const base = directPutBase(region)
    const mibps = (fast.account() as Account).firehoseDirectPutMiBps
    const scale = mibps / base.mibps
    const requests = { rate: base.requests * scale, burst: base.requests * scale }
    const recordsPerS = { rate: base.records * scale, burst: base.records * scale }
    const bytesPerS = { rate: mibps * MiB, burst: mibps * MiB }
    if (!limiter.fitsUnsafe(`${id}/put-requests`, requests) || !limiter.fitsUnsafe(`${id}/put-records`, recordsPerS, records) || !limiter.fitsUnsafe(`${id}/put-bytes`, bytesPerS, bytes)) return false
    limiter.takeUnsafe(`${id}/put-requests`, requests)
    limiter.takeUnsafe(`${id}/put-records`, recordsPerS, records)
    limiter.takeUnsafe(`${id}/put-bytes`, bytesPerS, bytes)
    return true
  }

  private lane(name: string): Lane {
    let lane = this.lanes.get(name)
    if (lane === undefined) this.lanes.set(name, (lane = new Lane(name)))
    return lane
  }

  private ingest(lane: Lane, chunk: Chunk): void {
    if (this.env.transform === undefined) return this.gather(lane, chunk)
    const c = this.env.fast.settings().transform
    const limit = c.bufferSize * MiB
    // Firehose cuts processor batches at the buffer size: a big arrival (a catching-up Kinesis read of up to 10 MiB, a
    // 4 MiB PutRecordBatch) becomes several invocations, never one payload past what the function takes.
    let rest = chunk
    while (lane.transformBuffer.bytes + rest.bytes > limit && rest.records > 1) {
      const per = rest.bytes / rest.records
      const room = limit - lane.transformBuffer.bytes
      if (room < per && lane.transformBuffer.records > 0) {
        this.flushTransform(lane)
        continue
      }
      const n = Math.max(1, Math.min(rest.records - 1, Math.floor(room / per)))
      lane.transformBuffer.add({ ...rest, records: n, bytes: per * n })
      this.flushTransform(lane)
      rest = { ...rest, records: rest.records - n, bytes: per * (rest.records - n) }
    }
    lane.transformBuffer.add(rest)
    if (lane.transformBuffer.bytes >= limit) return this.flushTransform(lane)
    lane.transformBuffer.timer ??= this.env.fast.after(this.intervalMs(c.bufferInterval), this.onTransformTimer, lane)
  }

  private intervalMs(interval: Duration.Duration): number {
    const ms = Duration.toMillis(interval)
    return ms > 0 ? ms : ZERO_BUFFER_MS
  }

  // ---- transformation ----------------------------------------------------------------------------------------

  private readonly onTransformTimer = (lane: Lane): void => {
    lane.transformBuffer.timer = undefined
    this.flushTransform(lane)
  }

  private flushTransform(lane: Lane): void {
    if (lane.transformBuffer.records === 0) return
    lane.transformQueue.push(lane.transformBuffer.take())
    this.pumpTransform(lane)
  }

  /** Up to five invocations per shard at once; the rest wait their turn. */
  private pumpTransform(lane: Lane): void {
    while (lane.transformInflight < TRANSFORM_CONCURRENCY && lane.transformQueue.length > 0) this.invoke(lane, lane.transformQueue.shift()!, 0)
  }

  private invoke(lane: Lane, chunk: Chunk, attempt: number): void {
    const { fast, tallies } = this.env
    const link = this.env.transform
    if (link === undefined) return this.gather(lane, chunk)
    lane.transformInflight++
    tallies.transformInvocations.add(1)
    const sentAt = fast.now()
    const message: Message = {
      ...fast.mint({ count: chunk.records, bytes: chunk.bytes, key: this.key, group: lane.name, invocation: "sync", operation: "write" }),
      bornAt: chunk.born,
      batched: true
    }
    link.send(message, (failure, items) => {
      this.env.transformDuration.add(this.env.fast.now() - sentAt)
      this.transformed(lane, chunk, attempt, failure, items)
    })
  }

  /**
   * The function answered. A failed invocation (an error, a timeout, a throttle) is retried, three times by default,
   * then its records count as failed. Records it reports failed (ProcessingFailed) go to the error output; the rest go
   * on to the destination's buffer, at the size the function made them.
   */
  private transformed(lane: Lane, chunk: Chunk, attempt: number, failure: CallFailure | undefined, items: ItemFailures | undefined): void {
    const { fast, tallies } = this.env
    lane.transformInflight--
    const c = fast.settings().transform
    if (failure !== undefined) {
      tallies.transformFailed.add(1)
      if (attempt < c.retries) {
        lane.transformInflight++
        fast.after(TRANSFORM_RETRY_MS, () => {
          lane.transformInflight--
          this.invoke(lane, chunk, attempt + 1)
        }, undefined)
      } else {
        this.failRecords(chunk)
      }
      return this.pumpTransform(lane)
    }
    this.env.transformSucceeded.n++
    let failed = 0
    if (items !== undefined) for (const i of items.failed) if (i >= 0 && i < chunk.records) failed++
    if (failed > 0) this.failRecords({ ...chunk, records: failed, bytes: (chunk.bytes * failed) / chunk.records })
    const ok = chunk.records - failed
    if (ok > 0) {
      tallies.transformedRecords.add(ok)
      this.gather(lane, { records: ok, bytes: ((chunk.bytes * ok) / chunk.records) * c.outputRatio, born: chunk.born, arrived: chunk.arrived })
    }
    this.pumpTransform(lane)
  }

  /**
   * Records the transformation failed. With an S3 destination they are written to the bucket's processing-failed prefix
   * (an object of their own on the destination edge); with an HTTP endpoint, to the S3 backup bucket.
   */
  private failRecords(chunk: Chunk): void {
    const { fast, tallies } = this.env
    tallies.processingFailed.add(chunk.records)
    const s3 = fast.settings().destination === "s3"
    const link = s3 ? this.env.out : this.env.backup
    this.writeAside(link, chunk, chunk.records * ERROR_RECORD_OVERHEAD)
  }

  /** One object to an error prefix or a backup bucket: sent once through its edge (whose retries apply), counted either way. */
  private writeAside(link: Link | undefined, chunk: Chunk, overhead: number): void {
    const { fast, tallies } = this.env
    if (link === undefined) {
      tallies.lost.add(chunk.records)
      return
    }
    const message = { ...fast.mint({ count: 1, bytes: chunk.bytes + overhead, key: (this.key + 0.5) % 1, invocation: "sync", operation: "write" }), bornAt: chunk.born }
    link.send(message, (failure) => {
      if (failure === undefined) tallies.backedUp.add(chunk.records)
      else {
        tallies.backupFailed.add(chunk.records)
        tallies.lost.add(chunk.records)
      }
    })
  }

  // ---- buffering and delivery --------------------------------------------------------------------------------

  /** The destination's buffer limits: the size hint (64 MiB at most for an HTTP endpoint) and, for HTTP, 10,000 records. */
  private limits(c: DeliveryConfig): { bytes: number; records: number; merged: number } {
    const http = c.destination === "http"
    const size = http ? Math.min(c.bufferSize, HTTP_MAX_BUFFER_MIB) : c.bufferSize
    return { bytes: size * MiB, records: http ? HTTP_MAX_RECORDS : Number.POSITIVE_INFINITY, merged: (http ? HTTP_MAX_BUFFER_MIB : MAX_BUFFER_MIB) * MiB }
  }

  private gather(lane: Lane, chunk: Chunk): void {
    const c = this.env.fast.settings()
    lane.buffer.add(chunk)
    const limit = this.limits(c)
    if (lane.buffer.bytes >= limit.bytes || lane.buffer.records >= limit.records) return this.flush(lane)
    lane.buffer.timer ??= this.env.fast.after(this.intervalMs(c.bufferInterval), this.onTimer, lane)
  }

  private readonly onTimer = (lane: Lane): void => {
    lane.buffer.timer = undefined
    this.flush(lane)
  }

  /** The buffer is full or its time is up: queue it for delivery, merged into a waiting one while delivery is behind. */
  private flush(lane: Lane): void {
    if (lane.buffer.records === 0) return
    const chunk = lane.buffer.take()
    const last = lane.pending[lane.pending.length - 1]
    const limit = this.limits(this.env.fast.settings())
    if (last !== undefined && last.bytes + chunk.bytes <= limit.merged && last.records + chunk.records <= limit.records) {
      last.records += chunk.records
      last.bytes += chunk.bytes
      if (chunk.born < last.born) last.born = chunk.born
      if (chunk.arrived < last.arrived) last.arrived = chunk.arrived
    } else {
      lane.pending.push({ ...chunk, attempts: 0, failingSince: -1 })
    }
    this.pump(lane)
  }

  private pump(lane: Lane): void {
    if (lane.head !== undefined) return
    const next = lane.pending.shift()
    if (next === undefined) {
      if (lane.idle) this.lanes.delete(lane.name)
      return
    }
    lane.head = next
    this.deliver(lane)
  }

  /** Send the lane's head delivery: one object of all its records (count 1, so S3 counts one PUT). */
  private deliver(lane: Lane): void {
    const { fast, tallies } = this.env
    const d = lane.head!
    const link = this.env.out
    if (link === undefined) {
      // No destination in the design: delivered somewhere outside it.
      return this.delivered(lane, d)
    }
    d.attempts++
    const message = { ...fast.mint({ count: 1, bytes: d.bytes, key: this.key, invocation: "sync", operation: "write" }), bornAt: d.born }
    link.send(message, (failure) => {
      if (failure === undefined) return this.delivered(lane, d)
      tallies.deliveryFailed.add(1)
      this.failed(lane, d, failure)
    })
  }

  private delivered(lane: Lane, d: Delivery): void {
    const { tallies } = this.env
    tallies.objects.add(1)
    tallies.delivered.add(d.records)
    tallies.deliveredBytes.add(d.bytes)
    this.lastObjectBytes = d.bytes
    lane.head = undefined
    this.pump(lane)
  }

  /**
   * A delivery failed. An HTTP endpoint is retried for the retry duration (a 413 not at all) and then backed up to S3.
   * S3 is retried for 24 hours for a Direct PUT stream (then the data is lost), and for as long as it takes when the
   * records come from a Kinesis stream (which holds them meanwhile: Firehose stops reading it).
   */
  private failed(lane: Lane, d: Delivery, failure: CallFailure): void {
    const { fast, tallies } = this.env
    const c = fast.settings()
    const now = fast.now()
    if (d.failingSince < 0) d.failingSince = now
    const http = c.destination === "http"
    const giveUp = http
      ? failure._tag === "Rejected" || now - d.failingSince >= Duration.toMillis(c.retryDuration)
      : !this.kinesisSource && now - d.arrived >= DIRECT_PUT_RETENTION_MS
    if (giveUp) {
      lane.head = undefined
      // A 413 is a permanent failure that isn't backed up; anything else past the retry duration is.
      if (http && failure._tag !== "Rejected") this.writeAside(this.env.backup, d, 0)
      else tallies.lost.add(d.records)
      return this.pump(lane)
    }
    // Firehose's backoff: 1 s doubling to 2 minutes, with 15% jitter either way.
    const base = Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** (d.attempts - 1))
    const wait = base * (1 - RETRY_JITTER + 2 * RETRY_JITTER * fast.random.nextDoubleUnsafe())
    lane.retry = fast.after(wait, this.onRetry, lane)
  }

  private readonly onRetry = (lane: Lane): void => {
    lane.retry = undefined
    if (lane.head !== undefined) this.deliver(lane)
  }

  // ---- what it reports ---------------------------------------------------------------------------------------

  /** DataFreshness: how long the oldest record not yet delivered has been in Firehose. */
  freshness(now: number): number {
    let oldest = now
    const see = (c: Chunk): void => {
      if (c.records > 0 && c.arrived < oldest) oldest = c.arrived
    }
    for (const lane of this.lanes.values()) {
      see(lane.buffer)
      see(lane.transformBuffer)
      for (const c of lane.transformQueue) see(c)
      for (const d of lane.pending) see(d)
      if (lane.head !== undefined) see(lane.head)
    }
    return now - oldest
  }

  /** Records and bytes held: gathering, waiting to be delivered or being delivered (not those in a transformation). */
  held(): { records: number; bytes: number; deliveries: number; failing: number } {
    let records = 0
    let bytes = 0
    let deliveries = 0
    let failing = 0
    for (const lane of this.lanes.values()) {
      records += lane.buffer.records + lane.transformBuffer.records
      bytes += lane.buffer.bytes + lane.transformBuffer.bytes
      for (const d of lane.pending) {
        records += d.records
        bytes += d.bytes
      }
      deliveries += lane.pending.length
      if (lane.head !== undefined) {
        records += lane.head.records
        bytes += lane.head.bytes
        deliveries++
      }
      if (lane.failing) failing++
    }
    return { records, bytes, deliveries, failing }
  }

  get laneCount(): number {
    return this.lanes.size
  }
}
