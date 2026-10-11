import { SubscriptionRef } from "effect"
import type * as Edge from "../../Edge.ts"
import type { CallFailure, Message } from "../../Message.ts"
import { Destination, EVENT_BYTES, EVENT_KINDS, type EventKind } from "./config.ts"

type Dest = Edge.Config & typeof Destination.Type

const BIT: Record<EventKind, number> = {} as Record<EventKind, number>
EVENT_KINDS.forEach((kind, i) => {
  BIT[kind] = 1 << i
})

const maskOf = (events: Dest["events"]): number => {
  let mask = 0
  for (const kind of EVENT_KINDS) if (events[kind]) mask |= BIT[kind]
  return mask
}

/**
 * Publishes sending events to whatever is wired to the `events` port: a configuration set's event destinations.
 *
 * Each destination chooses the event types it receives (its matching event types), so what a link wants is read from its
 * live settings. That read is memoised against the identity of the settings object, so a publish costs a mask test per
 * link, and an edit made while running applies to the next event. Publishing is fire and forget: the destination's
 * latency, retries and failures never reach the sender, which is how SES treats event publishing.
 */
export class Publisher {
  /** Events handed to destinations that have not yet been taken or given up on. */
  pending = 0
  private readonly seen: Array<unknown>
  private readonly masks: Int32Array
  private any = 0

  constructor(
    private readonly links: ReadonlyArray<Edge.Link<Dest>>,
    private readonly onDone: (failure: CallFailure | undefined) => void
  ) {
    this.seen = links.map(() => undefined)
    this.masks = new Int32Array(links.length)
  }

  private refresh(): void {
    let any = 0
    for (let i = 0; i < this.links.length; i++) {
      const config = SubscriptionRef.getUnsafe(this.links[i]!.config)
      if (config !== this.seen[i]) {
        this.seen[i] = config
        this.masks[i] = maskOf(config.events)
      }
      any |= this.masks[i]!
    }
    this.any = any
  }

  /** Whether any destination wants this kind of event (so that nothing is drawn for events nobody receives). */
  wants(kind: EventKind): boolean {
    this.refresh()
    return (this.any & BIT[kind]) !== 0
  }

  /** Send one event carrying `count` recipients to every destination that wants it. */
  publish(kind: EventKind, source: Message, count: number): void {
    if (count <= 0 || this.links.length === 0) return
    this.refresh()
    const bit = BIT[kind]
    if ((this.any & bit) === 0) return
    // SES publishes to SNS, Firehose and EventBridge, and Lambda hears of events through SNS or SQS: all asynchronous.
    const event: Message = { ...source, bytes: EVENT_BYTES, count, operation: "write", invocation: "async" }
    for (let i = 0; i < this.links.length; i++) {
      if ((this.masks[i]! & bit) === 0) continue
      this.pending++
      this.links[i]!.send(event, this.finished)
    }
  }

  private readonly finished = (failure: CallFailure | undefined): void => {
    this.pending--
    this.onDone(failure)
  }
}
