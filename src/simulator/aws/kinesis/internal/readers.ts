import type { Fast } from "../../../Component.ts"
import type { Tally } from "../../../kit/Tally.ts"
import type { TimerHandle } from "../../../VirtualTime.ts"
import type { ConsumerSpec, Lag, Progress } from "../Readers.ts"
import { EFO_CONSUMERS, EFO_READ_BYTES, GET_RECORDS_MAX_BYTES, GET_RECORDS_MAX_RECORDS, READ_THROTTLE_WAIT_MS } from "./config.ts"
import { Allowance, type Shard } from "./log.ts"

/**
 * How a stream's consumers read it, for `Readers.ts` and the stream (`stream.ts`): a `Subscription` per consumer with a
 * `Cursor` per shard, and `Readers`, the stream's side of them, which runs the GetRecords polls and the enhanced fan-out
 * pushes against the shards' read limits and starts a child shard once a consumer has finished its parents.
 */

/** What reading counts on the stream's meter (the stream's README maps them to CloudWatch). */
export interface ReadTallies {
  /** GetRecords calls, the records and bytes they returned, and ReadProvisionedThroughputExceeded. */
  readonly getRecords: Tally
  readonly outgoing: Tally
  readonly outgoingBytes: Tally
  readonly readThrottled: Tally
  /** Records pushed to enhanced fan-out consumers (SubscribeToShardEvent.Records). */
  readonly pushed: Tally
}

/** One consumer's place in one shard. */
export class Cursor<L> {
  local!: L
  /** Segments below this absolute index have been read (fetched or pushed) and are the consumer's to process. */
  fetched: number
  /** The lowest segment the consumer still needs: the stream may forget what is below every consumer's. */
  low: number
  /** Readable: every parent shard has been read to its end by this consumer. */
  active = false
  /** Read to its end and processed (the shard is closed). */
  finished = false
  /** The consumer wants more records than it has. */
  wanting = false
  timer: TimerHandle | undefined
  lastPoll = Number.NEGATIVE_INFINITY
  /** Enhanced fan-out: this consumer's own allowance from the shard. */
  allowance: Allowance | undefined
  /** @internal Inside the consumer's `wake`, and whether more arrived meanwhile (it is woken again, not re-entered). */
  waking = false
  again = false

  constructor(readonly sub: Subscription<L>, readonly shard: Shard, start: number) {
    this.fetched = start
    this.low = start
  }

  /** Nothing more will be fetched: the shard is closed and everything in it has been read. */
  get exhausted(): boolean {
    return !this.shard.open && this.fetched >= this.shard.end
  }
}

/**
 * Records written to the cursor's shard before the cursor's starting point: none for a shard read from its start (a
 * child of a reshard), all of them for a consumer that started at LATEST. What a consumer has still to process is the
 * shard's total less these and less what it has processed.
 */
export const before = <L>(cursor: Cursor<L>): number => (cursor.fetched >= cursor.shard.end ? cursor.shard.total : 0)

/** One consumer's reading of the stream: a cursor per shard. */
export class Subscription<L> {
  readonly cursors = new Map<Shard, Cursor<L>>()

  constructor(private readonly readers: Readers, readonly spec: ConsumerSpec<L>) {}

  /** The consumer needs more records from this shard. */
  want(cursor: Cursor<L>): void {
    this.readers.want(cursor)
  }

  /** The consumer no longer needs segments below `abs`. */
  release(cursor: Cursor<L>, abs: number): void {
    if (abs > cursor.low) cursor.low = abs
  }

  /** The consumer has processed everything in a closed shard: its children may be read. */
  finish(cursor: Cursor<L>): void {
    if (cursor.finished) return
    cursor.finished = true
    cursor.low = cursor.shard.end
    cursor.timer?.cancel()
    cursor.timer = undefined
    this.readers.activateChildren(this, cursor.shard)
  }

  /** Cursors this consumer is reading now. */
  *active(): Iterable<Cursor<L>> {
    for (const c of this.cursors.values()) if (c.active && !c.finished) yield c
  }

  /** Shards this consumer is reading now. */
  get reading(): number {
    let n = 0
    for (const _ of this.active()) n++
    return n
  }
}

// biome-ignore lint/suspicious/noExplicitAny: subscriptions of different consumers are held together; each only ever sees its own.
type AnySubscription = Subscription<any>
// biome-ignore lint/suspicious/noExplicitAny: as above.
type AnyCursor = Cursor<any>

/** The stream's side of its consumers: every subscription, and the reading they do against the shards. */
export class Readers {
  private readonly subs: Array<AnySubscription> = []

  constructor(private readonly fast: Pick<Fast<unknown>, "now" | "after">, private readonly tallies: ReadTallies) {}

  get count(): number {
    return this.subs.length
  }

