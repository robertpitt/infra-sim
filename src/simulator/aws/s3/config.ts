import { Schema } from "effect"
import * as Component from "../../Component.ts"
import * as Edge from "../../Edge.ts"
import * as Setting from "../../Setting.ts"
import { D, MAX_PARTS, MiB, PART_MAX_BYTES, PART_MIN_BYTES, CLI_S3_CONFIG, PREFIX_RATE } from "./limits.ts"

/** Storage classes whose objects can be read at once (milliseconds). Everything else must be restored before a GET. */
export const INSTANT_CLASSES = ["standard", "intelligent-tiering", "standard-ia", "one-zone-ia", "glacier-instant"] as const
export const ARCHIVE_CLASSES = ["glacier-flexible", "deep-archive"] as const

/** What an event notification destination retries like. AWS documents "at least once" delivery, not the schedule. */
const Destination = Schema.Struct({
  eventTypes: Setting.choice(["all", "created", "removed"], {
    default: "all",
    label: "Event types",
    help: "Which changes this destination is subscribed to: s3:ObjectCreated:* (PUT, COPY, completed multipart upload), s3:ObjectRemoved:* (DELETE), or both.",
    labels: { all: "Created and removed", created: "Object created", removed: "Object removed" }
  }),
  filter: Setting.ratio({
    default: 1,
    label: "Share matching the filter",
    help: "A notification can be filtered by key prefix and suffix. The simulator has no key names, so a filter is the fraction of matching events that it lets through: 1 is no filter, 0.1 is a filter that matches one object in ten."
  }),
  retry: Edge.retryWith({ maxAttempts: 10, backoff: "1 second", backoffFactor: 2, maxBackoff: "20 seconds", jitter: true })
})

/** A replication rule's destination. Replication is on when this port is wired to a bucket. */
const Replica = Schema.Struct({
  filter: Setting.ratio({
    default: 1,
    label: "Share the rule covers",
    help: "A replication rule can be limited to a key prefix or tag. This is the fraction of new objects the rule matches: 1 replicates everything."
  }),
  retry: Edge.retryWith({ maxAttempts: 10, backoff: "1 second", backoffFactor: 2, maxBackoff: "20 seconds", jitter: true })
})

