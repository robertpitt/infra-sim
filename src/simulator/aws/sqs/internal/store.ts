import type { Message } from "../../../Message.ts"
import { POISON_RECEIVES } from "./config.ts"
import { Deque } from "./deque.ts"
import { RetentionIndex } from "./retention.ts"
import type { Entry, Group } from "./types.ts"

/** More tombstones than this (and more than live items) and a queue rebuilds itself. */
const COMPACT_AT = 1_024
const COMPACT_GROUP_AT = 64

/**
 * The messages in one queue and where each one is: waiting to be received, delayed, in flight.
 *
 * This is the data structure only. It knows nothing of timers, consumers or dead-letter queues; whoever drives it
 * (see `delivery.ts`, `pull.ts`) decides when a message is received, comes back or is deleted, and the store keeps the
 * books (the counts behind the visible / not-visible / delayed gauges, which FIFO groups are blocked) and makes each
 * step cheap, so a queue holding hundreds of thousands of messages costs the same per message as one holding ten:
 *
 *  - a standard queue's waiting messages are one {@link Deque}; a FIFO queue's are one deque per message group, plus a
 *    deque of the groups that can be received from (waiting messages, nothing in flight);
 *  - messages are also filed by enqueue second in a {@link RetentionIndex}, which serves retention and the oldest-message gauge;
 *  - a message that leaves while still sitting in a deque (it expired before anyone received it) is not searched for. It is
 *    left as a tombstone for the next reader to skip, and the deque is rebuilt once tombstones outnumber live items.
 *    That keeps a queue nobody reads (a dead-letter queue) from filling with the carcasses of what retention deleted.
 */
export class QueueStore {
  /** The three gauges, kept as plain counters. */
  readonly counts = { ready: 0, hidden: 0, delayed: 0 }
  readonly index = new RetentionIndex()
  /** FIFO: message groups with at least one message in the queue. A group is dropped when its last message leaves. */
  readonly groups = new Map<string, Group>()
  /** FIFO: message groups with at least one message in flight (ApproximateNumberOfGroupsWithInflightMessages). */
  inflightGroups = 0

  private readonly standardReady = new Deque<Entry>()
  private readyDead = 0
  private readonly available = new Deque<Group>()
  private availableStale = 0
  private ids = 0

  constructor(readonly fifo: boolean) {}

  group(id: string): Group {
    let g = this.groups.get(id)
    if (g === undefined) {
      g = { id, items: new Deque(), waiting: 0, hidden: 0, live: 0, dead: 0, queued: false, tokens: 0, tokensAt: -1 }
      this.groups.set(id, g)
    }
    return g
  }

  /** Forget a group that holds nothing (one created to check a limit for a message that was then refused). */
  dropIfEmpty(g: Group): void {
    if (g.live === 0 && this.groups.get(g.id) === g) this.groups.delete(g.id)
  }

  /**
   * Take in one record. `enqueuedAt` is what retention counts from. A `delayed` record is invisible until `activate`.
   */
  admit(message: Message, bytes: number, enqueuedAt: number, delayed: boolean): Entry {
    const g = this.fifo ? this.group(message.group ?? "default") : undefined
    const entry: Entry = {
      id: ++this.ids,
      message,
      bytes,
      group: g,
      enqueuedAt,
      receives: 0,
      receipt: 0,
      status: delayed ? "delayed" : "ready",
      bucket: this.index.bucketFor(enqueuedAt),
      slot: 0,
      aged: !delayed
    }
    this.index.insert(entry)
    if (g !== undefined) g.live++
    if (delayed) this.counts.delayed++
    else this.enqueueReady(entry, false)
    return entry
  }

  /** The delay is over: a delayed message becomes receivable. */
  activate(entry: Entry): void {
    if (entry.status !== "delayed") return
    this.counts.delayed--
    entry.status = "ready"
    this.index.setAged(entry, true)
    this.enqueueReady(entry, false)
  }

  /** Whether something may be receivable. Stale entries make this optimistic; `receive` is the authority. */
  hasWork(): boolean {
    return this.fifo ? this.available.length > 0 : this.standardReady.length > 0
  }

