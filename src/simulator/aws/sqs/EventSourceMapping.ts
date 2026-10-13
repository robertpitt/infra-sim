import { Effect, Schema } from "effect"
import * as Connector from "../../Connector.ts"
import { docs } from "../internal/docs.ts"
import { Consumer } from "./internal/config.ts"
import { mappingDashboard } from "./internal/dashboard.ts"
import { Mapping } from "./internal/mapping.ts"

/**
 * Lambda's event source mapping for a queue: pollers that receive batches and invoke the consumer, and the rules that
 * decide how many there are. It is the thing between the queue and the function, so it is the connector on that edge:
 * the queue only offers messages (`Pull`) and the function only handles invocations.
 *
 * A poller is a small state machine with no fiber behind it. Messages are handed to pollers as they become receivable
 * (the queue says when), not by polling on a timer. What the real mapping does that is modelled:
 *
 *  - it starts with 5 concurrent batches and, while messages are still waiting and every poller is busy, adds 300 a
 *    minute up to 1,250 (or the maximum concurrency); when the backlog clears it falls back. Provisioned mode starts
 *    higher and adds faster;
 *  - a batch is received in calls of at most ten, and each receive's visibility timeout starts at once, so a poller
 *    that waits out a batching window is spending its messages' visibility timeout;
 *  - a batch is cut at 6 MB, and a FIFO batch (at most ten) is filled from one group after another;
 *  - it invokes synchronously and waits for the function, however long it runs: the function's timeout ends a slow
 *    batch, not the mapping;
 *  - on a function error the messages stay hidden until the visibility timeout, and the mapping backs off. On
 *    throttling it keeps the batch and tries again until the visibility timeout runs out, backing off as well;
 *  - on success it deletes the batch. With `ReportBatchItemFailures` a success that names failed records (`ItemFailures`)
 *    deletes the rest and leaves those to come back after the visibility timeout, and the mapping doesn't back off;
 *    without it such a reply is ignored and the whole batch is deleted, the failed records with it.
 */
export const EventSourceMapping = Connector.make({
  type: "aws.sqs.event-source-mapping",
  provider: "aws",
  title: "Event source mapping",
  description:
    "Lambda's poller between a queue and its consumer: receives batches, invokes the consumer with each, deletes them on success, and scales its pollers with the backlog.",
  icon: "reload",
  docs: `${docs.lambda}with-sqs.html`,
  // Any consumer: one that isn't a function is modelled as if Lambda's mapping polled for it. A fixed pool of workers
  // is `core.poller`, chosen on the edge.
  from: { protocol: "pull", component: "aws.sqs", port: "deliver" },
  // Lambda's poller: a fleet (an ECS service, an Auto Scaling group) drains a queue with workers of its own (core.poller).
  to: { protocol: "invoke", fleets: false },
  dashboard: mappingDashboard,
  config: Consumer,
  state: Schema.Struct({
    /** Concurrent batches the mapping is running at now. */
    concurrency: Schema.Number,
    /** Pollers running a batch or holding one. */
    busy: Schema.Number
  }),
  make: (ctx) =>
    Effect.sync(() => {
      const mapping = new Mapping(ctx.source, ctx.sink, ctx.fast, {
        itemFailures: ctx.meter.counter("itemFailures"),
        itemFailuresIgnored: ctx.meter.counter("itemFailuresIgnored"),
        polled: ctx.meter.counter("polled"),
        batches: ctx.meter.counter("batches"),
        invoked: ctx.meter.counter("invoked"),
        failedInvoke: ctx.meter.counter("failedInvoke")
      })
      // On the edge's meter, beside transport's own counts, so a chart of the edge shows the mapping scaling.
      ctx.meter.gaugeUnsafe("concurrency", () => mapping.status().concurrency)
      ctx.meter.gaugeUnsafe("busy", () => mapping.status().busy)
      // The batch size it gathers to (a FIFO batch is at most ten), to read the average batch against.
      ctx.meter.gaugeUnsafe("batchSize", () => mapping.batchSize())
      return mapping.start()
    })
})
