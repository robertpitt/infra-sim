import { Tally } from "../../kit/Tally.ts"
import type { Meter } from "../../Telemetry.ts"

/**
 * What a queue counts, named after the CloudWatch metric each one stands in for (the README has the full mapping).
 * Everything is in messages, not calls: a batch of ten is ten.
 */
export const makeTallies = (meter: Meter) => {
  const t = (name: string) => new Tally(meter.counter(name))
  return {
    /** NumberOfMessagesSent: messages a caller sent that were accepted. Messages moved by a redrive policy or a redrive aren't included, as in AWS. */
    sent: t("sent"),
    /** NumberOfMessagesReceived: every message a ReceiveMessage returned, redeliveries included. */
    received: t("received"),
    /** NumberOfMessagesDeleted. */
    deleted: t("deleted"),
    /** Messages whose visibility timeout lapsed and came back. */
    redelivered: t("redelivered"),
    /** Messages moved to the dead-letter queue. */
    deadLettered: t("deadLettered"),
    /** A move to the dead-letter queue that the destination refused (it is retried). */
    dlqFailed: t("dlqFailed"),
    /** Messages retention deleted. */
    expired: t("expired"),
    /** Deliveries whose messages had already been taken over by a later receive: the work was done twice. */
    duplicates: t("duplicates"),
    /** NumberOfDeduplicatedSentMessages (FIFO). */
    deduplicated: t("deduplicated"),
    /** Messages a redrive moved out of this queue. */
    redriven: t("redriven"),
    /** Sends refused by the FIFO rate limit. */
    throttled: t("throttled"),
    /** NumberOfEmptyReceives: an estimate (see the README): idle long-poll waits of the mapping's pollers. */
    emptyReceives: t("emptyReceives"),
    /** Everything accepted into the queue, including internal moves. Total only. */
    enqueued: new Tally(undefined)
  }
}

export type Tallies = ReturnType<typeof makeTallies>
