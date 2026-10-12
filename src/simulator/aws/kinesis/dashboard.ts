import { type Dashboard, gauge, rate, ratio } from "../../Dashboard.ts"

/**
 * A data stream's dashboard, as the Kinesis console and CloudWatch show one: what is written against what the shards can
 * take, the records refused for it, the busiest shard against the average (a hot partition key), how far behind the
 * slowest consumer is, and what is read. Names follow CloudWatch's
 * (https://docs.aws.amazon.com/streams/latest/dev/monitoring-with-cloudwatch.html).
 */
export const dashboard: Dashboard = {
  figures: [
    { label: "Incoming", metric: rate("incoming"), unit: "perSecond", cloudwatch: "IncomingRecords" },
    { label: "Incoming bytes", metric: rate("incomingBytes"), unit: "bytesPerSecond", cloudwatch: "IncomingBytes" },
    { label: "Write throttled", metric: rate("throttled"), unit: "perSecond", tone: "bad", cloudwatch: "WriteProvisionedThroughputExceeded" },
    { label: "Read throttled", metric: rate("readThrottled"), unit: "perSecond", tone: "warn", cloudwatch: "ReadProvisionedThroughputExceeded" },
    { label: "Iterator age", metric: gauge("iteratorAgeMs"), unit: "ms", cloudwatch: "GetRecords.IteratorAgeMilliseconds" },
    { label: "Hottest shard", metric: gauge("hottestShardLoad"), unit: "ratio" }
  ],
  panels: [
    {
      id: "incoming-bytes",
      title: "Incoming bytes",
      unit: "bytesPerSecond",
      cloudwatch: ["IncomingBytes"],
      help: "Bytes written, against what the open shards take (1 MiB/s each). One hot key can throttle its shard while the stream as a whole has room.",
      lines: [
        { label: "incoming", metric: rate("incomingBytes"), tone: "primary" },
        { label: "capacity", metric: gauge("writeCapacityBytes"), tone: "muted", dashed: true }
      ]
    },
    {
      id: "incoming-records",
      title: "Incoming records",
      unit: "perSecond",
      cloudwatch: ["IncomingRecords", "WriteProvisionedThroughputExceeded"],
      help: "Records written and records refused because their shard was over its limit, against what the open shards take (1,000 records/s each). Rejected ones were too large or too many for one request.",
      lines: [
        { label: "incoming", metric: rate("incoming"), tone: "primary" },
        { label: "throttled", metric: rate("throttled"), tone: "bad" },
        { label: "rejected", metric: rate("rejected"), tone: "warn" },
        { label: "capacity", metric: gauge("writeCapacityRecords"), tone: "muted", dashed: true }
      ]
    },
    {
      id: "shard-load",
      title: "Shard load",
      unit: "ratio",
      cloudwatch: ["IncomingBytes (per shard)", "IncomingRecords (per shard)"],
      help: "What was offered to the busiest shard and to the median one in the last second (throttled writes included), as a share of a shard's write limit. Over 100% a shard throttles. The hottest far above the median is a hot partition key: more shards won't help it.",
      lines: [
        { label: "hottest shard", metric: gauge("hottestShardLoad"), tone: "bad" },
        { label: "median shard", metric: gauge("medianShardLoad"), tone: "primary" }
      ]
    },
    {
      id: "iterator-age",
      title: "Iterator age",
      unit: "ms",
      cloudwatch: ["GetRecords.IteratorAgeMilliseconds"],
      help: "How old the oldest record the slowest consumer has yet to process is. Growing means consumers are falling behind; at the retention period records are lost.",
      lines: [{ label: "iterator age", metric: gauge("iteratorAgeMs"), tone: "warn" }]
    },
    {
      id: "get-records",
      title: "GetRecords calls",
      unit: "perSecond",
      cloudwatch: ["GetRecords.Success", "ReadProvisionedThroughputExceeded"],
      help: "GetRecords calls and those throttled, against the five calls a second each shard serves, shared by every standard consumer. Enhanced fan-out consumers are pushed records and make no calls.",
      lines: [
        { label: "calls", metric: rate("getRecords"), tone: "primary" },
        { label: "throttled", metric: rate("readThrottled"), tone: "bad" },
        { label: "allowance", metric: gauge("readCapacityCalls"), tone: "muted", dashed: true }
      ]
    },
    {
      id: "outgoing-records",
      title: "Outgoing records",
      unit: "perSecond",
      cloudwatch: ["GetRecords.Records", "SubscribeToShardEvent.Records"],
      help: "Records read by standard consumers and pushed to enhanced fan-out ones, each consumer counted, and records a consumer found past retention before it read them: lost to it.",
      lines: [
        { label: "GetRecords", metric: rate("outgoing"), tone: "primary" },
        { label: "pushed", metric: rate("pushed"), tone: "accent" },
        { label: "expired unread", metric: rate("expired"), tone: "bad" }
      ]
    },
    {
      id: "outgoing-bytes",
      title: "Outgoing bytes",
      unit: "bytesPerSecond",
      cloudwatch: ["GetRecords.Bytes", "SubscribeToShardEvent.Bytes"],
      help: "Bytes read by every consumer, against the 2 MiB/s per shard the standard consumers share. Each enhanced fan-out consumer has 2 MiB/s per shard of its own on top.",
      lines: [
        { label: "outgoing", metric: rate("outgoingBytes"), tone: "primary" },
        { label: "shared read capacity", metric: gauge("readCapacityBytes"), tone: "muted", dashed: true }
      ]
    },
    {
      id: "shards",
      title: "Open shards",
      unit: "count",
      help: "Shards taking writes. On-demand splits a busy shard after a while; provisioned follows the shard count in steps of at most double or half.",
      lines: [{ label: "shards", metric: gauge("shards"), tone: "accent" }]
    },
    {
      id: "held",
      title: "Records held",
      unit: "count",
      help: "The most records any one consumer has still to process, and the records the stream keeps for its consumers.",
      lines: [
        { label: "consumer backlog", metric: gauge("backlog"), tone: "warn" },
        { label: "retained", metric: gauge("retained"), tone: "muted" }
      ]
    }
  ]
}

