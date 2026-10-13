import { Duration, Effect, Schema } from "effect"
import * as Component from "../../Component.ts"
import { tallies, totals } from "../../kit/Tally.ts"
import * as Aws from "../internal/provider.ts"
import { DeliveryStream, Out, SOURCES, TransformEdge } from "./internal/config.ts"
import { MiB } from "../internal/units.ts"
import { dashboard } from "./internal/dashboard.ts"
import { Engine } from "./internal/delivery.ts"

export const Firehose = Aws.component({
  type: "aws.firehose",
  service: "Data Firehose",
  title: "Firehose stream",
  description:
    "Buffers records until a size or an interval, whichever comes first, then delivers each buffer as one object to S3 (or one request to an HTTP endpoint). Direct PUT with regional throughput quotas, or reading a Kinesis stream; an optional transformation Lambda; retries, backup of failed records, and data freshness.",
  docs: SOURCES.limits,
  category: "messaging",
  icon: "inbox",
  accent: "#8c4fff",
  limits: [
    { label: "Record size", value: "1,000 KiB", adjustable: false, source: SOURCES.limits },
    { label: "PutRecordBatch", value: "500 records or 4 MiB", adjustable: false, source: SOURCES.limits },
    { label: "Direct PUT throughput", value: "Per stream: 5 MiB/s, 500,000 records/s, 2,000 requests/s in N. Virginia, Oregon and Ireland; 1 MiB/s, 100,000, 1,000 elsewhere (the region's quotas)", adjustable: true, source: SOURCES.quotas },
    { label: "Kinesis source", value: "No Firehose throughput limit; reads each shard once a second, sharing its read limits; PutRecord disabled", adjustable: false, source: SOURCES.kinesisSource },
    { label: "Undelivered data", value: "Kept 24 hours (Direct PUT); a Kinesis source keeps it in the stream", adjustable: false, source: SOURCES.retry },
    { label: "Transformation", value: "Batches of 0.2-3 MB, up to 5 minutes and 5 outstanding invocations per shard, 3 retries by default", adjustable: false, source: SOURCES.transform }
  ],
  dashboard,
  highlights: [
    { rate: "incoming", label: "rec/s" },
    { rate: "objects", label: "objects/s" },
    { gauge: "dataFreshness", label: "freshness", format: "ms" },
    { rate: "throttled", label: "throttled/s" }
  ],
  config: DeliveryStream,
  ports: {
    out: Component.port.one("Destination", Out),
    transform: Component.port.one("Transformation Lambda", TransformEdge),
    backup: Component.port.one("S3 backup")
  },
  state: Schema.Struct({
    /** Where its records come from: Direct PUT, or a Kinesis stream once one has fed it. */
    source: Schema.String,
    /** Buffers in use: one for Direct PUT, one per source shard. */
    buffers: Schema.Number,
    /** Records and bytes held (gathering, queued or being delivered), deliveries queued, and buffers whose delivery is failing. */
    held: Schema.Struct({ records: Schema.Number, bytes: Schema.Number, deliveries: Schema.Number, failing: Schema.Number }),
    /** Age of the oldest record not yet delivered (DataFreshness), ms. */
    dataFreshness: Schema.Number,
    totals: Schema.Struct({
      incoming: Schema.Number,
      incomingBytes: Schema.Number,
      putRequests: Schema.Number,
      throttled: Schema.Number,
      rejected: Schema.Number,
      refusedFromStream: Schema.Number,
      delivered: Schema.Number,
      deliveredBytes: Schema.Number,
      objects: Schema.Number,
      deliveryFailed: Schema.Number,
      transformInvocations: Schema.Number,
      transformFailed: Schema.Number,
      transformedRecords: Schema.Number,
      processingFailed: Schema.Number,
      backedUp: Schema.Number,
      backupFailed: Schema.Number,
      lost: Schema.Number
    })
  }),
  make: (node) =>
    Effect.sync(() => {
      const { fast } = node
      const t = tallies(node.meter, [
        "incoming",
        "incomingBytes",
        "putRequests",
        "throttled",
        "rejected",
        "refusedFromStream",
        "delivered",
        "deliveredBytes",
        "objects",
        "deliveryFailed",
        "transformInvocations",
        "transformFailed",
        "transformedRecords",
        "processingFailed",
        "backedUp",
        "backupFailed",
        "lost"
      ])
      const engine = new Engine({
        id: node.id,
        region: node.placement.region,
        fast,
        limiter: node.limiter,
        out: node.out("out")[0],
        transform: node.out("transform")[0],
        backup: node.out("backup")[0],
        tallies: t,
        transformSucceeded: node.meter.counter("transformSucceeded"),
        transformDuration: node.meter.sampler("transformDuration")
      })
      // Gauges after CloudWatch's: DeliveryToS3.DataFreshness is the one to watch.
      node.meter.gaugeUnsafe("dataFreshness", () => engine.freshness(fast.now()))
      node.meter.gaugeUnsafe("heldRecords", () => engine.held().records)
      node.meter.gaugeUnsafe("heldBytes", () => engine.held().bytes)
      node.meter.gaugeUnsafe("lastObjectBytes", () => engine.lastObjectBytes)
      // The buffering interval, which data freshness saw-tooths up to while delivery keeps up.
      node.meter.gaugeUnsafe("bufferInterval", () => Duration.toMillis(fast.settings().bufferInterval))
      // BytesPerSecondLimit: the Direct PUT quota, charted once a Direct PUT has been accepted (a stream reading a
      // Kinesis stream has no Firehose limit of its own).
      let limitShown = false
      const showLimit = (): void => {
        limitShown = true
        node.meter.gaugeUnsafe("bytesPerSecondLimit", () => (fast.account() as Aws.Account).firehoseDirectPutMiBps * MiB)
      }

      return {
        call: (message) => {
          const failure = engine.accept(message)
          if (!limitShown && engine.directPut) showLimit()
          return failure === undefined ? Effect.void : Effect.fail(failure)
        },
        probe: Effect.sync(() => ({
          source: engine.kinesisSource ? "kinesis" : "direct-put",
          buffers: engine.laneCount,
          held: engine.held(),
          dataFreshness: engine.freshness(fast.now()),
          totals: totals(t)
        }))
      }
    })
})
