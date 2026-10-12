import { Duration } from "effect"
import type { Fast } from "../../Component.ts"
import type { Tally } from "../../kit/Tally.ts"
import { type CallFailure, type ItemFailures, itemFailures, type Message, Rejected, Throttled } from "../../Message.ts"
import type { Account } from "../account.ts"
import {
  KiB,
  MAX_SHARDS_PER_STREAM,
  ON_DEMAND_INITIAL_SHARDS,
  ON_DEMAND_SPLIT_BYTES,
  ON_DEMAND_SPLIT_RECORDS,
  PUT_RECORDS_MAX_BYTES,
  PUT_RECORDS_MAX_RECORDS,
  RESHARD_MS,
  SEGMENT_MS,
  SHARD_WRITE_BYTES,
  type StreamConfig,
  TICK_MS,
  UPDATE_SHARD_COUNT_PER_DAY,
  WRITE_BURST_S
} from "./config.ts"
import { Shard } from "./log.ts"
import { type ConsumerSpec, type Lag, Readers, type ReadTallies, type Subscription } from "./readers.ts"

/**
 * A Kinesis data stream: its shards, the writes they take, how they are split and merged, and what it keeps for the
 * consumers reading it (`readers.ts`).
 *
 * Writes land on the shard whose hash-key range holds the record's key (`Message.key`), so a hot key loads one shard
 * while the rest idle. Records are kept until every consumer is past them, and closed shards until every consumer has
 * finished them.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** What the stream counts, as CloudWatch's names (the README maps them). */
export interface StreamTallies extends ReadTallies {
  /** IncomingRecords, IncomingBytes. */
  readonly incoming: Tally
  readonly incomingBytes: Tally
  /** WriteProvisionedThroughputExceeded: records refused for the shard's write limit. */
  readonly throttled: Tally
  /** Requests refused outright (too large, too many records). */
  readonly rejected: Tally
  /** Records a consumer found past retention before it read them, once per consumer. */
  readonly expired: Tally
  /** Shard splits (on-demand) and UpdateShardCount steps (provisioned). */
  readonly splits: Tally
  readonly reshards: Tally
}

export interface StreamDeps {
  /** The stream's node id, for the failures it answers with. */
  readonly id: string
  readonly fast: Fast<StreamConfig>
  readonly tallies: StreamTallies
  /** Send a record of discarded records to the on-failure destination. */
  readonly discard: (message: Message) => void
}

export class StreamModel {
  /** Every shard still held, in creation order. */
  readonly shards: Array<Shard> = []
  /** Open shards, by hash-key range. */
  private open: Array<Shard> = []
  private readonly readers: Readers
  private nextId = 0
  private lastTick = 0
  /** Provisioned: an UpdateShardCount step under way, and when the recent ones started (ten a rolling day). */
  private updating: { readonly target: number; readonly doneAt: number } | undefined
  private readonly updates: Array<number> = []
  /** A change of shard count is waiting because ten UpdateShardCount steps have run in the last 24 hours. */
  waiting = false
  private modeWas: StreamConfig["mode"]

  constructor(private readonly deps: StreamDeps) {
    this.readers = new Readers(deps.fast, deps.tallies)
    const c = deps.fast.settings()
    this.modeWas = c.mode
    const initial = c.mode === "on-demand" ? ON_DEMAND_INITIAL_SHARDS : c.shards
    this.reshape(initial, [])
    deps.fast.after(TICK_MS, this.tick, undefined)
  }

  get openCount(): number {
    return this.open.length
  }

  get isUpdating(): boolean {
    return this.updating !== undefined
  }

  /** The write burst of a shard: a second's worth, or one record of the stream's largest size. */
  private burst(c: StreamConfig): number {
    return Math.max(SHARD_WRITE_BYTES * WRITE_BURST_S, c.maxRecordSize * KiB)
  }

  // ---- writes ------------------------------------------------------------------------------------------------

