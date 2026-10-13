import { Effect, Schema } from "effect"
import * as Connector from "../../Connector.ts"
import { streamOf } from "../kinesis/Readers.ts"
import { SOURCES } from "./internal/config.ts"
import { sourceDashboard } from "./internal/dashboard.ts"
import { Source } from "./internal/source.ts"

/**
 * A Firehose stream reading a Kinesis data stream (a "Kinesis Data Streams as source" stream): the connector a wire
 * from a stream's `consumers` port to a Firehose stream gets.
 *
 * As AWS describes it (writing-with-kinesis-streams): Firehose starts at LATEST and calls GetRecords once a second on
 * each shard, a standard consumer sharing the shard's 2 MiB/s and five calls a second with everyone else. What it reads
 * goes into a buffer per shard. If Firehose can't take it (its delivery for that shard is failing) the records are kept
 * and offered again a second later, so they stay in the stream, KinesisMillisBehindLatest grows, and nothing is lost
 * until the stream's retention runs out.
 */
export const KinesisSource = Connector.make({
  type: "aws.firehose.kinesis-source",
  provider: "aws",
  title: "Firehose source (Kinesis)",
  description: "Firehose reading a Kinesis stream: GetRecords once a second per shard from LATEST, sharing the shard's read limits with other standard consumers, into a buffer per shard.",
  icon: "reload",
  docs: SOURCES.kinesisSource,
  from: { protocol: "pull", component: "aws.kinesis", port: "consumers" },
  to: { protocol: "invoke", component: "aws.firehose" },
  dashboard: sourceDashboard,
  config: Schema.Struct({}),
  state: Schema.Struct({
    /** Shards being read. */
    shards: Schema.Number,
    /** KinesisMillisBehindLatest: age of the oldest record read or still to read and not yet taken by Firehose. */
    behindMs: Schema.Number,
    /** Records written and not yet taken by Firehose. */
    backlog: Schema.Number,
    totals: Schema.Struct({ records: Schema.Number, bytes: Schema.Number, refused: Schema.Number })
  }),
  make: (ctx) =>
    Effect.sync(() => {
      const stream = streamOf(ctx.source)
      // The connector only fits a Kinesis stream's port; anything else reads nothing.
      if (stream === undefined) return {}
      const source = new Source(ctx, stream)
      ctx.meter.gaugeUnsafe("millisBehindLatest", () => source.lag(ctx.fast.now()).ageMs)
      ctx.meter.gaugeUnsafe("backlog", () => source.lag(ctx.fast.now()).records)
      return { probe: Effect.sync(() => source.state()) }
    })
})
