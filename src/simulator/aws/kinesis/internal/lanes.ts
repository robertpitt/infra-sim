import type { SeededRandom } from "../../../SeededRandom.ts"
import type { TimerHandle } from "../../../VirtualTime.ts"
import { LAMBDA_MAX_BATCH_BYTES } from "./config.ts"
import { arrivedAt, bornAt, laneCount } from "./log.ts"
import type { Cursor } from "./readers.ts"

/**
 * The lanes of Lambda's event source mapping: how it cuts a shard's records into batches.
 *
 * A shard is processed as `parallelization` lanes, each a key range of the shard handled in order, one batch at a time
 * (one lane per shard with a factor of 1). A lane's place is a segment and how many of its records in that segment it
 * has handed out; a batch is a copy of the numbers it carries, so retrying or splitting it needs nothing kept in the
 * stream.
 */

/** Records handed to one invocation. Its numbers are copied out of the stream, so retrying needs nothing kept there. */
export interface Batch {
  count: number
  bytes: number
  /** Creation time of its oldest message, for end-to-end age. */
  born: number
  /** Arrival of its oldest and newest record in the stream: record age and IteratorAge count from these. */
  firstAt: number
  lastAt: number
  /** The lane's count of its first record, so a poison record can be found in it however it is split. */
  ordinal: number
  /** Function errors so far (MaximumRetryAttempts counts these). */
  attempts: number
  /** Invocations refused before the function ran (throttled, Lambda unavailable): retried without using up retries. */
  throttles: number
}

/** A sequence of records of one shard that are processed in order: the shard itself, or one key range of it. */
export interface Lane {
  readonly index: number
  /** The next record to hand out: a segment, and how many of the lane's records in it are already handed out. */
  seg: number
  off: number
  /** Records of this lane handed out so far. */
  ordinal: number
  /** Batches waiting to go, in order: the one in flight or being retried first (two after a bisect). */
  readonly queue: Array<Batch>
  inflight: boolean
  /** A retry waiting out its backoff. */
  wait: TimerHandle | undefined
  /** A batching window open since `gatherSince`. */
  window: TimerHandle | undefined
  gatherSince: number
  /** Lane counts of poison records not yet passed, ascending, and the next one to draw. */
  readonly poison: Array<number>
  nextPoison: number
}

/** What the mapping keeps per shard. */
export interface ShardWork {
  lanes: Array<Lane>
  /** Records the shard had when the mapping started on it (LATEST): what came before isn't its to read. */
  readonly base: number
  /** Records processed: delivered, discarded or expired. */
  done: number
}

/** Lanes for a shard, all starting at segment `at`. */
export const newLanes = (at: number, n: number): Array<Lane> =>
  Array.from({ length: n }, (_, index) => ({
    index,
    seg: at,
    off: 0,
    ordinal: 0,
    queue: [],
    inflight: false,
    wait: undefined,
    window: undefined,
    gatherSince: -1,
    poison: [],
    nextPoison: -1
  }))

/** The segment below which no lane of the shard needs anything. */
export const lowest = (work: ShardWork): number => {
  let low = Number.POSITIVE_INFINITY
  for (const lane of work.lanes) if (lane.seg < low) low = lane.seg
  return low
}

/**
 * The lane's next records, up to `batchSize` and Lambda's 6 MB payload (at least one record), without taking them: where
 * the lane would be after them, and the batch's numbers. Records inside a segment are taken to have arrived evenly.
 */