  /** Register a consumer. It starts at the end of every open shard (LATEST), as a mapping created now would. */
  subscribe<L>(spec: ConsumerSpec<L>, open: ReadonlyArray<Shard>): Subscription<L> {
    const sub = new Subscription<L>(this, spec)
    this.subs.push(sub)
    for (const shard of open) {
      const cursor = new Cursor(sub, shard, shard.end)
      sub.cursors.set(shard, cursor)
      this.activate(cursor)
    }
    return sub
  }

  /**
   * Whether a consumer reads through enhanced fan-out: it asks to, and is among the first 20 that do (a stream can
   * register no more). Registration order is the order the consumers were wired.
   */
  efoOf(sub: AnySubscription): boolean {
    if (!sub.spec.efo()) return false
    let before = 0
    for (const other of this.subs) {
      if (other === sub) break
      if (other.spec.efo()) before++
    }
    return before < EFO_CONSUMERS
  }

  /** Consumers asking for enhanced fan-out beyond the 20 a stream can register: they read nothing. */
  efoRefused(sub: AnySubscription): boolean {
    return sub.spec.efo() && !this.efoOf(sub)
  }

  // ---- shards coming and going -------------------------------------------------------------------------------

  /** A new shard: every consumer gets a cursor at its start, readable once it has finished the parents. */
  created(shard: Shard): void {
    for (const sub of this.subs) sub.cursors.set(shard, new Cursor(sub, shard, 0))
  }

  /** A shard has closed: its readers may have read it all already, and a child with no parents left to wait for may start. */
  closed(shard: Shard): void {
    for (const sub of this.subs) {
      const cursor = sub.cursors.get(shard)
      if (cursor !== undefined && cursor.active && !cursor.finished) sub.spec.wake(cursor)
      this.activateChildren(sub, shard)
    }
  }

  /** New records in `shard` became readable: push them to enhanced fan-out readers, tell the others. */
  sealed(shard: Shard): void {
    for (const sub of this.subs) {
      const cursor = sub.cursors.get(shard)
      if (cursor === undefined || !cursor.active || cursor.finished) continue
      if (this.efoOf(sub)) this.push(cursor)
      else sub.spec.sealed?.(cursor)
    }
  }

  /** The lowest segment of `shard` any consumer still needs, or `upTo` if none does; and whether every consumer has finished it. */
  needs(shard: Shard, upTo: number): { readonly low: number; readonly finished: boolean } {
    let low = upTo
    let finished = true
    for (const sub of this.subs) {
      const cursor = sub.cursors.get(shard)
      if (cursor === undefined) continue
      if (cursor.low < low) low = cursor.low
      if (!cursor.finished) finished = false
    }
    return { low, finished }
  }

  /** A shard the stream no longer holds. */
  forget(shard: Shard): void {
    for (const sub of this.subs) sub.cursors.delete(shard)
  }

  private activate(cursor: AnyCursor): void {
    cursor.active = true
    cursor.local = cursor.sub.spec.start(cursor)
    this.want(cursor)
  }

  /** @internal A consumer has finished `parent`: start each child all of whose parents it has finished. */
  activateChildren(sub: AnySubscription, parent: Shard): void {
    for (const child of parent.children) {
      const cursor = sub.cursors.get(child)
      if (cursor === undefined || cursor.active) continue
      if (child.parents.every((p) => sub.cursors.get(p)?.finished ?? true)) this.activate(cursor)
    }
  }

  // ---- reading -----------------------------------------------------------------------------------------------

  /** @internal The consumer of `cursor` needs records. */
  want(cursor: AnyCursor): void {
    cursor.wanting = true
    if (!cursor.active || cursor.finished || cursor.timer !== undefined) return
    const sub = cursor.sub
    if (this.efoOf(sub)) return this.push(cursor)
    if (this.efoRefused(sub)) return
    const now = this.fast.now()
    const due = cursor.lastPoll + sub.spec.pollMs
    const behind = cursor.shard.sealed > cursor.fetched
    if (now >= due || (behind && sub.spec.catchUp)) this.fetch(cursor)
    else cursor.timer = this.fast.after(due - now, this.onPoll, cursor)
  }

  private readonly onPoll = (cursor: AnyCursor): void => {
    cursor.timer = undefined
    if (cursor.wanting) this.fetch(cursor)
  }

  /** One GetRecords call against the shard's shared allowance. */
  private fetch(cursor: AnyCursor): void {
    const { fast, tallies } = this
    if (cursor.finished) return
    if (cursor.exhausted) {
      cursor.wanting = false
      return cursor.sub.spec.wake(cursor)
    }
    const now = fast.now()
    const shard = cursor.shard
    if (!shard.mayRead(now)) {
      tallies.readThrottled.add(1)
      cursor.sub.spec.readThrottled?.()
      cursor.timer = fast.after(READ_THROTTLE_WAIT_MS, this.onPoll, cursor)
      return
    }
    const { records, bytes, to } = this.span(cursor, GET_RECORDS_MAX_RECORDS)
    shard.chargeRead(bytes)
    cursor.lastPoll = now
    tallies.getRecords.add(1)
    if (records === 0) {
      // Caught up: poll again at the reader's cadence while it still wants records.
      cursor.timer = fast.after(cursor.sub.spec.pollMs, this.onPoll, cursor)
      return
    }
    cursor.fetched = to
    tallies.outgoing.add(records)
    tallies.outgoingBytes.add(bytes)
    cursor.sub.spec.read?.(records, bytes)
    this.deliver(cursor)
  }

