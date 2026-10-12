import { type Dashboard, gauge, latencyPanel, rate } from "../../Dashboard.ts"

/**
 * A Firehose stream's dashboard, as CloudWatch shows one: what comes in against the Direct PUT quota and what it
 * throttles, how fresh the data is (the age of the oldest record not yet delivered, against the buffer interval), what is
 * delivered and how often a delivery fails, and the transformation Lambda's records and duration. Names follow
 * CloudWatch's (https://docs.aws.amazon.com/firehose/latest/dev/monitoring-with-cloudwatch-metrics.html); an HTTP
 * endpoint destination's are the DeliveryToHttpEndpoint.* of the same.
 */
export const dashboard: Dashboard = {
  figures: [
    { label: "Incoming", metric: rate("incoming"), unit: "perSecond", cloudwatch: "IncomingRecords" },
    { label: "Incoming bytes", metric: rate("incomingBytes"), unit: "bytesPerSecond", cloudwatch: "IncomingBytes" },
    { label: "Delivered", metric: rate("delivered"), unit: "perSecond", cloudwatch: "DeliveryToS3.Records" },
    { label: "Data freshness", metric: gauge("dataFreshness"), unit: "ms", cloudwatch: "DeliveryToS3.DataFreshness" },
    { label: "Throttled", metric: rate("throttled"), unit: "perSecond", tone: "bad", cloudwatch: "ThrottledRecords" },
    { label: "Failed deliveries", metric: rate("deliveryFailed"), unit: "perSecond", tone: "warn" }
  ],
  panels: [
    {
      id: "incoming-records",
      title: "Incoming records",
      unit: "perSecond",
      cloudwatch: ["IncomingRecords", "ThrottledRecords", "IncomingPutRequests"],
      help: "Records taken in, records refused by the Direct PUT throughput quota, and PutRecord and PutRecordBatch requests. Rejected ones were too large, or put to a stream that reads a Kinesis stream.",
      lines: [
        { label: "incoming", metric: rate("incoming"), tone: "primary" },
        { label: "throttled", metric: rate("throttled"), tone: "bad" },
        { label: "rejected", metric: rate("rejected"), tone: "warn" },
        { label: "put requests", metric: rate("putRequests"), tone: "muted" }
      ]
    },
    {
      id: "incoming-bytes",
      title: "Incoming bytes",
      unit: "bytesPerSecond",
      cloudwatch: ["IncomingBytes", "BytesPerSecondLimit"],
      help: "Bytes taken in, against the Direct PUT quota (shown once a Direct PUT has arrived: a stream reading a Kinesis stream has none).",
      lines: [
        { label: "incoming", metric: rate("incomingBytes"), tone: "primary" },
        { label: "limit", metric: gauge("bytesPerSecondLimit"), tone: "muted", dashed: true }
      ]
    },
    {
      id: "freshness",
      title: "Data freshness",
      unit: "ms",
      cloudwatch: ["DeliveryToS3.DataFreshness", "DeliveryToHttpEndpoint.DataFreshness"],
      help: "How long the oldest record not yet delivered has been in Firehose. While delivery keeps up it saw-tooths up to the buffer interval; above it, deliveries are failing or falling behind.",
      lines: [
        { label: "freshness", metric: gauge("dataFreshness"), tone: "warn" },
        { label: "buffer interval", metric: gauge("bufferInterval"), tone: "muted", dashed: true }
      ]
    },
    {
      id: "delivered",
      title: "Delivered records",
      unit: "perSecond",
      cloudwatch: ["DeliveryToS3.Records", "DeliveryToHttpEndpoint.Records"],
      help: "Records delivered to the destination, and records given up on and lost (24 hours of failed retries for Direct PUT to S3, or a failed backup).",
      lines: [
        { label: "delivered", metric: rate("delivered"), tone: "ok" },
        { label: "lost", metric: rate("lost"), tone: "bad" }
      ]
    },
    {
      id: "deliveries",
      title: "Deliveries",
      unit: "perSecond",
      cloudwatch: ["DeliveryToS3.Success", "DeliveryToHttpEndpoint.Success"],
      help: "Objects (or HTTP requests) delivered, one per buffer, and delivery attempts that failed and will be retried. A failing delivery holds up its buffer's later ones.",
      lines: [
        { label: "delivered", metric: rate("objects"), tone: "ok" },
        { label: "failed attempts", metric: rate("deliveryFailed"), tone: "bad" }
      ]
    },
    {
      id: "object-size",
      title: "Delivered object size",
      unit: "bytes",
      cloudwatch: ["DeliveryToS3.Bytes"],
      help: "The size of the last object (or HTTP request) delivered: the buffer size when a buffer fills before its interval, less when the interval comes first, more when Firehose merges buffers to catch up. Small objects make many small files.",
      lines: [{ label: "last object", metric: gauge("lastObjectBytes"), tone: "primary" }]
    },
    {
      id: "transformed",
      title: "Transformed records",
      unit: "perSecond",
      cloudwatch: ["SucceedProcessing.Records"],
      help: "Records the transformation Lambda returned processed, and records it failed (written to the error output).",
      lines: [
        { label: "processed", metric: rate("transformedRecords"), tone: "ok" },
        { label: "failed", metric: rate("processingFailed"), tone: "bad" }
      ]
    },
    {
      id: "transform-invocations",
      title: "Transformation invocations",
      unit: "perSecond",
      cloudwatch: ["ExecuteProcessing.Success"],
      help: "Invocations of the transformation Lambda that succeeded, and those that failed (an error, a timeout, a throttle), which are retried three times by default.",
      lines: [
        { label: "succeeded", metric: rate("transformSucceeded"), tone: "ok" },
        { label: "failed", metric: rate("transformFailed"), tone: "bad" }
      ]
    },
    latencyPanel("transform-duration", "Transformation duration", "transformDuration", ["ExecuteProcessing.Duration"]),
    {
      id: "backup",
      title: "Backup and errors to S3",
      unit: "perSecond",
      cloudwatch: ["BackupToS3.Records", "BackupToS3.Success"],
      help: "Records written aside to S3 (records the transformation failed, or an HTTP delivery given up on), and those that couldn't be.",
      lines: [
        { label: "backed up", metric: rate("backedUp"), tone: "ok" },
        { label: "backup failed", metric: rate("backupFailed"), tone: "bad" }
      ]
    }
  ]
}

