import type { Pull } from "../../Protocol.ts"
import * as pull from "./internal/pull.ts"
import * as internal from "./internal/readers.ts"
import type { Cursor, Subscription } from "./internal/readers.ts"
import type { StreamModel } from "./internal/stream.ts"

/**
 * The consumers of a stream and how they read it.
 *
 * Each consumer (an edge from the `consumers` port) has a `Subscription` with a `Cursor` per shard, and reads every shard
 * on its own. A standard reader calls GetRecords when it wants records, drawing on the shard's shared allowance of five
 * calls and 2 MiB a second; an enhanced fan-out reader is pushed what becomes readable, within 2 MiB a second per shard of
 * its own. A consumer reads a child shard only once it has finished every parent. What it does with the records
 * (Lambda's batches, Firehose's buffers) is its own business: the readers only move positions.
 *
 * Connectors made for Kinesis (Lambda's event source mapping, Firehose's source) reach the stream through `streamOf` and
 * subscribe to it with a `ConsumerSpec`.
 */

/** A data stream, as a consumer sees it: `subscribe`, `retention`, `expired`, `discard` and the rest. */
export type { StreamModel }

/** One consumer's place in one shard, and one consumer's reading of the stream: a cursor per shard. */
export type { Cursor, Subscription }

/** What a consumer tells the stream about itself. */
export interface ConsumerSpec<L> {
  /** Who reads (the edge), for the probe. */
  readonly name: string
  /** Reading through enhanced fan-out right now. Read live: a mapping can be switched while running. */
  readonly efo: () => boolean
  /** A standard reader's GetRecords cadence once it has caught up. */
  readonly pollMs: number
  /** Whether a standard reader that is behind calls again at once (Lambda) or keeps to its cadence (Firehose). */
  readonly catchUp: boolean
  /** A shard became readable for this consumer: make what it keeps per shard. */
  readonly start: (cursor: Cursor<L>) => L
  /** Records were fetched into the cursor, or its shard closed: look again. */
  readonly wake: (cursor: Cursor<L>) => void
  /** New records became readable in the shard (not yet fetched): for a consumer that reads on demand. */
  readonly sealed?: (cursor: Cursor<L>) => void
  /** How far behind it is: the age of its oldest unprocessed record (ms) and the records it has still to process. */
  readonly lag: (now: number) => Lag
  /** Records were read for it (a GetRecords call returned them, or they were pushed): for its own metrics. */
  readonly read?: (records: number, bytes: number) => void
  /** One of its GetRecords calls was throttled by the shard's read limits: for its own metrics. */
  readonly readThrottled?: () => void
}

/** How far behind a consumer is: the age of its oldest unprocessed record (ms), and the records it has still to process. */
export interface Lag {
  readonly ageMs: number
  readonly records: number
}

/** What a consumer keeps per shard for its lag: records before its start (`before`), and records processed since. */
export interface Progress {
  readonly base: number
  readonly done: number
}

/** The stream behind a pull source, when the source is a Kinesis stream's port. */
export const streamOf = (source: Pull): StreamModel | undefined => pull.streamOf(source)

/**
 * Records written to the cursor's shard before the cursor's starting point: none for a shard read from its start (a
 * child of a reshard), all of them for a consumer that started at LATEST. What a consumer has still to process is the
 * shard's total less these and less what it has processed.
 */
export const before = <L>(cursor: Cursor<L>): number => internal.before(cursor)

/**
 * A consumer's lag over its subscription, worked out once an instant (several gauges ask at each frame): the arrival of
 * the oldest record it has still to process, `oldest` saying where that is in one unfinished shard (or `Infinity`), and
 * the records it has still to process. `sub` is read when first asked, so the meter can be made before the subscription.
 */
export const lagMeter = <L extends Progress>(sub: () => Subscription<L>, oldest: (cursor: Cursor<L>) => number): ((now: number) => Lag) =>
  internal.lagMeter(sub, oldest)
