import type { ServiceMap } from "../map.ts"

/**
 * Kinesis Data Streams, by capacity mode. Provisioned: shard hours, PUT payload units (25 KB of a record each), extended
 * retention (past 24 hours, to 7 days) per shard hour, long-term retention (past 7 days) per GB-month, and enhanced
 * fan-out consumer-shard hours plus the data they read. On-demand (standard): stream hours, data written and read (GB),
 * enhanced fan-out data read, and retention past 24 hours per GB-month. https://aws.amazon.com/kinesis/data-streams/pricing/
 *
 * Usage types (after the region prefix): `Storage-ShardHour`, `PutRequestPayloadUnits`, `Extended-ShardHour`,
 * `LongTermRetention-ByteHrs`, `EnhancedFanoutHour`, `ReadBytes` (enhanced fan-out); `OnDemand-StreamHour`,
 * `OnDemand-BilledIncomingBytes`, `OnDemand-BilledOutgoingBytes`, `OnDemand-BilledOutgoingEFOBytes`,
 * `OnDemand-ExtendedRetention-ByteHrs`, `OnDemand-LongTermRetention-ByteHrs`.
 * Left out: On-demand Advantage (`Advantage-*`) and the Firehose-style channels (`On-demand-*-Channel-*`), which the
 * simulator doesn't have; reading data older than 7 days (`LongTermRetention-ReadBytes`: consumers here start at LATEST).
 */
export const kinesis: ServiceMap = {
  id: "kinesis",
  title: "Amazon Kinesis Data Streams",
  offers: ["AmazonKinesis"],
  dimensions: {
    "shard/provisioned": {
      unit: "shard-hour",
      description: "Provisioned shards, per shard per hour"
    },
    "put-payload-units/provisioned": {
      unit: "payload-unit",
      description: "PUT payload units on a provisioned stream: each record in 25 KB units, rounded up"
    },
    "extended-retention/provisioned": {
      unit: "shard-hour",
      description: "Retention past 24 hours (to 7 days) on a provisioned stream, per shard per hour"
    },
    "long-term-retention/provisioned": {
      unit: "GB-month",
      description: "Data kept past 7 days on a provisioned stream"
    },
    "efo-consumer/provisioned": {
      unit: "consumer-shard-hour",
      description: "Enhanced fan-out consumers on a provisioned stream, per consumer per shard per hour"
    },
    "efo-data/provisioned": {
      unit: "GB",
      description: "Data read by enhanced fan-out consumers on a provisioned stream"
    },
    "stream/on-demand": {
      unit: "stream-hour",
      description: "On-demand streams, per stream per hour"
    },
    "data-in/on-demand": {
      unit: "GB",
      description: "Data written to an on-demand stream, each record rounded up to 1 KB"
    },
    "data-out/on-demand": {
      unit: "GB",
      description: "Data read from an on-demand stream by shared-throughput (GetRecords) consumers"
    },
    "efo-data/on-demand": {
      unit: "GB",
      description: "Data read from an on-demand stream by enhanced fan-out consumers"
    },
    "extended-retention/on-demand": {
      unit: "GB-month",
      description: "Data kept past 24 hours (to 7 days) on an on-demand stream"
    },
    "long-term-retention/on-demand": {
      unit: "GB-month",
      description: "Data kept past 7 days on an on-demand stream"
    }
  },
  classify: (row) => {
    switch (row.usage) {
      case "Storage-ShardHour":
        return { dimension: "shard/provisioned" }
      case "PutRequestPayloadUnits":
        return { dimension: "put-payload-units/provisioned" }
      case "Extended-ShardHour":
        return { dimension: "extended-retention/provisioned" }
      case "LongTermRetention-ByteHrs":
        return { dimension: "long-term-retention/provisioned" }
      case "EnhancedFanoutHour":
        return { dimension: "efo-consumer/provisioned" }
      case "ReadBytes":
        return { dimension: "efo-data/provisioned" }
      case "OnDemand-StreamHour":
        return { dimension: "stream/on-demand" }
      case "OnDemand-BilledIncomingBytes":
        return { dimension: "data-in/on-demand" }
      case "OnDemand-BilledOutgoingBytes":
        return { dimension: "data-out/on-demand" }
      case "OnDemand-BilledOutgoingEFOBytes":
        return { dimension: "efo-data/on-demand" }
      case "OnDemand-ExtendedRetention-ByteHrs":
        return { dimension: "extended-retention/on-demand" }
      case "OnDemand-LongTermRetention-ByteHrs":
        return { dimension: "long-term-retention/on-demand" }
      default:
        return undefined
    }
  }
}
