import type { DimensionSpec, ServiceMap } from "../map.ts"
import { attr } from "../map.ts"

/**
 * S3: storage (GB-months) and requests by storage class, the two request tiers being PUT, COPY, POST and LIST (tier 1)
 * and GET, HEAD and all other requests (tier 2; DELETE is free); per-GB retrieval fees of the infrequent-access classes;
 * an S3 Express One Zone directory bucket's storage, requests, and per-GB upload and retrieval; Intelligent-Tiering's
 * monitoring fee; the Replication Time Control fee on replicated bytes.
 * https://aws.amazon.com/s3/pricing/
 *
 * Usage types (after the region prefix): `TimedStorage-ByteHrs` (Standard, tiered by the month's GB), and
 * `TimedStorage-<class>-ByteHrs` for `INT-FA` (tiered), `INT-IA`, `INT-AIA`, `SIA`, `ZIA`, `GIR`, `XZ`;
 * `TimedStorage-GlacierByteHrs` (Glacier Flexible Retrieval); `Requests-Tier1` and `Requests-Tier2`, and
 * `Requests-<class>-Tier1|2` for `INT`, `SIA`, `ZIA`, `GIR`, `GLACIER`, `GDA`, `XZ`; `Retrieval-SIA|ZIA|GIR|XZ`;
 * `Upload-XZ`; `Monitoring-Automation-INT`; `<from>-<to>-S3RTC-Out-Bytes`. Deep Archive's storage and tier-1 requests are
 * in their own offer, `AmazonS3GlacierDeepArchive`; its tier-2 requests are in `AmazonS3`. The Glacier classes price
 * tier-1 requests by operation (a part of a multipart upload is cheaper); PutObject's price is the one here.
 * The region prefix is stripped here as well: the generator can't find it in files where most usage types are
 * region-pair transfers (`EU-` in eu-west-1).
 * Left out: data transfer (the datatransfer group's, replication's included), restores and their retrieval fees (the
 * simulator doesn't run restore jobs), the Intelligent-Tiering archive tiers (they need a restore), minimum object size
 * and minimum storage duration charges (`SmObjects`, `EarlyDelete`), lifecycle transitions, S3 Select, Tables, Vectors,
 * Files, Metadata, Storage Lens, Batch Operations, Reduced Redundancy, DSSE-KMS, Multi-Region Access Points.
 */

const CLASSES = {
  standard: "S3 Standard",
  "intelligent-tiering": "S3 Intelligent-Tiering",
  "standard-ia": "S3 Standard-IA",
  "one-zone-ia": "S3 One Zone-IA",
  "glacier-instant": "S3 Glacier Instant Retrieval",
  "glacier-flexible": "S3 Glacier Flexible Retrieval",
  "deep-archive": "S3 Glacier Deep Archive",
  "express-one-zone": "S3 Express One Zone (directory bucket)"
} as const
type Class = keyof typeof CLASSES

/** The class a usage type's infix names: `Requests-SIA-Tier1`, `TimedStorage-ZIA-ByteHrs`. */
const INFIX: Record<string, Class> = {
  "": "standard",
  INT: "intelligent-tiering",
  "INT-FA": "intelligent-tiering",
  SIA: "standard-ia",
  ZIA: "one-zone-ia",
  GIR: "glacier-instant",
  GLACIER: "glacier-flexible",
  Glacier: "glacier-flexible",
  GDA: "deep-archive",
  XZ: "express-one-zone"
}

const each = (f: (c: Class, name: string) => [string, DimensionSpec]) => Object.fromEntries(Object.entries(CLASSES).map(([c, name]) => f(c as Class, name)))

