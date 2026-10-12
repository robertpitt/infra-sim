import {
  ON_DEMAND_WINDOW_MS,
  SEGMENT_MS,
  SHARD_READ_BYTES,
  SHARD_READ_CALLS,
  SHARD_WRITE_BYTES,
  SHARD_WRITE_RECORDS,
  SLICES,
  WRITE_BURST_S
} from "./config.ts"

/**
 * A shard's records, and the shard's own limits.
 *
 * Records are kept as segments, not objects: everything written to a shard within `SEGMENT_MS` shares one, with its
 * count, size, arrival time and how its records spread over the shard's key range (`slices`). A busy shard is a handful
 * of segments a second, and a consumer's position is a segment and an offset into it. A segment becomes readable once it
 * is sealed, `SEGMENT_MS` after its first record: from then on it never changes, so every reader sees the same records.
 */

export interface Segment {
  /** When its first record arrived (ApproximateArrivalTimestamp of the oldest): retention and iterator age count from here. */
  readonly at: number
  /** When its last record arrived. Records in between are taken to have arrived evenly. */
  last: number
  /** When it is sealed and becomes readable. */
  readonly readyAt: number
  count: number
  bytes: number
  /** Creation time of the oldest and newest message in it, so a consumer's end-to-end age is right. */
  born: number
  bornLast: number
  /** Records in each tenth of the shard's hash-key range, so a parallelization factor can split a shard by key. */
  readonly slices: Int32Array
}

/** A token bucket kept by hand: two of them have to be checked together, and a GetRecords may overdraw one. */
interface Bucket {
  tokens: number
  at: number
}

const refill = (b: Bucket, now: number, rate: number, cap: number): void => {
  if (now > b.at) {
    b.tokens = Math.min(cap, b.tokens + ((now - b.at) * rate) / 1000)
    b.at = now
  }
}

export class Shard {
  /** Children, once it has been split or merged. */
  readonly children: Array<Shard> = []
  open = true
  closedAt = -1
  /** Records appended, ever, and those still held. */
  total = 0
  private held_ = 0
  /** Absolute index one past the last sealed (readable) segment. */
  sealed = 0
  /** On-demand: when a split is due, or -1. */
  splitAt = -1
  /** On-demand: traffic offered (accepted or throttled) since the last tick, and its smoothed rate per second. */
  offeredBytes = 0
  offeredRecords = 0
  rateBytes = 0
  rateRecords = 0
  /** The traffic offered over the last tick, per second, unsmoothed: what the shard-load gauges read. */
  lastBytes = 0
  lastRecords = 0

  private segments: Array<Segment> = []
  /** Absolute index of `segments[0]`; positions are absolute, so trimming the front never moves them. */
  private offset = 0
  private head = 0
  private readonly writeBytes: Bucket
  private readonly writeRecords: Bucket
  private readonly readBytes: Bucket
  private readonly readCalls: Bucket

  constructor(
    /** Creation order: shardId-000000000000 is 0. */
    readonly id: number,
    /** The hash-key range it owns, as a fraction of the whole: [lo, hi). */
    readonly lo: number,
    readonly hi: number,
    readonly parents: ReadonlyArray<Shard>,
    now: number,
    burstBytes: number
  ) {
    this.writeBytes = { tokens: burstBytes, at: now }
    this.writeRecords = { tokens: SHARD_WRITE_RECORDS * WRITE_BURST_S, at: now }
    this.readBytes = { tokens: SHARD_READ_BYTES, at: now }
    this.readCalls = { tokens: SHARD_READ_CALLS, at: now }
  }

  get name(): string {
    return `shardId-${String(this.id).padStart(12, "0")}`
  }

  /** Absolute index one past the newest segment. */
  get end(): number {
    return this.offset + this.segments.length
  }

  /** Absolute index of the oldest segment still held. */
  get first(): number {
    return this.offset + this.head
  }

  at(abs: number): Segment | undefined {
    return abs < this.offset + this.head ? undefined : this.segments[abs - this.offset]
  }

  /** Segments held. */
  get held(): number {
    return this.segments.length - this.head
  }