/**
 * Firehose reading a Kinesis stream, after transport's charts: what it reads (DataReadFromKinesisStream), how far behind
 * the stream it is (KinesisMillisBehindLatest), and the reads the shards refuse (ThrottledGetRecords).
 */
export const sourceDashboard: Dashboard = {
  figures: [
    { label: "Behind latest", metric: gauge("millisBehindLatest"), unit: "ms", cloudwatch: "KinesisMillisBehindLatest" },
    { label: "Records read", metric: rate("records"), unit: "perSecond", cloudwatch: "DataReadFromKinesisStream.Records" },
    { label: "Throttled reads", metric: rate("throttledGetRecords"), unit: "perSecond", tone: "warn", cloudwatch: "ThrottledGetRecords" }
  ],
  panels: [
    {
      id: "behind",
      title: "Behind latest",
      unit: "ms",
      cloudwatch: ["KinesisMillisBehindLatest"],
      help: "How old the oldest record Firehose has yet to take from the stream is. It grows while Firehose's delivery for a shard is failing: it stops reading that shard, and the records wait in the stream.",
      lines: [{ label: "behind", metric: gauge("millisBehindLatest"), tone: "warn" }]
    },
    {
      id: "read",
      title: "Records read",
      unit: "perSecond",
      cloudwatch: ["DataReadFromKinesisStream.Records"],
      help: "Records Firehose took from the stream, and records it handed back because its delivery was failing (they are read again a second later).",
      lines: [
        { label: "read", metric: rate("records"), tone: "primary" },
        { label: "held back", metric: rate("refused"), tone: "warn" }
      ]
    },
    {
      id: "bytes",
      title: "Bytes read",
      unit: "bytesPerSecond",
      cloudwatch: ["DataReadFromKinesisStream.Bytes"],
      lines: [{ label: "read", metric: rate("bytes"), tone: "primary" }]
    },
    {
      id: "throttled",
      title: "Throttled reads",
      unit: "perSecond",
      cloudwatch: ["ThrottledGetRecords"],
      help: "GetRecords calls refused by a shard's read limits (five calls and 2 MiB a second, shared with every other standard consumer).",
      lines: [{ label: "throttled", metric: rate("throttledGetRecords"), tone: "warn" }]
    },
    {
      id: "backlog",
      title: "Backlog",
      unit: "count",
      help: "Records written to the stream and not yet taken by Firehose.",
      lines: [{ label: "backlog", metric: gauge("backlog"), tone: "warn" }]
    }
  ]
}