  /**
   * PutRecord (one record) or PutRecords (several): what the stream answers. A PutRecords is not atomic: records whose
   * shard is over its limit fail on their own and the rest are stored, which the caller hears as `ItemFailures`.
   */
  put(message: Message): CallFailure | ItemFailures | undefined {
    const { fast, tallies } = this.deps
    const c = fast.settings()
    const n = message.count >= 1 ? Math.floor(message.count) : 0
    if (n === 0) return undefined
    const bytes = message.bytes > 0 ? message.bytes : 0
    const maxRecord = c.maxRecordSize * KiB
    if (bytes / n > maxRecord) {
      tallies.rejected.add(n)
      return Rejected({ node: this.deps.id, reason: `record over the stream's maximum record size (${c.maxRecordSize} KiB)` })
    }
    if (n > PUT_RECORDS_MAX_RECORDS || (n > 1 && bytes > PUT_RECORDS_MAX_BYTES)) {
      tallies.rejected.add(n)
      return Rejected({ node: this.deps.id, reason: "PutRecords takes at most 500 records and 10 MiB" })
    }
    const now = fast.now()
    const burst = this.burst(c)
    if (n === 1) {
      const shard = this.route(message.key)
      if (!shard.admit(now, 1, bytes, burst)) {
        tallies.throttled.add(1)
        return Throttled({ node: this.deps.id, reason: `ProvisionedThroughputExceededException: rate exceeded for ${shard.name}` })
      }
      this.append(shard, 1, bytes, message.bornAt, shard.slice(message.key), undefined, now)
      tallies.incoming.add(1)
      tallies.incomingBytes.add(bytes)
      return undefined
    }
    // Several records, each with its own partition key: spread over the shards by the width of their ranges, the
    // rounding started at a random point so no shard is favoured over many calls. A share of them may share the call's
    // key (`Message.spread`, a hot key in a batch): those all go to its shard.
    const per = bytes / n
    const from = fast.random.nextDoubleUnsafe()
    const shared = Math.round(n * (1 - Math.min(1, Math.max(0, message.spread ?? 1))))
    const spreadN = n - shared
    const hotShard = shared > 0 ? this.route(message.key) : undefined
    let failed: Array<number> | undefined
    let accepted = 0
    let position = 0
    for (const shard of this.open) {
      const count = Math.floor(spreadN * shard.hi + from) - Math.floor(spreadN * shard.lo + from) + (shard === hotShard ? shared : 0)
      if (count <= 0) continue
      if (shard.admit(now, count, count * per, burst)) {
        this.append(shard, count, count * per, message.bornAt, 0, from, now)
        accepted += count
      } else {
        failed ??= []
        for (let i = 0; i < count; i++) failed.push(position + i)
      }
      position += count
    }
    if (accepted > 0) {
      tallies.incoming.add(accepted)
      tallies.incomingBytes.add(accepted * per)
    }
    if (failed === undefined) return undefined
    tallies.throttled.add(failed.length)
    // Every record refused: the call failed for throughput, which a caller's retry policy can act on.
    if (accepted === 0) return Throttled({ node: this.deps.id, reason: "ProvisionedThroughputExceededException: every record's shard is over its limit" })
    return itemFailures(failed)
  }