  /** Where a key in [lo, hi) falls among the shard's slices. */
  slice(key: number): number {
    const width = this.hi - this.lo
    const s = Math.floor(((key - this.lo) / (width > 0 ? width : 1)) * SLICES)
    // A key that isn't a number lands in the first slice, as `route` puts it on the first shard.
    return s >= 0 ? (s < SLICES ? s : SLICES - 1) : 0
  }

  // ---- writes ------------------------------------------------------------------------------------------------

  /**
   * Take `records` and `bytes` from the shard's write allowance (1 MiB and 1,000 records a second), both or neither.
   * The byte bucket holds a second's worth, or one record of the stream's largest size if that is bigger.
   */
  admit(now: number, records: number, bytes: number, burstBytes: number): boolean {
    this.offeredBytes += bytes
    this.offeredRecords += records
    refill(this.writeBytes, now, SHARD_WRITE_BYTES, burstBytes)
    refill(this.writeRecords, now, SHARD_WRITE_RECORDS, SHARD_WRITE_RECORDS * WRITE_BURST_S)
    // A request bigger than the whole bucket could never pass; let it have a full bucket rather than starve.
    const needBytes = Math.min(bytes, burstBytes)
    const needRecords = Math.min(records, SHARD_WRITE_RECORDS * WRITE_BURST_S)
    if (this.writeBytes.tokens < needBytes || this.writeRecords.tokens < needRecords) return false
    this.writeBytes.tokens -= needBytes
    this.writeRecords.tokens -= needRecords
    return true
  }

  /**
   * Add records. `slice` is where a single key falls; with `spread` set instead, the records are spread evenly over the
   * slices (independent keys), starting from the fraction `spread`. Returns true when a new segment was started, so the
   * caller can arm the timer that seals it.
   */
  append(now: number, count: number, bytes: number, born: number, slice: number, spread: number | undefined): boolean {
    this.total += count
    this.held_ += count
    const last = this.segments[this.segments.length - 1]
    const joinable = last !== undefined && this.end - 1 >= this.sealed && now - last.at < SEGMENT_MS
    const segment = joinable ? last! : { at: now, last: now, readyAt: now + SEGMENT_MS, count: 0, bytes: 0, born, bornLast: born, slices: new Int32Array(SLICES) }
    segment.count += count
    segment.bytes += bytes
    segment.last = now
    if (born < segment.born) segment.born = born
    if (born > segment.bornLast) segment.bornLast = born
    if (spread === undefined) segment.slices[slice]! += count
    else spreadOver(segment.slices, count, spread)
    if (!joinable) this.segments.push(segment)
    return !joinable
  }

  /** Seal every segment whose time has come. Returns whether any was sealed. */
  seal(now: number): boolean {
    const before = this.sealed
    for (;;) {
      const s = this.at(this.sealed)
      if (s === undefined || s.readyAt > now) break
      this.sealed++
    }
    return this.sealed > before
  }

  /** Close the shard: no more writes. What is in its last segment becomes readable at once. */
  close(now: number): void {
    this.open = false
    this.closedAt = now
    this.sealed = this.end
  }

  /** Forget segments before `abs`: every reader is past them, or they are past retention. */
  drop(abs: number): void {
    const to = Math.min(abs, this.sealed)
    const head = Math.min(this.segments.length, Math.max(this.head, to - this.offset))
    for (let i = this.head; i < head; i++) this.held_ -= this.segments[i]!.count
    this.head = head
    if (this.head > 256 && this.head * 2 > this.segments.length) {
      this.segments = this.segments.slice(this.head)
      this.offset += this.head
      this.head = 0
    }
  }

  /** The first absolute index whose segment arrived after `cutoff` (or the end): what retention keeps. */
  firstAfter(cutoff: number): number {
    let abs = this.first
    for (;;) {
      const s = this.at(abs)
      if (s === undefined || s.at > cutoff) return abs
      abs++
    }
  }

  /** Records held, readable or not. */
  retained(): number {
    return this.held_
  }

  // ---- reads (shared-throughput consumers) ---------------------------------------------------------------------

