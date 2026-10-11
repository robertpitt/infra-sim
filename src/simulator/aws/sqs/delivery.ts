import { Duration } from "effect"
import type { Fast } from "../../Component.ts"
import type { Link } from "../../Edge.ts"
import type { Message } from "../../Message.ts"
import type { TimerHandle } from "../../VirtualTime.ts"
import { DLQ_RETRY_MS, type QueueConfig } from "./config.ts"
import type { Tallies } from "./metrics.ts"
import type { QueueStore } from "./store.ts"
import type { Delivery, Entry } from "./types.ts"

export interface DeliveryEnv {
  readonly store: QueueStore
  readonly fast: Fast<QueueConfig>
  readonly tallies: Tallies
  /** The dead-letter queue's edge, if one is wired. */
  readonly dlq: () => Link | undefined
  /** Ids of messages this queue is sending to another queue itself (see `Sqs.ts`): the receiver treats them as internal moves. */
  readonly transit: Set<number>
  /** Something became receivable or a group was released: let the pollers look. */
  readonly wake: () => void
}

/**
 * The life of a message once a consumer has it: the receive that hides it, the visibility timeout that returns it, the
 * delete that ends it, and the move to the dead-letter queue when it has been received too often.
 *
 * Each ReceiveMessage is one {@link Delivery} with its own receipt and its own visibility timer. A message knows which
 * receipt owns it. That is the whole at-least-once story: if a consumer is slower than the visibility timeout the message
 * is received again under a new receipt, and when the slow consumer finally finishes its delete is for a receipt that no
 * longer owns the message. The message stays (it will be, or already was, delivered again) and the work counts as a
 * duplicate.
 */
export class Deliveries {
  private receipts = 0
  /** Messages whose move to the dead-letter queue was refused, waiting to be tried again. They stay in flight, so a FIFO group stays blocked. */
  private parked: Array<Entry> = []
  private parkedTimer: TimerHandle | undefined

  constructor(private readonly env: DeliveryEnv) {}

  get parkedCount(): number {
    return this.parked.length
  }

  /** One ReceiveMessage of at most `max` messages (at most `byteBudget` bytes), or nothing if nothing can be received. */
  receive(max: number, byteBudget: number): Delivery | undefined {
    const { store, fast, tallies } = this.env
    const receipt = ++this.receipts
    const entries: Array<Entry> = []
    const bytes = store.receive(max, receipt, byteBudget, entries)
    if (entries.length === 0) return undefined
    const delivery: Delivery = { entries, receipt, bytes, timer: undefined }
    // The visibility timeout is read when the message is received: changing it applies to the next receive.
    delivery.timer = fast.after(Duration.toMillis(fast.settings().visibilityTimeout), this.lapse, delivery)
    tallies.received.add(entries.length)
    return delivery
  }

  /** The consumer finished: delete what this receive still owns. Returns how many were deleted. */
  ack(delivery: Delivery): number {
    const { store, tallies } = this.env
    let deleted = 0
    let duplicates = 0
    for (const entry of delivery.entries) {
      if (entry.receipt === delivery.receipt) {
        // Still this receive's: delete it (unless it left some other way, such as retention).
        if (entry.status === "hidden") {
          store.remove(entry)
          deleted++
        }
      } else duplicates++
    }
    delivery.timer?.cancel()
    delivery.timer = undefined
    tallies.deleted.add(deleted)
    tallies.duplicates.add(duplicates)
    if (deleted > 0) this.env.wake()
    return deleted
  }

  /** The visibility timeout ran out: whatever this receive still owns comes back, or goes to the dead-letter queue. */
  readonly lapse = (delivery: Delivery): void => {
    const { store, fast, tallies } = this.env
    delivery.timer = undefined
    const { maxReceives } = fast.settings()
    const dlq = this.env.dlq()
    let returned = 0
    // Last to first, so a FIFO group gets its messages back in their original order at the head of the group.
    for (let i = delivery.entries.length - 1; i >= 0; i--) {
      const entry = delivery.entries[i]!
      if (entry.status !== "hidden" || entry.receipt !== delivery.receipt) continue
      if (dlq !== undefined && entry.receives >= maxReceives) {
        entry.receipt = -1 // no longer any receive's: it is on its way out
        this.forward(entry, dlq)
      } else {
        store.giveBack(entry)
        returned++
      }
    }
    tallies.redelivered.add(returned)
    this.env.wake()
  }

  /**
   * Send a message to the dead-letter queue. A standard queue's dead-letter queue keeps counting retention from the
   * original enqueue time; a FIFO queue's restarts it, so the message goes without one.
   */
  private forward(entry: Entry, dlq: Link): void {
    const { store, fast, tallies, transit } = this.env
    const { firstEnqueuedAt: _carried, ...rest } = entry.message
    const message: Message = {
      ...rest,
      id: fast.mint().id,
      count: 1,
      bytes: entry.bytes,
      attempt: entry.receives,
      ...(entry.group === undefined ? {} : { group: entry.group.id }),
      ...(store.fifo ? {} : { firstEnqueuedAt: entry.enqueuedAt })
    }
    transit.add(message.id)
    dlq.send(message, (failure) => {
      transit.delete(message.id)
      if (entry.status !== "hidden") return // retention got there first
      if (failure === undefined) {
        store.remove(entry)
        tallies.deadLettered.add(1)
        this.env.wake()
      } else {
        tallies.dlqFailed.add(1)
        this.parked.push(entry)
        this.parkedTimer ??= fast.after(DLQ_RETRY_MS, this.retryParked, undefined)
      }
    })
  }

  private readonly retryParked = (): void => {
    this.parkedTimer = undefined
    const waiting = this.parked
    this.parked = []
    const dlq = this.env.dlq()
    for (const entry of waiting) {
      if (entry.status !== "hidden") continue
      if (dlq !== undefined) this.forward(entry, dlq)
    }
  }
}