export const config = Schema.Struct({
  bucketType: Setting.choice(["general", "directory"], {
    default: "general",
    label: "Bucket type",
    help: "A general purpose bucket limits each prefix to 3,500 writes and 5,500 reads a second. An S3 Express One Zone directory bucket supports 200,000 writes and 2,000,000 reads a second in all, whatever the keys, and answers in single-digit milliseconds.",
    labels: { general: "General purpose", directory: "Directory (S3 Express One Zone)" }
  }),
  prefixes: Setting.int({
    default: 1,
    min: 1,
    max: 100_000,
    label: "Key prefixes",
    help: `How many distinct prefixes the requests spread over. Each prefix gets its own ${PREFIX_RATE.write.toLocaleString("en-US")} write and ${PREFIX_RATE.read.toLocaleString("en-US")} read requests a second. A hot key always lands on one prefix. A directory bucket ignores it.`
  }),
  prefixScaling: Setting.group(
    {
      enabled: Setting.bool({
        default: false,
        help: "S3 scales a busy prefix above its guaranteed rate, gradually, and answers 503 Slow Down while it does. Off: a prefix is held at the guaranteed rate. On: a prefix that keeps being refused is split, doubling its rate."
      }),
      splitAfter: Setting.duration({
        default: "5 minutes",
        min: "1 second",
        max: "1 day",
        label: "Split after",
        help: "How long a prefix must be refused without a break before S3 doubles its rate. AWS says the scaling is gradual and publishes no timing: this is an assumption."
      }),
      maxSplits: Setting.int({
        default: 10,
        min: 1,
        max: 30,
        label: "Largest number of splits",
        help: "A prefix is never scaled past 2 to this power times its guaranteed rate. AWS publishes no ceiling: this is an assumption."
      })
    },
    { label: "Prefix scale-up", help: "Model S3's gradual scaling of a new or suddenly hot prefix." }
  ),
  deleteShare: Setting.ratio({
    default: 0,
    label: "Writes that are deletes",
    help: "Share of write calls that are DELETEs: no body, same per-prefix allowance as PUT, and an object-removed event instead of object-created. The engine only tells a call apart as read or write, so the mix is set here."
  }),
  copyShare: Setting.ratio({
    default: 0,
    label: "Writes that are copies",
    help: "Share of write calls that are server-side COPYs: no upload from the client, the bytes move inside S3 at the transfer rate. Counted after the deletes, so delete plus copy share should not exceed 1."
  }),
  headShare: Setting.ratio({
    default: 0,
    label: "Reads that are HEADs",
    help: "Share of read calls that are HEAD requests: metadata only, no body, the same per-prefix read allowance as GET."
  }),
  listShare: Setting.ratio({
    default: 0,
    label: "Reads that are LISTs",
    help: "Share of read calls that are LIST requests (ListObjectsV2): no object body, a slower first byte. AWS publishes no separate LIST rate, so a LIST draws on the read allowance (an assumption). Counted before the HEADs."
  }),
  readLatency: Setting.latency({
    mean: "40 millis",
    cv: 1,
    label: "First-byte latency (read)",
    help: "Time until the first byte of a GET or HEAD. AWS says roughly 100 to 200 ms for consistent latency and tens of ms median; a spread of about that is an assumption."
  }),
  writeLatency: Setting.latency({
    mean: "70 millis",
    cv: 0.8,
    label: "First-byte latency (write)",
    help: "Time until S3 starts accepting the body of a PUT or answers a DELETE. An assumption: AWS publishes no figure."
  }),
  listLatency: Setting.latency({
    mean: "100 millis",
    cv: 0.8,
    label: "First-byte latency (list)",
    help: "Time until a LIST answers. An assumption: AWS publishes no figure."
  }),
  directoryLatencyFactor: Setting.number({
    default: 10,
    min: 1,
    max: 100,
    step: 1,
    label: "Directory bucket speed-up",
    help: "How many times faster a directory bucket answers than a general purpose bucket, applied to the first-byte latencies above. AWS says S3 Express One Zone is up to 10 times faster; the exact factor is an assumption."
  }),
  transferRate: Setting.number({
    default: 90,
    min: 1,
    max: 12_500,
    step: 1,
    unit: "MB/s",
    label: "Transfer rate per connection",
    help: "How fast one connection moves bytes, so a large object takes bytes / rate longer. About 90 MB/s per connection is older AWS guidance and an assumption; AWS now says only to use many parallel connections, and an instance can reach 100 Gb/s (12,500 MB/s)."
  }),
  multipart: Setting.group(
    {
      enabled: Setting.bool({
        default: false,
        help: "Split a large object into parts moved over parallel connections (multipart upload, or byte-range GETs). Off: one connection moves the whole object, and a write over 5 GB is refused."
      }),
      threshold: Setting.int({
        default: 8,
        min: 5,
        max: 5_120,
        unit: "MiB",
        label: "Switch above",
        help: `Object size at which a transfer is split. The AWS CLI default is 8 MB (${CLI_S3_CONFIG}).`
      }),
      partSize: Setting.int({
        default: 8,
        min: PART_MIN_BYTES / MiB,
        max: PART_MAX_BYTES / MiB,
        unit: "MiB",
        label: "Part size",
        help: `Size of each part: 5 MiB to 5 GiB. It is raised if the object would need more than ${MAX_PARTS.toLocaleString("en-US")} parts. The AWS CLI default is 8 MB.`,
        limit: Setting.hard(`${D}qfacts.html`, "Parts are 5 MiB to 5 GiB; the last may be smaller.")
      }),
      concurrency: Setting.int({
        default: 10,
        min: 1,
        max: 1_000,
        unit: "connections",
        label: "Parallel connections",
        help: `How many parts move at once. The AWS CLI default is 10 (${CLI_S3_CONFIG}); S3 limits no one's connections.`
      })
    },
    { label: "Multipart transfers", help: "Large objects as parallel parts. Each part is a request on the prefix, and an upload adds two more (start and complete)." }
  ),
  storageClass: Setting.choice([...INSTANT_CLASSES, ...ARCHIVE_CLASSES], {
    default: "standard",
    label: "Storage class of the objects",
    help: "Standard, Intelligent-Tiering, Standard-IA, One Zone-IA and Glacier Instant Retrieval read in milliseconds, like Standard. Glacier Flexible Retrieval and Deep Archive objects cannot be read until restored: a GET is refused with 403 InvalidObjectState.",
    labels: {
      standard: "Standard",
      "intelligent-tiering": "Intelligent-Tiering",
      "standard-ia": "Standard-IA",
      "one-zone-ia": "One Zone-IA",
      "glacier-instant": "Glacier Instant Retrieval",
      "glacier-flexible": "Glacier Flexible Retrieval",
      "deep-archive": "Glacier Deep Archive"
    }
  }),
  restoredShare: Setting.ratio({
    default: 0,
    label: "Archived reads that hit restored objects",
    help: "In an archive storage class, the share of GETs that find the object already restored (a restore keeps a temporary copy for the days you ask). Restore jobs themselves (minutes to 48 hours) are not simulated."
  }),
  versioning: Setting.bool({
    default: false,
    label: "Versioning",
    help: "With versioning on, a DELETE writes a delete marker instead of removing the object. It still costs one write request; the marker count is reported but changes nothing else."
  }),
  notificationDelay: Setting.latency({
    mean: "1500 millis",
    cv: 1,
    label: "Event notification delay",
    help: "AWS says events are typically delivered in seconds but can take a minute or longer. The distribution is an assumption."
  }),
  duplicateRate: Setting.ratio({
    default: 0,
    label: "Duplicate notifications",
    help: "Share of event notifications delivered twice. AWS designs for at-least-once delivery and publishes no duplicate rate, so it defaults to none: set it to see how consumers cope."
  }),
  replicationDelay: Setting.latency({
    mean: "15 seconds",
    cv: 1,
    label: "Replication delay",
    help: "Time from a write to its replica being written, for a bucket wired to a replication destination. S3 RTC replicates most objects in seconds and 99.9% within 15 minutes; without it AWS gives no figure (the table of options says 24 to 48 hours is not SLA backed). The distribution is an assumption."
  }),
  replicationTimeControl: Setting.bool({
    default: false,
    label: "Replication Time Control",
    help: "Replicate with S3 RTC. Its data rate is capped by the account's replication transfer quota (1 Gb/s by default), shared by every bucket in the region; beyond it replicas queue and lag grows."
  })
})
export type Config = typeof config.Type

