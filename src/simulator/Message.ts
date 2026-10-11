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
  /** How the caller invoked the receiver. Lambda, for one, treats the two very differently. */
  invocation: Schema.Literals(["sync", "async"]),
  /** What the call does to the receiver: reads or writes. DynamoDB and S3 price and limit them differently. */
  operation: Schema.Literals(["read", "write"]),
  /** A hash of the partition key, in [0, 1). It decides which DynamoDB partition or Kinesis shard a call lands on. */
  key: Schema.Number,
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

/** What every component boundary speaks: an effect that may fail with a `CallFailure`. */
export type Call = Effect.Effect<void, CallFailure>

/** Counter name for a failure, e.g. `fail.Throttled`. */
export const failureCounter = (failure: CallFailure): string => `fail.${failure._tag}`

/** Failures worth retrying. A refused request will be refused again. */
export const isRetryable = (failure: CallFailure): boolean => failure._tag !== "Rejected"