  /** The open shard whose range holds `key`. */
  private route(key: number): Shard {
    const open = this.open
    let lo = 0
    let hi = open.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (open[mid]!.lo <= key) lo = mid
      else hi = mid - 1
    }
    return open[lo]!
  }

  private append(shard: Shard, count: number, bytes: number, born: number, slice: number, spread: number | undefined, now: number): void {
    if (shard.append(now, count, bytes, born, slice, spread)) this.deps.fast.after(SEGMENT_MS, this.onSeal, shard)
    // Nobody reads the stream: there is nothing to keep records for.
    if (this.readers.count === 0) shard.drop(shard.sealed)
  }

  private readonly onSeal = (shard: Shard): void => {
    if (!shard.seal(this.deps.fast.now())) return
    this.readers.sealed(shard)
    if (this.readers.count === 0) shard.drop(shard.sealed)
  }

  // ---- consumers ---------------------------------------------------------------------------------------------

  /** Register a consumer. It starts at the end of every open shard (LATEST), as a mapping created now would. */
  subscribe<L>(spec: ConsumerSpec<L>): Subscription<L> {
    return this.readers.subscribe(spec, this.open)
  }

  /** Whether a consumer reads through enhanced fan-out (it asks to, and is among the first 20). */
  efoOf<L>(sub: Subscription<L>): boolean {
    return this.readers.efoOf(sub)
  }

  /** Whether a consumer asks for enhanced fan-out beyond the 20 a stream can register (it reads nothing). */
  efoRefused<L>(sub: Subscription<L>): boolean {
    return this.readers.efoRefused(sub)
  }

  /** Send a record of discarded records to the on-failure destination. */
  discard(message: Message): void {
    this.deps.discard(message)
  }

  /** A consumer found `records` past retention before it read them. */
  expired(records: number): void {
    this.deps.tallies.expired.add(records)
  }

  /** How long records stay readable, as configured now. */
  retention(): Duration.Duration {
    return this.deps.fast.settings().retention
  }

  // ---- shards ------------------------------------------------------------------------------------------------

  /** Replace the open shards with `count` shards of equal width, children of the old ones they overlap (UpdateShardCount). */
  private reshape(count: number, old: ReadonlyArray<Shard>): void {
    const { fast } = this.deps
    const now = fast.now()
    for (const shard of old) shard.close(now)
    const next: Array<Shard> = []
    for (let i = 0; i < count; i++) {
      const lo = i / count
      const hi = i === count - 1 ? 1 : (i + 1) / count
      next.push(this.create(lo, hi, old.filter((p) => p.lo < hi && p.hi > lo), now))
    }
    this.open = next
    for (const shard of old) this.readers.closed(shard)
  }

  /** Split one shard in two at the middle of its range (on-demand). */
  private split(shard: Shard): void {
    const now = this.deps.fast.now()
    shard.close(now)
    const mid = (shard.lo + shard.hi) / 2
    const a = this.create(shard.lo, mid, [shard], now)
    const b = this.create(mid, shard.hi, [shard], now)
    const at = this.open.indexOf(shard)
    this.open.splice(at, 1, a, b)
    this.deps.tallies.splits.add(1)
    this.readers.closed(shard)
  }

  private create(lo: number, hi: number, parents: ReadonlyArray<Shard>, now: number): Shard {
    const shard = new Shard(this.nextId++, lo, hi, parents, now, this.burst(this.deps.fast.settings()))
    for (const p of parents) p.children.push(shard)
    this.shards.push(shard)
    this.readers.created(shard)
    return shard
  }

  // ---- the periodic look: scaling, trimming --------------------------------------------------------------------

  private readonly tick = (): void => {
    const { fast } = this.deps
    const now = fast.now()
    const c = fast.settings()
    const elapsed = now - this.lastTick
    this.lastTick = now
    if (c.mode !== this.modeWas) {
      // Switching modes keeps the shards there are; from now on either the owner or on-demand scales them.
      this.modeWas = c.mode
      this.updating = undefined
      for (const s of this.open) s.splitAt = -1
    }
    for (const shard of this.open) shard.observe(elapsed)
    if (c.mode === "on-demand") this.scaleOnDemand(now, c)
    else this.scaleProvisioned(now, c)
    this.trim()
    fast.after(TICK_MS, this.tick, undefined)
  }

  /**
   * On-demand: a shard whose incoming traffic (offered, throttled or not) has averaged over 500 KB/s, or 500 records/s,
   * is split `splitDelay` later. Capacity therefore follows the peak with headroom of about double, and traffic that
   * more than doubles faster than the splits come is throttled meanwhile. The stream never grows past its quota.
   */
  private scaleOnDemand(now: number, c: StreamConfig): void {
    const account = this.deps.fast.account() as Account
    const cap = Math.max(ON_DEMAND_INITIAL_SHARDS, Math.floor((account.kinesisOnDemandWriteMBps * 1_000_000) / SHARD_WRITE_BYTES))
    const delay = Duration.toMillis(c.splitDelay)
    for (const shard of this.open.slice()) {
      const hot = shard.rateBytes > ON_DEMAND_SPLIT_BYTES || shard.rateRecords > ON_DEMAND_SPLIT_RECORDS
      if (shard.splitAt < 0) {
        if (hot) shard.splitAt = now + delay
      } else if (now >= shard.splitAt && this.open.length < cap) {
        this.split(shard)
      }
    }
  }

  /**
   * Provisioned: bring the open shards to the configured count with UpdateShardCount steps, each at most double or half
   * the current count, a few minutes long, and no more than ten in a rolling 24 hours.
   */
  private scaleProvisioned(now: number, c: StreamConfig): void {
    if (this.updating !== undefined) {
      if (now < this.updating.doneAt) return
      const { target } = this.updating
      this.updating = undefined
      this.deps.tallies.reshards.add(1)
      this.reshape(target, this.open)
    }
    const current = this.open.length
    const desired = Math.min(c.shards, MAX_SHARDS_PER_STREAM)
    while (this.updates.length > 0 && now - this.updates[0]! >= DAY_MS) this.updates.shift()
    this.waiting = desired !== current && this.updates.length >= UPDATE_SHARD_COUNT_PER_DAY
    if (desired === current || this.waiting) return
    const target = Math.min(Math.max(desired, Math.ceil(current / 2)), current * 2)
    this.updates.push(now)
    this.updating = { target, doneAt: now + RESHARD_MS }
  }

  /** Forget segments every consumer is past, and closed shards every consumer has finished. */
  private trim(): void {
    const keep: Array<Shard> = []
    for (const shard of this.shards) {
      const { low, finished } = this.readers.needs(shard, shard.sealed)
      shard.drop(low)
      if (!shard.open && finished && shard.held === 0) {
        this.readers.forget(shard)
        continue
      }
      keep.push(shard)
    }
    if (keep.length !== this.shards.length) {
      this.shards.length = 0
      this.shards.push(...keep)
    }
  }

  // ---- what the stream reports ---------------------------------------------------------------------------------

  /** The worst consumer's lag: the oldest record any consumer has still to process, and the most records one has still to process. */
  lag(now: number): Lag {
    return this.readers.lag(now)
  }

  /** Records held across shards. */
  retained(): number {
    let n = 0
    for (const s of this.shards) n += s.retained()
    return n
  }

  consumers(now: number): ReadonlyArray<{ name: string; efo: boolean; refused: boolean; ageMs: number; records: number }> {
    return this.readers.consumers(now)
  }

  /** Each open shard's smoothed incoming rate, for the probe. */
  openShards(): ReadonlyArray<Shard> {
    return this.open
  }

  get updatesToday(): number {
    return this.updates.length
  }
}