export const ports = {
  events: Component.port.many("Event notifications", Destination),
  replication: Component.port.many("Replication destinations", Replica)
}

export const state = Schema.Struct({
  bucketType: Schema.String,
  prefixes: Schema.Number,
  served: Schema.Struct({
    reads: Schema.Number,
    writes: Schema.Number,
    deletes: Schema.Number,
    heads: Schema.Number,
    lists: Schema.Number,
    copies: Schema.Number,
    deleteMarkers: Schema.Number,
    multipartParts: Schema.Number
  }),
  throttled: Schema.Struct({ reads: Schema.Number, writes: Schema.Number }),
  refused: Schema.Struct({ archived: Schema.Number, tooLarge: Schema.Number }),
  /** Requests currently moving bytes. */
  transferring: Schema.Number,
  /** Per-prefix ceilings above the guaranteed rate (`prefixScaling`): how many are scaled and the highest. */
  scaled: Schema.Struct({ prefixes: Schema.Number, readCeiling: Schema.Number, writeCeiling: Schema.Number }),
  notifications: Schema.Struct({ destinations: Schema.Number, pending: Schema.Number, delivered: Schema.Number, undelivered: Schema.Number }),
  replication: Schema.Struct({ destinations: Schema.Number, pending: Schema.Number, delivered: Schema.Number, undelivered: Schema.Number })
})
