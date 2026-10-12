import type { ServiceMap } from "../map.ts"

/**
 * Data Firehose: data ingested, by source, tiered by the month's GB (500 TB, then 1.5 PB, then the rest). Each record is
 * rounded up to the next 5 KB before it is counted. https://aws.amazon.com/firehose/pricing/
 *
 * Usage types (after the region prefix): `BilledBytes` (Direct PUT, operations `PutRecord` and `PutRecordBatch` at one
 * price) and `StreamsSourceBilledBytes` (a Kinesis data stream as the source).
 * Left out: MSK, vended logs and the newer unrounded sources (`*-no-rounding-BilledBytes`), Iceberg tables, format
 * conversion, dynamic partitioning, decompression, VPC delivery and incremental processing: the simulator has none of
 * them. A transformation Lambda is billed as Lambda.
 * eu-west-1's file prefixes these usage types `EUW1-` where Lambda's (the generator's reference for prefixes) uses `EU-`,
 * so a prefix left on the usage type is stripped here.
 */
export const firehose: ServiceMap = {
  id: "firehose",
  title: "Amazon Data Firehose",
  offers: ["AmazonKinesisFirehose"],
  dimensions: {
    "ingestion/direct-put": {
      unit: "GB",
      description: "Data ingested by Direct PUT (PutRecord, PutRecordBatch), each record rounded up to 5 KB"
    },
    "ingestion/kinesis": {
      unit: "GB",
      description: "Data read from a Kinesis data stream as the source, each record rounded up to 5 KB"
    }
  },
  classify: (row) => {
    switch (row.usage.replace(/^[A-Z]{2,4}[0-9]-/, "")) {
      case "BilledBytes":
        return row.operation === "PutRecord" || row.operation === "PutRecordBatch" ? { dimension: "ingestion/direct-put" } : undefined
      case "StreamsSourceBilledBytes":
        return { dimension: "ingestion/kinesis" }
      default:
        return undefined
    }
  }
}