export const collect = (cursor: Cursor<ShardWork>, lane: Lane, batchSize: number) => {
  const shard = cursor.shard
  const lanes = cursor.local.lanes.length
  let seg = Math.max(lane.seg, shard.first)
  let off = seg === lane.seg ? lane.off : 0
  let count = 0
  let bytes = 0
  let born = Number.POSITIVE_INFINITY
  let firstAt = Number.POSITIVE_INFINITY
  let lastAt = Number.NEGATIVE_INFINITY
  while (seg < cursor.fetched && count < batchSize) {
    const s = shard.at(seg)!
    const own = laneCount(s, lane.index, lanes)
    if (off >= own) {
      seg++
      off = 0
      continue
    }
    const per = s.bytes / s.count
    let take = Math.min(own - off, batchSize - count)
    if (count > 0 && bytes + take * per > LAMBDA_MAX_BATCH_BYTES) take = Math.floor((LAMBDA_MAX_BATCH_BYTES - bytes) / per)
    if (take <= 0) break
    // Where the records taken sit in the segment, for their arrival and birth times.
    const first = own > 1 ? off / (own - 1) : 0
    const last = own > 1 ? (off + take - 1) / (own - 1) : 0
    if (count === 0) {
      born = bornAt(s, first)
      firstAt = arrivedAt(s, first)
    }
    lastAt = arrivedAt(s, last)
    count += take
    bytes += take * per
    off += take
    if (off >= own) {
      seg++
      off = 0
    }
    if (bytes >= LAMBDA_MAX_BATCH_BYTES) break
  }
  return { count, bytes, born, firstAt, lastAt, seg, off }
}

/** Split a batch after its first `n` records. Arrival times are interpolated: records arrive in order. */
export const cut = (batch: Batch, n: number): [Batch, Batch] => {
  const share = n / batch.count
  const at = batch.firstAt + (batch.lastAt - batch.firstAt) * share
  const a: Batch = { ...batch, count: n, bytes: batch.bytes * share, lastAt: at }
  const b: Batch = { ...batch, count: batch.count - n, bytes: batch.bytes - a.bytes, firstAt: at, ordinal: batch.ordinal + n }
  return [a, b]
}

/** The arrival of the oldest record a cursor's lanes hold or have yet to hand out (from what has been read). */
export const oldestIn = (cursor: Cursor<ShardWork>): number => {
  const shard = cursor.shard
  const lanes = cursor.local.lanes.length
  let oldest = Number.POSITIVE_INFINITY
  for (const lane of cursor.local.lanes) {
    const head = lane.queue[0]
    if (head !== undefined) {
      if (head.firstAt < oldest) oldest = head.firstAt
      continue
    }
    for (let seg = Math.max(lane.seg, shard.first); seg < cursor.fetched; seg++) {
      const s = shard.at(seg)!
      const own = laneCount(s, lane.index, lanes)
      const off = seg === lane.seg ? lane.off : 0
      if (own > off) {
        const at = arrivedAt(s, own > 1 ? off / (own - 1) : 0)
        if (at < oldest) oldest = at
        break
      }
    }
  }
  return oldest
}

/**
 * Where the first poison record of `batch` is, as a position in it, or -1. Poison records are drawn per lane as the
 * lane's records are first needed (a geometric gap with mean 1/share), so the same record is poison every time it is
 * tried, however the batch is split.
 */
export const poisonIn = (lane: Lane, batch: Batch, share: number, random: SeededRandom): number => {
  const end = batch.ordinal + batch.count
  if (lane.nextPoison < 0) lane.nextPoison = batch.ordinal + gap(share, random) - 1
  while (lane.nextPoison < end) {
    lane.poison.push(lane.nextPoison)
    lane.nextPoison += gap(share, random)
  }
  // Forget poison records the lane has moved past.
  const oldest = lane.queue[0]?.ordinal ?? batch.ordinal
  while (lane.poison.length > 0 && lane.poison[0]! < oldest) lane.poison.shift()
  for (const p of lane.poison) {
    if (p >= end) break
    if (p >= batch.ordinal) return p - batch.ordinal
  }
  return -1
}

/** Records up to and including the next poison one. */
const gap = (share: number, random: SeededRandom): number => {
  if (share >= 1) return 1
  const u = random.nextDoubleUnsafe()
  return 1 + Math.floor(Math.log(1 - u) / Math.log(1 - share))
}