/**
 * The event source mapping's own charts, after transport's: IteratorAge (the one Lambda alarms on), its batches in
 * flight against the lanes it has, the records it reads, invokes and gives up on, as Lambda's event source mapping
 * metrics count them (https://docs.aws.amazon.com/lambda/latest/dg/monitoring-metrics-types.html), and retries.
 */
export const mappingDashboard: Dashboard = {
  figures: [
    { label: "Iterator age", metric: gauge("iteratorAge"), unit: "ms", cloudwatch: "IteratorAge" },
    { label: "Batches in flight", metric: gauge("concurrency"), unit: "count" },
    { label: "Discarded", metric: rate("discarded"), unit: "perSecond", tone: "bad", cloudwatch: "OnFailureDestinationDeliveredEventCount" }
  ],
  panels: [
    {
      id: "iterator-age",
      title: "Iterator age",
      unit: "ms",
      cloudwatch: ["IteratorAge"],
      help: "How old the oldest record this mapping has yet to process is. It grows when the function can't keep up, or while a failing batch blocks its shard.",
      lines: [{ label: "iterator age", metric: gauge("iteratorAge"), tone: "warn" }]
    },
    {
      id: "concurrency",
      title: "Batches in flight",
      unit: "count",
      help: "Batches being invoked, against the most it can run: one per shard, times the parallelization factor.",
      lines: [
        { label: "in flight", metric: gauge("concurrency"), tone: "primary" },
        { label: "lanes", metric: gauge("maxConcurrency"), tone: "muted", dashed: true }
      ]
    },
    {
      id: "events",
      title: "Events",
      unit: "perSecond",
      cloudwatch: ["PolledEventCount", "InvokedEventCount", "FailedInvokeEventCount", "OnFailureDestinationDeliveredEventCount", "DroppedEventCount"],
      help: "Records read from the stream, sent to the function (a retried batch counts again), in invocations that failed, and given up on: sent to the stream's on-failure destination, or dropped with none.",
      lines: [
        { label: "polled", metric: rate("polledEvents"), tone: "primary" },
        { label: "invoked", metric: rate("invokedEvents"), tone: "ok" },
        { label: "failed", metric: rate("failedInvokeEvents"), tone: "warn" },
        { label: "discarded", metric: rate("discarded"), tone: "bad" }
      ]
    },
    {
      id: "batches",
      title: "Batches",
      unit: "perSecond",
      help: "Invocations, and the batches retried after a failure (blocking their lane meanwhile), split in two by bisect-on-error, or throttled by Lambda (retried without using up retries).",
      lines: [
        { label: "batches", metric: rate("batches"), tone: "primary" },
        { label: "retried", metric: rate("batchRetries"), tone: "warn" },
        { label: "bisected", metric: rate("bisected"), tone: "accent" },
        { label: "throttled", metric: rate("throttledInvokes"), tone: "bad" }
      ]
    },
    {
      id: "batch-size",
      title: "Batch size",
      unit: "count",
      help: "Records per invocation, against the batch size.",
      lines: [
        { label: "average", metric: ratio(rate("invokedEvents"), rate("batches")), tone: "primary" },
        { label: "batch size", metric: gauge("batchSize"), tone: "muted", dashed: true }
      ]
    },
    {
      id: "backlog",
      title: "Backlog",
      unit: "count",
      help: "Records written and not yet processed by this mapping, and those in batches that have failed and are being retried: a blocked shard shows here.",
      lines: [
        { label: "backlog", metric: gauge("backlog"), tone: "warn" },
        { label: "blocked", metric: gauge("blocked"), tone: "bad" }
      ]
    },
    {
      id: "record-failures",
      title: "Record failures",
      unit: "perSecond",
      help: "Records a function reported failed (retried from the first of them), reports ignored because the mapping doesn't act on them, batches with a poison record, and records lost to retention before the mapping read them.",
      lines: [
        { label: "reported failed", metric: rate("itemFailures"), tone: "warn" },
        { label: "reports ignored", metric: rate("itemFailuresIgnored"), tone: "muted" },
        { label: "poison", metric: rate("poisonFailures"), tone: "bad" },
        { label: "expired", metric: rate("expired"), tone: "accent" }
      ]
    }
  ]
}
