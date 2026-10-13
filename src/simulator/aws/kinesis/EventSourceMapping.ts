import { Effect, Schema } from "effect"
import * as Connector from "../../Connector.ts"
import { Mapping, SOURCES } from "./internal/config.ts"
import { mappingDashboard } from "./internal/dashboard.ts"
import { KinesisPoller } from "./internal/mapping.ts"
import { streamOf } from "./Readers.ts"

/**
 * Lambda's event source mapping for a Kinesis stream: the connector on the edge from a stream's `consumers` port to a
 * function (or anything that takes calls).
 *
 * What it models (with-kinesis, services-kinesis-parameters, kinesis-on-failure-destination):
 *  - one poller per shard, reading with GetRecords at a base rate of once a second and at once while it is behind, so
 *    it shares the shard's 2 MiB/s and five calls a second with every other standard reader; or, with enhanced fan-out,
 *    records pushed through a registered consumer with 2 MiB/s per shard of its own;
 *  - batches of up to the batch size and 6 MB, held for the batching window if one is set;
 *  - a parallelization factor: up to ten batches of a shard at once, the shard split by key into lanes so records of one
 *    partition key stay in order;
 *  - a failed batch blocks its lane (the whole shard with a factor of 1): it is retried until it succeeds, is older than
 *    the maximum record age, has used its retries, or expires from the stream; then its metadata goes to the stream's
 *    on-failure destination and the lane moves on. Bisect-on-error splits a failing batch until the bad record is
 *    alone. A throttled invocation is retried without using up retries;
 *  - with ReportBatchItemFailures, a reply naming failed records checkpoints before the first of them and retries from
 *    there; without it the reply counts as success;
 *  - IteratorAge: how old the oldest record not yet processed is, the metric that shows a consumer falling behind.
 */

export const KinesisMapping = Connector.make({
  type: "aws.kinesis.event-source-mapping",
  provider: "aws",
  title: "Event source mapping (Kinesis)",
  description:
    "Lambda's poller between a Kinesis stream and a function: one poller per shard, batches in order, a parallelization factor, and a failing batch that blocks its shard until it succeeds, is split, or is discarded to the stream's on-failure destination.",
  icon: "reload",
  docs: SOURCES.lambda,
  from: { protocol: "pull", component: "aws.kinesis", port: "consumers" },
  // Lambda's poller: a fleet (an ECS service, an Auto Scaling group) reads a stream with workers of its own (core.poller).
  to: { protocol: "invoke", fleets: false },
  dashboard: mappingDashboard,
  config: Mapping,
  state: Schema.Struct({
    /** Shards this mapping is reading now. */
    shards: Schema.Number,
    /** Batches being invoked or retried. */
    inflight: Schema.Number,
    /** Age of the oldest record not yet processed (IteratorAge), ms. */
    iteratorAge: Schema.Number,
    /** Records written and not yet processed. */
    backlog: Schema.Number,
    /** Records in batches that have failed and are being retried: a blocked shard shows here. */
    blocked: Schema.Number,
    /** Reading through enhanced fan-out; refused when the stream already has 20 registered consumers. */
    enhancedFanOut: Schema.Boolean,
    refused: Schema.Boolean,
    totals: Schema.Struct({
      batches: Schema.Number,
      records: Schema.Number,
      retries: Schema.Number,
      bisected: Schema.Number,
      discarded: Schema.Number,
      expired: Schema.Number,
      itemFailures: Schema.Number
    })
  }),
  make: (ctx) =>
    Effect.sync(() => {
      const stream = streamOf(ctx.source)
      // The connector only fits a Kinesis stream's port, so this is always one; a source that isn't reads nothing.
      if (stream === undefined) return {}
      const mapping = new KinesisPoller(ctx, stream)
      ctx.meter.gaugeUnsafe("iteratorAge", () => mapping.lag(ctx.fast.now()).ageMs)
      ctx.meter.gaugeUnsafe("backlog", () => mapping.lag(ctx.fast.now()).records)
      ctx.meter.gaugeUnsafe("concurrency", () => mapping.inflight)
      // The most batches it can have in flight: a lane per shard and parallelization factor.
      ctx.meter.gaugeUnsafe("maxConcurrency", () => mapping.lanes())
      ctx.meter.gaugeUnsafe("blocked", () => mapping.blocked())
      ctx.meter.gaugeUnsafe("batchSize", () => ctx.fast.settings().batchSize)
      return { probe: Effect.sync(() => mapping.state()) }
    })
})
