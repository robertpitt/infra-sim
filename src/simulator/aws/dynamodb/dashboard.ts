import { type Dashboard, dist, gauge, latencyPanel, rate, ratio, sum } from "../../Dashboard.ts"

/**
 * A table's dashboard, as the DynamoDB console and CloudWatch show one: capacity consumed against provisioned, throttle
 * events, requests and errors, request latency, item sizes, and the stream and replication when the table has them.
 * Names follow CloudWatch's (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/metrics-dimensions.html).
 */
export const dashboard: Dashboard = {
  figures: [
    { label: "Read units", metric: rate("consumedRead"), unit: "units", cloudwatch: "ConsumedReadCapacityUnits" },
    { label: "Write units", metric: rate("consumedWrite"), unit: "units", cloudwatch: "ConsumedWriteCapacityUnits" },
    { label: "Throttled", metric: rate("fail.Throttled"), unit: "perSecond", tone: "bad", cloudwatch: "ThrottledRequests" },
    { label: "Avg item size", metric: ratio(sum(rate("bytesRead"), rate("bytesWritten")), sum(rate("itemsRead"), rate("itemsWritten"))), unit: "bytes" },
    { label: "Latency p95", metric: dist("latency", "p95"), unit: "ms", cloudwatch: "SuccessfulRequestLatency" },
    { label: "Errors", metric: rate("fail.Rejected"), unit: "perSecond", tone: "warn", cloudwatch: "UserErrors" }
  ],
  panels: [
    {
      id: "read-capacity",
      title: "Read capacity",
      unit: "units",
      cloudwatch: ["ConsumedReadCapacityUnits", "ProvisionedReadCapacityUnits"],
      help: "Read units used each second, against what the table has: provisioned capacity, or on-demand's current ceiling.",
      lines: [
        { label: "consumed", metric: rate("consumedRead"), tone: "primary" },
        { label: "capacity", metric: gauge("readCapacity"), tone: "muted", dashed: true }
      ]
    },
    {
      id: "write-capacity",
      title: "Write capacity",
      unit: "units",
      cloudwatch: ["ConsumedWriteCapacityUnits", "ProvisionedWriteCapacityUnits"],
      help: "Write units used each second, against what the table has: provisioned capacity, or on-demand's current ceiling.",
      lines: [
        { label: "consumed", metric: rate("consumedWrite"), tone: "accent" },
        { label: "capacity", metric: gauge("writeCapacity"), tone: "muted", dashed: true }
      ]
    },
    {
      id: "throttles",
      title: "Throttle events",
      unit: "perSecond",
      cloudwatch: ["ReadThrottleEvents", "WriteThrottleEvents", "ThrottledRequests"],
      help: "Requests refused for capacity, by direction. A hot partition throttles while the table as a whole has room.",
      lines: [
        { label: "reads", metric: rate("readThrottleEvents"), tone: "warn" },
        { label: "writes", metric: rate("writeThrottleEvents"), tone: "bad" },
        { label: "hot partition", metric: rate("throttledPartition"), tone: "muted", dashed: true }
      ]
    },
    {
      id: "requests",
      title: "Requests",
      unit: "perSecond",
      cloudwatch: ["ReturnedItemCount", "UserErrors", "ConditionalCheckFailedRequests"],
      lines: [
        { label: "reads", metric: rate("readRequests"), tone: "primary" },
        { label: "writes", metric: rate("writeRequests"), tone: "accent" },
        { label: "errors", metric: rate("fail.Rejected"), tone: "warn" },
        { label: "failed conditions", metric: rate("conditionFailed"), tone: "muted" }
      ]
    },
    {
      id: "latency",
      title: "Successful request latency",
      unit: "ms",
      cloudwatch: ["SuccessfulRequestLatency"],
      lines: [
        { label: "read p50", metric: dist("readLatency", "p50"), tone: "primary" },
        { label: "write p50", metric: dist("writeLatency", "p50"), tone: "accent" },
        { label: "p99", metric: dist("latency", "p99"), tone: "bad" }
      ]
    },
    {
      id: "item-size",
      title: "Average item size",
      unit: "bytes",
      help: "Bytes per item read and written: a write costs a unit per KB, a read per 4 KB.",
      lines: [
        { label: "read", metric: ratio(rate("bytesRead"), rate("itemsRead")), tone: "primary" },
        { label: "written", metric: ratio(rate("bytesWritten"), rate("itemsWritten")), tone: "accent" }
      ]
    },
    {
      id: "burst",
      title: "Burst capacity left",
      unit: "units",
      help: "Unused capacity banked for bursts: a provisioned table keeps up to five minutes' worth.",
      lines: [
        { label: "read", metric: gauge("readTokens"), tone: "primary" },
        { label: "write", metric: gauge("writeTokens"), tone: "accent" }
      ]
    },
    {
      id: "stream",
      title: "Stream",
      unit: "perSecond",
      cloudwatch: ["ReturnedRecordsCount"],
      lines: [
        { label: "appended", metric: rate("streamAppended"), tone: "primary" },
        { label: "delivered", metric: rate("streamDelivered"), tone: "ok" },
        { label: "discarded", metric: rate("streamDiscarded"), tone: "bad" }
      ]
    },
    {
      id: "iterator-age",
      title: "Stream iterator age",
      unit: "ms",
      cloudwatch: ["IteratorAge (Lambda)"],
      lines: [{ label: "iterator age", metric: gauge("iteratorAge"), tone: "warn" }]
    },
    latencyPanel("replication", "Replication latency", "replicationLag", ["ReplicationLatency"]),
    {
      id: "indexes",
      title: "Global secondary indexes",
      unit: "units",
      cloudwatch: ["ConsumedReadCapacityUnits (GSI)", "ConsumedWriteCapacityUnits (GSI)"],
      lines: [
        { label: "read units", metric: rate("consumedIndexRead"), tone: "primary" },
        { label: "write units", metric: rate("consumedIndexWrite"), tone: "accent" },
        { label: "throttled", metric: rate("throttledIndex"), tone: "bad" }
      ]
    }
  ]
}