  /**
   * Whether a GetRecords call may go ahead: a call token (five a second) and a byte allowance not overdrawn (2 MiB a
   * second). A call may overdraw the bytes, as AWS lets one call return 10 MiB and then throttles for five seconds.
   */
  mayRead(now: number): boolean {
    refill(this.readCalls, now, SHARD_READ_CALLS, SHARD_READ_CALLS)
    refill(this.readBytes, now, SHARD_READ_BYTES, SHARD_READ_BYTES)
    return this.readCalls.tokens >= 1 && this.readBytes.tokens > 0
  }

  /** Charge a GetRecords call that returned `bytes`. Call after `mayRead` said yes. */
  chargeRead(bytes: number): void {
    this.readCalls.tokens -= 1
    this.readBytes.tokens -= bytes
  }

  /** On-demand: fold the traffic offered since the last tick into the smoothed per-second rates. */
  observe(elapsedMs: number): void {
    if (elapsedMs <= 0) return
    const k = Math.min(1, elapsedMs / ON_DEMAND_WINDOW_MS)
    this.lastBytes = (this.offeredBytes * 1000) / elapsedMs
    this.lastRecords = (this.offeredRecords * 1000) / elapsedMs
    this.rateBytes += ((this.offeredBytes * 1000) / elapsedMs - this.rateBytes) * k
    this.rateRecords += ((this.offeredRecords * 1000) / elapsedMs - this.rateRecords) * k
    this.offeredBytes = 0
    this.offeredRecords = 0
  }
}

/**
 * A byte allowance of its own: an enhanced fan-out consumer's 2 MiB a second from one shard. It may be overdrawn by the
 * push that crosses it, and pushes again once it has refilled.
 */
export class Allowance {
  private readonly bucket: Bucket

  constructor(now: number, private readonly rate: number) {
    this.bucket = { tokens: rate, at: now }
  }

  /** Milliseconds until it is no longer overdrawn (0 when it isn't). */
  waitMs(now: number): number {
    refill(this.bucket, now, this.rate, this.rate)
    return this.bucket.tokens > 0 ? 0 : Math.ceil((-this.bucket.tokens * 1000) / this.rate) + 1
  }

  charge(bytes: number): void {
    this.bucket.tokens -= bytes
  }
}

/**
 * When the record at `share` of the way through a segment (0 the first, 1 the last) arrived and was born: records are
 * taken to be spread evenly between the segment's first and last.
 */
export const arrivedAt = (segment: Segment, share: number): number => segment.at + (segment.last - segment.at) * share
export const bornAt = (segment: Segment, share: number): number => segment.born + (segment.bornLast - segment.born) * share

/** Spread `count` records evenly over the slices, the remainder starting where `from` (in [0, 1)) points. */
const spreadOver = (slices: Int32Array, count: number, from: number): void => {
  const base = Math.floor(count / SLICES)
  const rest = count - base * SLICES
  const start = Math.floor(from * SLICES)
  for (let s = 0; s < SLICES; s++) slices[s]! += base
  for (let i = 0; i < rest; i++) slices[(start + i) % SLICES]! += 1
}

/**
 * Records of `segment` in lane `lane` of `lanes`: the lanes split the shard's key range evenly, and a slice that
 * straddles two lanes is shared between them in proportion. Rounding is done on the running total, so the lanes of a
 * segment always add up to its count and each lane's share is the same every time it is asked.
 */
export const laneCount = (segment: Segment, lane: number, lanes: number): number => {
  if (lanes <= 1) return segment.count
  return Math.round(below(segment.slices, (lane + 1) / lanes)) - Math.round(below(segment.slices, lane / lanes))
}

/** Records whose key lies below `x` (a fraction of the shard's range), slices counted pro rata. */
const below = (slices: Int32Array, x: number): number => {
  const edge = x * SLICES
  let n = 0
  for (let s = 0; s < SLICES; s++) {
    if (s + 1 <= edge) n += slices[s]!
    else {
      if (edge > s) n += slices[s]! * (edge - s)
      break
    }
  }
  return n
}
