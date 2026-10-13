import { GiB, MiB, TiB } from "../../internal/units.ts"

/**
 * Every number Amazon publishes about S3 that the component enforces, in one place, with the page it comes from.
 * Numbers that are only assumptions (latency shapes, retry cadence) live next to the setting that exposes them.
 */

export const D = "https://docs.aws.amazon.com/AmazonS3/latest/userguide/"
/** The AWS General Reference page of S3 service quotas. */
export const QUOTAS = "https://docs.aws.amazon.com/general/latest/gr/s3.html"
/** The AWS CLI's S3 transfer defaults: the only documented figures for how a client splits a large transfer. */
export const CLI_S3_CONFIG = "https://docs.aws.amazon.com/cli/latest/topic/s3-config.html"

/**
 * Requests per second one partitioned prefix is *guaranteed* ("at least"): GET and HEAD share the read allowance;
 * PUT, COPY, POST and DELETE share the write allowance. S3 scales a busy prefix above this on its own, gradually.
 * Source: `${D}optimizing-performance.html`.
 */
export const PREFIX_RATE = { read: 5_500, write: 3_500 } as const

/**
 * What one S3 Express One Zone directory bucket supports: 2,000,000 GET and 200,000 PUT transactions per second per
 * bucket. Directories scale instantly, so there is no per-prefix rate and no gradual scale-up.
 * Source: `${D}s3-express-optimizing-performance-design-patterns.html`.
 */
export const DIRECTORY_RATE = { read: 2_000_000, write: 200_000 } as const

/** One PutObject or CopyObject carries at most 5 GB; bigger objects need a multipart upload. Source: `${D}upload-objects.html`. */
export const SINGLE_PUT_MAX_BYTES = 5 * GiB

/** Multipart upload: parts of 5 MiB to 5 GiB (the last may be smaller), at most 10,000 of them. Source: `${D}qfacts.html`. */
export const PART_MIN_BYTES = 5 * MiB
export const PART_MAX_BYTES = 5 * GiB
export const MAX_PARTS = 10_000
/** The largest object: 10,000 parts of 5 GiB, which the quotas page states as 48.828125 TB (48.8 TiB). */
export const MAX_OBJECT_BYTES = PART_MAX_BYTES * MAX_PARTS

/**
 * A multipart upload is one POST to start it, one PUT per part and one POST to complete it. Each is a request that
 * counts against the prefix's allowance. Source: `${D}mpuoverview.html`.
 */
export const MULTIPART_CONTROL_REQUESTS = 2

/**
 * Event notifications are "designed to be delivered at least once", typically in seconds, sometimes a minute or longer.
 * What one weighs when it arrives is not published: a small JSON record. Source: `${D}EventNotifications.html`.
 */
export const EVENT_BYTES = 1_024