  /** Enhanced fan-out: push whatever is readable, within the consumer's own allowance from the shard. */
  private push(cursor: AnyCursor): void {
    const { fast, tallies } = this
    if (cursor.finished || cursor.timer !== undefined) return
    if (cursor.exhausted) return cursor.sub.spec.wake(cursor)
    const now = fast.now()
    cursor.allowance ??= new Allowance(now, EFO_READ_BYTES)
    const wait = cursor.allowance.waitMs(now)
    if (wait > 0) {
      cursor.timer = fast.after(wait, this.onPush, cursor)
      return
    }
    const { records, bytes, to } = this.span(cursor, Number.POSITIVE_INFINITY)
    if (records === 0) return
    cursor.allowance.charge(bytes)
    cursor.fetched = to
    tallies.pushed.add(records)
    tallies.outgoingBytes.add(bytes)
    cursor.sub.spec.read?.(records, bytes)
    this.deliver(cursor)
  }

  private readonly onPush = (cursor: AnyCursor): void => {
    cursor.timer = undefined
    this.push(cursor)
  }

  /** Readable segments from the cursor on, as many as one call returns: at most `limit` records and 10 MiB, at least one segment. */
  private span(cursor: AnyCursor, limit: number): { records: number; bytes: number; to: number } {
    const shard = cursor.shard
    let to = Math.max(cursor.fetched, shard.first)
    let records = 0
    let bytes = 0
    while (to < shard.sealed) {
      const s = shard.at(to)!
      if (records > 0 && (records + s.count > limit || bytes + s.bytes > GET_RECORDS_MAX_BYTES)) break
      records += s.count
      bytes += s.bytes
      to++
    }
    return { records, bytes, to }
  }

  /**
   * Tell the consumer it has records. A consumer that asks for more from inside `wake` (and gets them at once) is woken
   * again after it returns rather than re-entered.
   */
  private deliver(cursor: AnyCursor): void {
    cursor.wanting = false
    if (cursor.waking) {
      cursor.again = true
      return
    }
    cursor.waking = true
    try {
      do {
        cursor.again = false
        cursor.sub.spec.wake(cursor)
      } while (cursor.again)
    } finally {
      cursor.waking = false
    }
  }

  // ---- what the readers report ---------------------------------------------------------------------------------

  /** The worst consumer's lag: the oldest record any consumer has still to process, and the most records one has still to process. */
  lag(now: number): Lag {
    let ageMs = 0
    let records = 0
    for (const sub of this.subs) {
      const l = sub.spec.lag(now)
      if (l.ageMs > ageMs) ageMs = l.ageMs
      if (l.records > records) records = l.records
    }
    return { ageMs, records }
  }

  consumers(now: number): ReadonlyArray<{ name: string; efo: boolean; refused: boolean; ageMs: number; records: number }> {
    return this.subs.map((sub) => {
      const l = sub.spec.lag(now)
      return { name: sub.spec.name, efo: this.efoOf(sub), refused: this.efoRefused(sub), ageMs: l.ageMs, records: l.records }
    })
  }
}

/**
 * A consumer's lag over its subscription: the arrival of the oldest record it has still to process, over every shard not
 * finished (`oldest` says where that is in one shard, or `Infinity`), and how many records it has still to process. A
 * shard it is reading counts what came after its start (`base`) less what it has processed (`done`); a child shard
 * waiting for its parents counts everything in it.
 */
export const lagOf = <L extends Progress>(sub: Subscription<L>, now: number, oldest: (cursor: Cursor<L>) => number): Lag => {
  let at = now
  let records = 0
  for (const cursor of sub.cursors.values()) {
    if (cursor.finished) continue
    const o = oldest(cursor)
    if (o < at) at = o
    records += cursor.active ? Math.max(0, cursor.shard.total - cursor.local.base - cursor.local.done) : cursor.shard.total
  }
  return { ageMs: now - at, records }
}

/** `lagOf`, worked out once an instant: several gauges ask at each frame. `sub` is read when first asked. */
export const lagMeter = <L extends Progress>(sub: () => Subscription<L>, oldest: (cursor: Cursor<L>) => number): ((now: number) => Lag) => {
  let at = -1
  let was: Lag = { ageMs: 0, records: 0 }
  return (now) => {
    if (now === at) return was
    at = now
    was = lagOf(sub(), now, oldest)
    return was
  }
}