  /**
   * One ReceiveMessage: take up to `max` messages (and stop once their size reaches `byteBudget`), hide them under
   * `receipt`, and add them to `out`. Returns the bytes taken.
   *
   * A standard queue gives whatever is next. A FIFO queue gives messages from groups with nothing in flight, in order
   * within each group and possibly from several groups in one call: it fills the call from the first group, then the
   * next, and blocks every group it took from until those messages are deleted or come back.
   */
  receive(max: number, receipt: number, byteBudget: number, out: Array<Entry>): number {
    let bytes = 0
    let taken = 0
    if (!this.fifo) {
      while (taken < max && bytes < byteBudget) {
        const e = this.nextStandard()
        if (e === undefined) break
        this.hide(e, receipt)
        out.push(e)
        bytes += e.bytes
        taken++
      }
      return bytes
    }
    while (taken < max && bytes < byteBudget) {
      const g = this.available.shift()
      if (g === undefined) break
      g.queued = false
      if (g.hidden > 0 || g.waiting === 0) {
        if (this.availableStale > 0) this.availableStale--
        continue
      }
      while (taken < max && bytes < byteBudget && g.waiting > 0) {
        const e = g.items.shift()
        if (e === undefined) break
        if (e.status !== "ready") {
          g.dead--
          continue
        }
        this.hide(e, receipt)
        out.push(e)
        bytes += e.bytes
        taken++
      }
    }
    return bytes
  }

  /** The visibility timeout passed without a delete: the message becomes receivable again. */
  giveBack(entry: Entry): void {
    if (entry.status !== "hidden") return
    this.counts.hidden--
    entry.status = "ready"
    entry.receipt = 0
    const g = entry.group
    if (g !== undefined && --g.hidden === 0) this.inflightGroups--
    // A standard queue puts it at the back (ordering is best effort); a FIFO queue puts it at the head of its group,
    // and the caller returns a delivery's messages last to first so they come back in their original order.
    this.enqueueReady(entry, true)
  }

  /** The message leaves the queue: deleted, expired, or moved to a dead-letter queue. */
  remove(entry: Entry): void {
    const was = entry.status
    if (was === "gone") return
    entry.status = "gone"
    const g = entry.group
    if (was === "delayed") this.counts.delayed--
    else if (was === "ready") {
      this.counts.ready--
      if (g === undefined) {
        this.readyDead++
        if (this.readyDead > COMPACT_AT && this.readyDead > this.counts.ready) {
          this.standardReady.retain((e) => e.status === "ready")
          this.readyDead = 0
        }
      } else {
        g.waiting--
        g.dead++
        if (g.waiting === 0) {
          // Nothing live left in the deque: everything in it is a tombstone.
          g.items.clear()
          g.dead = 0
          if (g.queued) this.availableStale++
        } else if (g.dead > COMPACT_GROUP_AT && g.dead > g.waiting) {
          g.items.retain((e) => e.status === "ready")
          g.dead = 0
        }
      }
    } else {
      this.counts.hidden--
      if (g !== undefined && --g.hidden === 0) this.inflightGroups--
    }
    this.index.remove(entry)
    if (g !== undefined) {
      g.live--
      if (was === "hidden") this.offer(g)
      this.dropIfEmpty(g)
    }
    if (this.availableStale > COMPACT_AT && this.availableStale * 2 > this.available.length) {
      this.available.retain((x) => {
        const keep = x.waiting > 0 && x.hidden === 0
        if (!keep) x.queued = false
        return keep
      })
      this.availableStale = 0
    }
  }

  /** The age (ms) of the oldest message that counts towards ApproximateAgeOfOldestMessage, to the second. */
  oldestAgeMs(now: number): number {
    const at = this.index.oldestAt()
    return at === undefined ? 0 : Math.max(0, now - at)
  }

  /** FIFO groups that have messages waiting, and how many of those are blocked behind a message in flight. */
  groupStats(): { waiting: number; blocked: number } {
    let waiting = 0
    let blocked = 0
    for (const g of this.groups.values()) {
      if (g.waiting > 0) waiting++
      if (g.hidden > 0 && g.waiting > 0) blocked++
    }
    return { waiting, blocked }
  }

  private hide(entry: Entry, receipt: number): void {
    this.counts.ready--
    this.counts.hidden++
    entry.status = "hidden"
    entry.receipt = receipt
    entry.receives++
    const g = entry.group
    if (g !== undefined) {
      g.waiting--
      if (g.hidden++ === 0) this.inflightGroups++
    } else if (entry.receives === POISON_RECEIVES) this.index.setAged(entry, false)
  }

  private enqueueReady(entry: Entry, front: boolean): void {
    this.counts.ready++
    const g = entry.group
    if (g === undefined) {
      this.standardReady.push(entry)
      return
    }
    if (front) g.items.unshift(entry)
    else g.items.push(entry)
    g.waiting++
    this.offer(g)
  }

  /** A FIFO group can be received from when it has messages waiting and none in flight. */
  private offer(g: Group): void {
    if (g.hidden === 0 && g.waiting > 0 && !g.queued) {
      g.queued = true
      this.available.push(g)
    }
  }

  private nextStandard(): Entry | undefined {
    for (;;) {
      const e = this.standardReady.shift()
      if (e === undefined) {
        this.readyDead = 0
        return undefined
      }
      if (e.status === "ready") return e
      if (this.readyDead > 0) this.readyDead--
    }
  }
}
