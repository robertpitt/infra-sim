import { SubscriptionRef } from "effect"
import type { Fast, PortConfig } from "../../../Component.ts"
import * as Distribution from "../../../Distribution.ts"
import type { Link } from "../../../Edge.ts"
import type { Message } from "../../../Message.ts"
import type { Outbox } from "../../../kit/Outbox.ts"
import { chance, passes } from "../../../kit/Shape.ts"
import type { Sampler } from "../../../Telemetry.ts"
import type { Account } from "../../internal/account.ts"
import type { Config, ports } from "./config.ts"
import { EVENT_BYTES } from "./limits.ts"

/**
 * What a bucket does after a write has been answered, for `S3`: event notifications to the destinations subscribed to
 * that kind of change, and replicas to the buckets its replication rules name. Both go out through an `Outbox`, off the
 * request path.
 */

/**
 * The most separate notification messages one call fans out into. S3 sends one event per object; a message that
 * stands for thousands of requests (a batch) is sent as this many messages carrying the events between them, so one
 * call can never arm an unbounded number of timers.
 */
const MAX_EVENT_MESSAGES = 100

/**
 * Replicas carry this message group so the destination can tell them from a client's writes: S3 does not replicate a
 * replica again (that needs Batch Replication), which keeps two buckets replicating to each other from looping.
 */
const REPLICA_GROUP = "s3:replica"

/** Bytes a second at `gbps` gigabits a second, per millisecond. */
const bytesPerMsAt = (gbps: number): number => (gbps * 1e9) / 8 / 1000

/** One bucket's destinations, and what it sends to them through. */
export interface Fanout {
  readonly fast: Fast<Config>
  readonly events: ReadonlyArray<Link<PortConfig<typeof ports.events>>>
  readonly replicas: ReadonlyArray<Link<PortConfig<typeof ports.replication>>>
  readonly notifications: Outbox
  readonly replication: Outbox
  /** Replication Time Control moves data through one pipe per account and region, shared by every bucket in it. */
  readonly pipe: { busyUntil: number }
  readonly replicationLag: Sampler
}

/** One event per object created (`created`) or removed, to every destination subscribed to that kind. */
export const notify = (f: Fanout, message: Message, objects: number, created: boolean): void => {
  const { fast, notifications } = f
  const c = fast.settings()
  // An S3 notification has no message group, whatever the client's request had.
  const { group: _group, firstEnqueuedAt: _enqueued, ...base } = message
  const messages = Math.min(objects, MAX_EVENT_MESSAGES)
  const each = Math.floor(objects / messages)
  const extra = objects - each * messages
  for (const link of f.events) {
    const subscription = SubscriptionRef.getUnsafe(link.config)
    if (subscription.eventTypes !== "all" && (subscription.eventTypes === "created") !== created) continue
    for (let i = 0; i < messages; i++) {
      if (!passes(fast.random, subscription.filter)) continue
      const event: Message = { ...base, bytes: EVENT_BYTES, count: each + (i < extra ? 1 : 0), operation: "write", invocation: "async" }
      // S3 calls Lambda asynchronously. The delay is S3's own, before any network hop.
      notifications.send(link, event, Distribution.latencyMs(c.notificationDelay, fast.random))
      // At-least-once: some are delivered twice, each copy on its own delay.
      if (chance(fast.random, c.duplicateRate)) notifications.send(link, event, Distribution.latencyMs(c.notificationDelay, fast.random))
    }
  }
}

/**
 * Copy a new object to every replication destination, after the replication delay. With Replication Time Control
 * the bytes also queue through the account's RTC pipe, so a region replicating more than its quota falls behind.
 */
export const replicate = (f: Fanout, message: Message, bytes: number): void => {
  if (f.replicas.length === 0 || message.group === REPLICA_GROUP) return
  const { fast, pipe, replicationLag } = f
  const c = fast.settings()
  for (const link of f.replicas) {
    if (!passes(fast.random, SubscriptionRef.getUnsafe(link.config).filter)) continue
    const now = fast.now()
    let lag = Distribution.latencyMs(c.replicationDelay, fast.random)
    if (c.replicationTimeControl) {
      const rate = bytesPerMsAt((fast.account() as Account).s3ReplicationTransferRate)
      const start = pipe.busyUntil > now ? pipe.busyUntil : now
      pipe.busyUntil = start + bytes / rate
      lag = Math.max(lag, pipe.busyUntil - now)
    }
    const replica: Message = { ...message, bytes, operation: "write", invocation: "async", group: REPLICA_GROUP }
    f.replication.send(link, replica, lag, 1, (failure) => failure === undefined && replicationLag.add(fast.now() - now))
  }
}
