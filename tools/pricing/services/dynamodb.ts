import type { Row } from "../bulk.ts"
import type { Match, ServiceMap } from "../map.ts"

/**
 * DynamoDB: read and write request units in on-demand mode; read and write capacity unit-hours in provisioned mode;
 * storage (GB-months); DynamoDB Streams read request units (GetRecords); global tables' replicated writes, on-demand and
 * provisioned. Each table-level price comes in the Standard and the Standard-Infrequent Access table class.
 * https://aws.amazon.com/dynamodb/pricing/
 *
 * Usage types (after the region prefix, `IA-` for Standard-IA): `ReadRequestUnits`, `WriteRequestUnits`,
 * `ReplWriteRequestUnits`; `ReadCapacityUnit-Hrs`, `WriteCapacityUnit-Hrs`, `ReplWriteCapacityUnit-Hrs`; `TimedStorage-ByteHrs`;
 * `Streams-Requests`. The free tier is the first range of the Standard class's usage types: 25 RCUs, 25 WCUs and 25
 * replicated WCUs (18,600 unit-hours a month each), 25 GB of storage, 2.5 million stream read requests. us-east-1 keeps
 * a `USE1-` prefix on some usage types (streams among them) and not on others, so the prefix is stripped here too.
 * Left out: backups (on-demand and PITR), restores, export and import, Kinesis and Glue change data capture, vector
 * search, reserved capacity, DAX: the simulator models none of them.
 */

const CLASSES = { "": "standard", "IA-": "standard-ia" } as const

const LABEL = { standard: "Standard table class", "standard-ia": "Standard-IA table class" } as const

/** One dimension per table class, from a template: `on-demand/read/standard`, `on-demand/read/standard-ia`. */
const byClass = (id: string, unit: string, what: string) =>
  Object.fromEntries(Object.values(CLASSES).map((c) => [`${id}/${c}`, { unit, description: `${what} (${LABEL[c]})` }]))

const TABLE: Record<string, string> = {
  ReadRequestUnits: "on-demand/read",
  WriteRequestUnits: "on-demand/write",
  ReplWriteRequestUnits: "replicated-write/on-demand",
  "ReadCapacityUnit-Hrs": "provisioned/read",
  "WriteCapacityUnit-Hrs": "provisioned/write",
  "ReplWriteCapacityUnit-Hrs": "replicated-write/provisioned",
  "TimedStorage-ByteHrs": "storage"
}

/** A usage type without the region prefix the generator could not strip (us-east-1's `USE1-` on some of them). */
const usageOf = (row: Row) => row.usage.replace(/^[A-Z]{2,4}[0-9]-/, "")

/** The free tier is the usage type's first range, at 0 (`0-18600` unit-hours, `0-25` GB-months); the rest is paid. */
const paid = (row: Row, dimension: string): Match =>
  row.price === 0 && row.from === 0 && row.to !== Number.POSITIVE_INFINITY ? { dimension, free: true } : { dimension }

export const dynamodb: ServiceMap = {
  id: "dynamodb",
  title: "Amazon DynamoDB",
  offers: ["AmazonDynamoDB"],
  dimensions: {
    ...byClass("on-demand/read", "request-unit", "Read request units, on-demand mode"),
    ...byClass("on-demand/write", "request-unit", "Write request units, on-demand mode"),
    ...byClass("provisioned/read", "unit-hour", "Read capacity units provisioned, per hour"),
    ...byClass("provisioned/write", "unit-hour", "Write capacity units provisioned, per hour"),
    ...byClass("replicated-write/on-demand", "request-unit", "Replicated write request units to a global table replica, on-demand mode"),
    ...byClass("replicated-write/provisioned", "unit-hour", "Replicated write capacity units provisioned on a global table replica, per hour"),
    ...byClass("storage", "GB-month", "Table and index storage"),
    "streams/read": {
      unit: "request-unit",
      description: "DynamoDB Streams read request units (GetRecords calls), either table class"
    }
  },
  classify: (row) => {
    const usage = usageOf(row)
    if (usage === "Streams-Requests") return paid(row, "streams/read")
    const ia = usage.startsWith("IA-")
    const base = TABLE[ia ? usage.slice(3) : usage]
    if (base === undefined) return undefined
    return paid(row, `${base}/${ia ? CLASSES["IA-"] : CLASSES[""]}`)
  }
}
