/**
 * Units the AWS components share: binary byte sizes, milliseconds per second, minute, hour and day, and link
 * bandwidth. Plain numbers with no imports, so a `Quotas.ts` or `Audit.ts` can use them without reaching a component.
 */

/** One kibibyte, in bytes. */
export const KiB = 1024
/** One mebibyte, in bytes. */
export const MiB = 1024 * KiB
/** One gibibyte, in bytes. */
export const GiB = 1024 * MiB
/** One tebibyte, in bytes. */
export const TiB = 1024 * GiB

/** One second, in milliseconds. */
export const SECOND_MS = 1000
/** One minute, in milliseconds. */
export const MINUTE_MS = 60 * SECOND_MS
/** One hour, in milliseconds. */
export const HOUR_MS = 60 * MINUTE_MS
/** One day, in milliseconds. */
export const DAY_MS = 24 * HOUR_MS

/** Bytes a second in one Gbit/s. */
export const BYTES_PER_GBPS = 1e9 / 8
