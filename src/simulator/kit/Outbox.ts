import type { Fast } from "../Component.ts"
import type { Link } from "../Edge.ts"
import type { CallFailure, Message } from "../Message.ts"
import type { Tally } from "./Tally.ts"

/**
 * Work a node does after it has answered: a notification, a replica, a delivery to a subscriber.
 *
 * Each is the same small machine: wait a delay, send through the edge (which owns latency, retries and faults), then
 * count how it ended. The `Outbox` is that machine, so a service says what to send and after how long, and gets the
 * `pending` gauge and the delivered and undelivered counts without writing them again.
 */
export class Outbox {
  /** Sent shipments that have not yet been answered, or are still waiting out their delay. */
  pending = 0

  constructor(
    private readonly fast: Pick<Fast<unknown>, "after">,
    /** Counts what arrived. */
    readonly delivered: Tally,
    /** Counts what the edge gave up on. */
    readonly undelivered: Tally
  ) {}

  /**
   * Send `message` through `link` after `delayMs` (at once when there is none). `count` is how many records it stands for, so batches are counted in
   * records. `done` hears the outcome once the tally has recorded it.
   */
  send(link: Pick<Link, "send">, message: Message, delayMs: number, count = 1, done?: (failure: CallFailure | undefined) => void): void {
    const shipment = new Shipment(this, link, message, count, done)
    this.pending++
    if (delayMs > 0) this.fast.after(delayMs, fire, shipment)
    else fire(shipment)
  }

  /** @internal */
  land(count: number, failure: CallFailure | undefined): void {
    this.pending--
    ;(failure === undefined ? this.delivered : this.undelivered).add(count)
  }
}

class Shipment {
  constructor(
    private readonly outbox: Outbox,
    readonly link: Pick<Link, "send">,
    readonly message: Message,
    private readonly count: number,
    private readonly done: ((failure: CallFailure | undefined) => void) | undefined
  ) {}

  readonly landed = (failure: CallFailure | undefined): void => {
    this.outbox.land(this.count, failure)
    this.done?.(failure)
  }
}

const fire = (shipment: Shipment): void => void shipment.link.send(shipment.message, shipment.landed)