export const s3: ServiceMap = {
  id: "s3",
  title: "Amazon S3",
  offers: ["AmazonS3", "AmazonS3GlacierDeepArchive"],
  dimensions: {
    ...each((c, name) => [`storage/${c}`, { unit: "GB-month", description: `Storage in ${name}${c === "intelligent-tiering" ? ", Frequent Access" : ""}` }]),
    "storage/intelligent-tiering-infrequent": {
      unit: "GB-month",
      description: "Storage in S3 Intelligent-Tiering, Infrequent Access tier (not read for 30 days)"
    },
    "storage/intelligent-tiering-archive-instant": {
      unit: "GB-month",
      description: "Storage in S3 Intelligent-Tiering, Archive Instant Access tier (not read for 90 days)"
    },
    ...each((c, name) => [`requests/put/${c}`, { unit: "request", description: `PUT, COPY, POST and LIST requests to ${name}` }]),
    ...each((c, name) => [`requests/get/${c}`, { unit: "request", description: `GET, HEAD and all other requests to ${name} (DELETE is free)` }]),
    "retrieval/standard-ia": { unit: "GB", description: "Data read from S3 Standard-IA" },
    "retrieval/one-zone-ia": { unit: "GB", description: "Data read from S3 One Zone-IA" },
    "retrieval/glacier-instant": { unit: "GB", description: "Data read from S3 Glacier Instant Retrieval" },
    "retrieval/express-one-zone": { unit: "GB", description: "Data read from S3 Express One Zone: the part of each request over 512 KB" },
    "upload/express-one-zone": { unit: "GB", description: "Data written to S3 Express One Zone: the part of each request over 512 KB" },
    "monitoring/intelligent-tiering": { unit: "object-month", description: "S3 Intelligent-Tiering monitoring and automation, per object of 128 KB or more" },
    "replication-time-control": { unit: "GB", description: "Data replicated with S3 Replication Time Control (on top of the data transfer)" }
  },
  classify: (row) => {
    // The region prefix when the generator left it (`EU-Requests-Tier1`); never part of a usage type's own name.
    const usage = row.usage.replace(/^[A-Z]{2,4}[0-9]?-(?=[A-Z][a-z])/, "")
    let m: RegExpExecArray | null
    // A region's file lists RTC between region pairs, both ways; the fee is the source region's. Same-region pairs are
    // left out: AWS lists some at 0 (ap-south-2) and others at the fee (us-east-1), where the pricing page says the fee.
    if (/-S3RTC-Out-Bytes$/.test(usage))
      return attr(row, "From Region Code") === row.region && attr(row, "To Region Code") !== row.region ? { dimension: "replication-time-control" } : undefined
    // Rows with an operation are other things billed under a storage usage type (archive tiers' object overhead).
    if (usage.startsWith("TimedStorage-") && row.operation !== "") return undefined
    if (usage === "Monitoring-Automation-INT") return { dimension: "monitoring/intelligent-tiering" }
    if (usage === "TimedStorage-INT-IA-ByteHrs") return { dimension: "storage/intelligent-tiering-infrequent" }
    if (usage === "TimedStorage-INT-AIA-ByteHrs") return { dimension: "storage/intelligent-tiering-archive-instant" }
    if (usage === "TimedStorage-GlacierByteHrs") return { dimension: "storage/glacier-flexible" }
    if ((m = /^TimedStorage-(?:(INT-FA|SIA|ZIA|GIR|GDA|XZ)-)?ByteHrs$/.exec(usage))) return { dimension: `storage/${INFIX[m[1] ?? ""]}` }
    if ((m = /^Requests-(?:(INT|SIA|ZIA|GIR|GLACIER|GDA|XZ)-)?Tier([12])$/.exec(usage))) {
      const c = INFIX[m[1] ?? ""]!
      // Glacier Flexible and Deep Archive list tier 1 by operation: PutObject, and cheaper parts of multipart uploads.
      if (m[2] === "1" && (c === "glacier-flexible" || c === "deep-archive") && row.operation !== "PutObject") return undefined
      return { dimension: `requests/${m[2] === "1" ? "put" : "get"}/${c}` }
    }
    if ((m = /^Retrieval-(SIA|ZIA|GIR|XZ)$/.exec(usage))) return { dimension: `retrieval/${INFIX[m[1]!]}` }
    if (usage === "Upload-XZ") return { dimension: "upload/express-one-zone" }
    return undefined
  }
}
