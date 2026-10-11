import type { Fast } from "../../Component.ts"
import type { Link } from "../../Edge.ts"
import type { Message } from "../../Message.ts"
import { API_BATCH, MAX_BATCH_BYTES, type QueueConfig, REDRIVE_SYSTEM_VELOCITY } from "./config.ts"
import type { Deliveries, Delivery } from "./delivery.ts"
import type { Tallies } from "./metrics.ts"
import type { QueueStore } from "./store.ts"
import type { Entry } from "./types.ts"

/** While a redrive is running it moves messages in steps this long. */
const STEP_MS = 100
/** While none is running it looks again this often, which is how quickly switching `redrive` on takes effect. */
const IDLE_MS = 1_000

export interface RedriveEnv {
  readonly store: QueueStore
  readonly fast: Fast<QueueConfig>
  readonly tallies: Tallies
  readonly deliveries: Deliveries
  /** Where redriven messages go: the edge on the `redrive` port. */
  readonly destination: () => Link | undefined
  /** Ids of messages sent between queues by a redrive, so the receiving queue can tell them from a producer's (see `Sqs.ts`). */
  readonly transit: Set<number>
}

/**
 * DLQ redrive (StartMessageMoveTask): move messages out of this queue into another, oldest first, at a set velocity.
 *
 * It is the same thing a consumer does: receive a batch, send it on, delete it from here once the destination has it.
 * A message the destination refuses stays in flight here until its visibility timeout and comes back. The moved
 * messages are new messages in the destination: a new id and a new enqueue time, so retention starts over, and the
 * destination's receive count and deduplication window know nothing of their past. A message that keeps failing in the
 * destination goes round again, which is the redrive loop.
 *
 * Not modelled: a task that finishes (AWS stops after 36 hours or when the queue is empty); here it runs while `redrive`
 * is on.
 */
export class Redrive {
  private credit = 0
  private last = 0

  constructor(private readonly env: RedriveEnv) {}

  start(): void {
    this.last = this.env.fast.now()
    this.env.fast.after(IDLE_MS, this.step, undefined)
  }

  private readonly step = (): void => {
    const { fast, deliveries } = this.env
    const c = fast.settings()
    const to = this.env.destination()
    const now = fast.now()
    if (!c.redrive || to === undefined) {
      this.credit = 0
      this.last = now
      fast.after(IDLE_MS, this.step, undefined)
      return
    }
    const velocity = c.redriveVelocity > 0 ? c.redriveVelocity : REDRIVE_SYSTEM_VELOCITY
    // Credit builds with time at the velocity, and never banks more than a quarter second of it.
    this.credit = Math.min((velocity * 250) / 1000, this.credit + (velocity * (now - this.last)) / 1000)
    this.last = now
    let budget = Math.floor(this.credit)
    while (budget > 0) {
      const delivery = deliveries.receive(Math.min(API_BATCH, budget), MAX_BATCH_BYTES)
      if (delivery === undefined) break
      budget -= delivery.entries.length
      this.credit -= delivery.entries.length
      this.move(delivery, to)
    }
    fast.after(STEP_MS, this.step, undefined)
  }

  private move(delivery: Delivery, to: Link): void {
    const { store, tallies, transit } = this.env
    let remaining = delivery.entries.length
    for (const entry of delivery.entries) {
      const message = this.fresh(entry)
      transit.add(message.id)
      to.send(message, (failure) => {
        transit.delete(message.id)
        // On failure the message stays in flight here and returns when the visibility timeout lapses.
        if (failure !== undefined) return
        if (entry.status === "hidden" && entry.receipt === delivery.receipt) {
          store.remove(entry)
          tallies.redriven.add(1)
        }
        if (--remaining === 0) {
          delivery.timer?.cancel()
          delivery.timer = undefined
        }
      })
    }
  }

  /** The message as the destination sees it: new, so nothing of its life in this queue follows it. */
  private fresh(entry: Entry): Message {
    const { firstEnqueuedAt: _carried, ...rest } = entry.message
    return {
      ...rest,
      id: this.env.fast.mint().id,
      count: 1,
      bytes: entry.bytes,
      attempt: 1,
      ...(entry.group === undefined ? {} : { group: entry.group.id })
    }
  }
}
