import { Data, Effect, Schema } from "effect"

/** A unit of work flowing through a design: a request, a message, an event. */
export const Message = Schema.Struct({
  id: Schema.Int,
  /** Virtual time (ms) the originating client created it; end-to-end latency is measured from here. */
  bornAt: Schema.Number,
  /** Node that created it. */
  origin: Schema.String,
  /** 1 for the first delivery; queues increment it on redelivery. */
  attempt: Schema.Int,
  /** Payload size in bytes. Services enforce their own size limits against it. */
  bytes: Schema.Number,
  /** Records carried. A batch is one message with `count` above 1. */
  count: Schema.Int,
  /**
   * Set on a batch a taker handed over (a poller's batch from a queue), even a batch of one: its records can fail on
   * their own, and the reply may name them (`ItemFailures`). A plain call with one record isn't a batch.
   */
  batched: Schema.optionalKey(Schema.Boolean),
  /** How the caller invoked the receiver. Lambda, for one, treats the two very differently. */
  invocation: Schema.Literals(["sync", "async"]),
  /** What the call does to the receiver: reads or writes. DynamoDB and S3 price and limit them differently. */
  operation: Schema.Literals(["read", "write"]),
  /** A hash of the partition key, in [0, 1). It decides which DynamoDB partition or Kinesis shard a call lands on. */
  key: Schema.Number,
  /**
   * For a batch (`count` above 1): the share of its records whose keys are their own, spread over the key space; the
   * rest all carry `key`. Absent means 1, as a batch API call's records each carry their own key. A batch of one hot
   * key's records has 0, and a client's batch with a hot-key share has the rest. Stores spread a batch's units over
   * their partitions accordingly, so only the shared-key part lands on one.
   */
  spread: Schema.optionalKey(Schema.Number),
  /** FIFO message group, when the sender uses one. */
  group: Schema.optionalKey(Schema.String),
  /** When a queue first accepted it. A standard queue's dead-letter queue keeps counting retention from here. */
  firstEnqueuedAt: Schema.optionalKey(Schema.Number)
})
export type Message = typeof Message.Type

/**
 * Why a call between components failed.
 *
 * Plain tagged data rather than `Error` subclasses: a retry storm creates thousands per second and capturing a
 * stack trace for each would dominate the run (measured: ~10x slower). They still work with `Effect.catchTag`.
 */
export type CallFailure = Data.TaggedEnum<{
  /** Rejected for lack of capacity: 429, concurrency limit, full queue, exhausted throughput. */
  Throttled: { readonly node: string; readonly reason: string }
  /** The target is down or unreachable and said so at once: outage, connection refused. */
  Unavailable: { readonly node: string; readonly reason: string }
  /** The caller gave up waiting. */
  Timeout: { readonly edge: string; readonly after: number }
  /** The handler ran and failed: HTTP 500. */
  Failed: { readonly node: string; readonly reason: string }
  /** The request itself was refused (too large, malformed): a 4xx. Retrying can't help. */
  Rejected: { readonly node: string; readonly reason: string }
}>

export const { Throttled, Unavailable, Timeout, Failed, Rejected, $is: isFailure, $match: matchFailure } = Data.taggedEnum<CallFailure>()

/**
 * A call that succeeded except for some records of its batch, named by position (0-based, in the order the batch was
 * sent). It is a success, not a failure: a Lambda function that returns `batchItemFailures` ran and returned normally, as
 * does a DynamoDB `BatchWriteItem` with `UnprocessedItems` or an SQS `SendMessageBatch` with failed entries. What the
 * caller does about the failed records (redeliver them, retry them, or ignore the report) is the caller's business.
 *
 * Records are identified by position rather than by objects of their own so that a batch stays one message with a count:
 * the common case allocates nothing per record.
 */
export interface ItemFailures {
  readonly _tag: "ItemFailures"
  /** Positions of the records that failed, ascending. */
  readonly failed: ReadonlyArray<number>
}

export const itemFailures = (failed: ReadonlyArray<number>): ItemFailures => ({ _tag: "ItemFailures", failed })

/** What a successful call answers: nothing (all of it worked), or which records of its batch didn't. */
export type Reply = void | ItemFailures

/** What every component boundary speaks: an effect that may fail with a `CallFailure`, or succeed with a `Reply`. */
export type Call = Effect.Effect<Reply, CallFailure>

/** Counter name for a failure, e.g. `fail.Throttled`. */
export const failureCounter = (failure: CallFailure): string => `fail.${failure._tag}`

/** Failures worth retrying. A refused request will be refused again. */
export const isRetryable = (failure: CallFailure): boolean => failure._tag !== "Rejected"
