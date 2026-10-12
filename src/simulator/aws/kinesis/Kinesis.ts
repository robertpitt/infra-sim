import { Effect, Schema } from "effect"
import * as Component from "../../Component.ts"
import { tallies, totals } from "../../kit/Tally.ts"
import * as Aws from "../provider.ts"
import {
  Discard,
  EFO_CONSUMERS,
  GET_RECORDS_MAX_BYTES,
  GET_RECORDS_MAX_RECORDS,
  PUT_RECORDS_MAX_RECORDS,
  SHARD_READ_BYTES,
  SHARD_READ_CALLS,
  SHARD_WRITE_BYTES,
  SHARD_WRITE_RECORDS,
  SOURCES,
  Stream
} from "./config.ts"
import { dashboard } from "./dashboard.ts"
import { StreamPull } from "./pull.ts"
import { StreamModel } from "./stream.ts"

/** The probe lists the busiest open shards, at most this many. */
const HOTTEST = 10

export const Kinesis = Aws.component({
  type: "aws.kinesis",
  service: "Kinesis Data Streams",
  title: "Kinesis data stream",
  description:
    "An ordered, replayable stream split into shards by partition key. Each shard takes 1 MiB/s or 1,000 records/s and serves 2 MiB/s and five GetRecords a second, so a hot key throttles one shard while the rest idle. Provisioned or on-demand, retention, enhanced fan-out, and the Lambda event source mapping with its parallelization factor and blocking retries.",
  docs: SOURCES.limits,
  category: "messaging",
  icon: "stream",
  accent: "#8c4fff",
  limits: [
    { label: "Write per shard", value: "1 MiB/s and 1,000 records/s", adjustable: false, source: SOURCES.limits },
    { label: "Read per shard (shared)", value: `2 MiB/s and ${SHARD_READ_CALLS} GetRecords calls/s across every standard consumer`, adjustable: false, source: SOURCES.limits },
    { label: "GetRecords", value: `${GET_RECORDS_MAX_RECORDS.toLocaleString("en-US")} records or ${GET_RECORDS_MAX_BYTES / 1024 / 1024} MiB a call; after a 10 MiB call, five seconds of throttling`, adjustable: false, source: SOURCES.getRecords },
    { label: "PutRecords", value: `${PUT_RECORDS_MAX_RECORDS} records and 10 MiB a request; records fail one by one`, adjustable: false, source: SOURCES.putRecords },
    { label: "Enhanced fan-out", value: `2 MiB/s per shard per consumer, ${EFO_CONSUMERS} consumers a stream (50 with On-demand Advantage, not modelled)`, adjustable: false, source: SOURCES.efo },
    { label: "On-demand", value: "Starts at 4 MB/s write, 8 MB/s read; holds about double the peak; splits a shard over 500 KB/s within 15 minutes", adjustable: false, source: SOURCES.modes },
    { label: "UpdateShardCount", value: "Double or half per step, ten steps in a rolling 24 hours, 10,000 shards a stream", adjustable: true, source: SOURCES.updateShardCount },
    { label: "Hot partition key", value: `One key lives on one shard: ${SHARD_WRITE_RECORDS.toLocaleString("en-US")} records/s and 1 MiB/s at most, in either mode`, adjustable: false, source: SOURCES.modes }
  ],
  dashboard,
  highlights: [
    { gauge: "shards", label: "shards" },
    { rate: "incoming", label: "rec/s" },
    { rate: "throttled", label: "throttled/s" },
    { gauge: "iteratorAgeMs", label: "iterator age", format: "ms" }
  ],
  config: Stream,
  ports: {
    // Consumers read every shard: what sits on each edge (Lambda's event source mapping, Firehose's source) does the reading.
    consumers: Component.port.pull("Consumers"),
    discarded: Component.port.many("On-failure destination", Discard)
  },
  state: Schema.Struct({
    mode: Schema.String,
    /** Open shards (taking writes), and closed ones still held for their readers. */
    shards: Schema.Number,
    closedShards: Schema.Number,
    /** Provisioned: an UpdateShardCount step under way, the steps in the last 24 hours, and a change waiting because ten have run. */
    updating: Schema.Boolean,
    updatesToday: Schema.Number,
    updatesWaiting: Schema.Boolean,
    /** IteratorAge of the slowest consumer, and the most records one has still to process. */
    iteratorAge: Schema.Number,
    backlog: Schema.Number,
    /** Records the stream holds for its consumers. */
    retained: Schema.Number,
    totals: Schema.Struct({
      incoming: Schema.Number,
      incomingBytes: Schema.Number,
      throttled: Schema.Number,
      rejected: Schema.Number,
      getRecords: Schema.Number,
      outgoing: Schema.Number,
      outgoingBytes: Schema.Number,
      readThrottled: Schema.Number,
      pushed: Schema.Number,
      expired: Schema.Number,
      splits: Schema.Number,
      reshards: Schema.Number,
      onFailureSent: Schema.Number,
      onFailureFailed: Schema.Number
    }),
    consumers: Schema.Array(Schema.Struct({ name: Schema.String, efo: Schema.Boolean, refused: Schema.Boolean, iteratorAge: Schema.Number, backlog: Schema.Number })),
    /** The busiest open shards: their hash-key range and incoming traffic, averaged over about a minute. */
    hottest: Schema.Array(Schema.Struct({ shard: Schema.String, lo: Schema.Number, hi: Schema.Number, bytesPerSecond: Schema.Number, recordsPerSecond: Schema.Number }))
  }),
  make: (node) =>
    Effect.sync(() => {
      const { fast } = node
      const t = tallies(node.meter, [
        "incoming",
        "incomingBytes",
        "throttled",
        "rejected",
        "getRecords",
        "outgoing",
        "outgoingBytes",
        "readThrottled",
        "pushed",
        "expired",
        "splits",
        "reshards",
        "onFailureSent",
        "onFailureFailed"
      ])
      const onFailure = node.out("discarded")
      const model = new StreamModel({
        id: node.id,
        fast,
        tallies: t,
        // The on-failure destination hears of each discarded batch, from every mapping reading this stream.
        discard: (message) => {
          for (const link of onFailure) link.send(message, (failure) => (failure === undefined ? t.onFailureSent : t.onFailureFailed).add(1))
        }
      })
      const pull = new StreamPull(model, { now: fast.now, after: fast.after, mint: fast.mint })

      // Gauges, after the CloudWatch metric each stands for: GetRecords.IteratorAgeMilliseconds is the one to watch.
      node.meter.gaugeUnsafe("shards", () => model.openCount)
      node.meter.gaugeUnsafe("iteratorAgeMs", () => model.lag(fast.now()).ageMs)
      node.meter.gaugeUnsafe("backlog", () => model.lag(fast.now()).records)
      node.meter.gaugeUnsafe("retained", () => model.retained())
      // What the open shards can take and serve, against which IncomingBytes and the rest are read.
      node.meter.gaugeUnsafe("writeCapacityBytes", () => model.openCount * SHARD_WRITE_BYTES)
      node.meter.gaugeUnsafe("writeCapacityRecords", () => model.openCount * SHARD_WRITE_RECORDS)
      node.meter.gaugeUnsafe("readCapacityBytes", () => model.openCount * SHARD_READ_BYTES)
      node.meter.gaugeUnsafe("readCapacityCalls", () => model.openCount * SHARD_READ_CALLS)
      // Hot spots: the busiest open shard's load, and the median shard's, as a share of a shard's write limit (in bytes or
      // records, whichever is nearer). What CloudWatch's shard-level IncomingBytes and IncomingRecords show. The median,
      // not the mean, so that one hot shard of a few doesn't make the typical one look busy.
      let loadAt = -1
      const load = { hottest: 0, median: 0 }
      let shares = new Float64Array(0)
      const shardLoad = () => {
        const now = fast.now()
        if (now === loadAt) return load
        loadAt = now
        const open = model.openShards()
        if (shares.length < open.length) shares = new Float64Array(open.length * 2)
        for (let i = 0; i < open.length; i++) {
          const s = open[i]!
          shares[i] = Math.max(s.lastBytes / SHARD_WRITE_BYTES, s.lastRecords / SHARD_WRITE_RECORDS)
        }
        const sorted = shares.subarray(0, open.length).sort()
        load.hottest = sorted.length > 0 ? sorted[sorted.length - 1]! : 0
        load.median = sorted.length > 0 ? sorted[(sorted.length - 1) >> 1]! : 0
        return load
      }
      node.meter.gaugeUnsafe("hottestShardLoad", () => shardLoad().hottest)
      node.meter.gaugeUnsafe("medianShardLoad", () => shardLoad().median)

      return {
        pull: { consumers: pull },
        call: (message) => {
          const outcome = model.put(message)
          if (outcome === undefined) return Effect.void
          return outcome._tag === "ItemFailures" ? Effect.succeed(outcome) : Effect.fail(outcome)
        },
        probe: Effect.sync(() => {
          const now = fast.now()
          const lag = model.lag(now)
          const open = model.openShards()
          return {
            mode: fast.settings().mode,
            shards: open.length,
            closedShards: model.shards.length - open.length,
            updating: model.isUpdating,
            updatesToday: model.updatesToday,
            updatesWaiting: model.waiting,
            iteratorAge: lag.ageMs,
            backlog: lag.records,
            retained: model.retained(),
            totals: totals(t),
            consumers: model.consumers(now).map((c) => ({ name: c.name, efo: c.efo, refused: c.refused, iteratorAge: c.ageMs, backlog: c.records })),
            hottest: [...open]
              .sort((a, b) => b.rateBytes - a.rateBytes || a.id - b.id)
              .slice(0, HOTTEST)
              .map((s) => ({ shard: s.name, lo: s.lo, hi: s.hi, bytesPerSecond: Math.round(s.rateBytes), recordsPerSecond: Math.round(s.rateRecords) }))
          }
        })
      }
    })
})
