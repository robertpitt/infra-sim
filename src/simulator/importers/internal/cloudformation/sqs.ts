import { asBoolean, asNumber } from "../../Intrinsics.ts"
import { redrivePolicy, secs, num } from "./common.ts"
import { type Bag, type Draft, type Handler, listOf, nameOf, type Run, SOURCE, seconds } from "./model.ts"

/** `AWS::SQS::Queue`, its redrive policy, and the event source mapping that makes a function consume it. */

export const queue: Handler = (run, r) => {
  const d = run.draft(r.id, nameOf(r), "aws.sqs", { source: SOURCE, ref: r.id, type: r.type })
  const p = r.props
  const fifo = asBoolean(p.FifoQueue)
  if (fifo === true) run.set(d, ["kind"], "fifo", "FifoQueue")
  run.set(d, ["visibilityTimeout"], secs(p.VisibilityTimeout), "VisibilityTimeout")
  run.set(d, ["retention"], secs(p.MessageRetentionPeriod), "MessageRetentionPeriod")
  run.set(d, ["delay"], secs(p.DelaySeconds), "DelaySeconds")
  if (fifo === true && p.FifoThroughputLimit === "perMessageGroupId" && p.DeduplicationScope === "messageGroup") run.set(d, ["highThroughput"], true, "FifoThroughputLimit")
  // Content-based deduplication hashes the body; the component deduplicates by the message's own id, which is the closest it has.
  if (fifo === true && asBoolean(p.ContentBasedDeduplication) === true) run.set(d, ["deduplication"], true, "ContentBasedDeduplication")
}

/** Redrive policies refer to the dead-letter queue, so they are read once every queue exists. */
export const redrive: Handler = (run, r) => {
  const d = run.drafts.get(r.id)
  if (d === undefined) return
  const { dlq, maxReceive } = redrivePolicy(run, r.props.RedrivePolicy)
  if (dlq !== undefined) run.wire(d, "dlq", dlq, { name: "Dead letter", origin: { source: SOURCE, ref: "RedrivePolicy" } })
  run.set(d, ["maxReceives"], num(maxReceive), "RedrivePolicy.maxReceiveCount")
}

/**
 * What a function reads from a queue: batch size, batching window, maximum concurrency or provisioned pollers. Shared
 * by `AWS::Lambda::EventSourceMapping` and the SAM `SQS` event, which take the same properties.
 */
export const queueConsumer = (run: Run, source: Draft, fn: Draft, p: Bag, origin: { readonly source: string; readonly ref: string }): void => {
  const settings = batching(p)
  const concurrency = asNumber(p.ScalingConfig?.MaximumConcurrency)
  if (concurrency !== undefined) settings.maxConcurrency = concurrency
  // Provisioned pollers keep a floor of pollers running instead of ramping from five, and cap the top.
  const min = asNumber(p.ProvisionedPollerConfig?.MinimumPollers)
  if (min !== undefined) settings.provisionedMinPollers = min
  const max = asNumber(p.ProvisionedPollerConfig?.MaximumPollers)
  if (max !== undefined) settings.provisionedMaxPollers = max
  // Partial batch responses: the mapping acts on them, and a function configured for them is taken to return them.
  const partial = listOf(p.FunctionResponseTypes).includes("ReportBatchItemFailures")
  if (partial) {
    settings.reportBatchItemFailures = true
    run.set(fn, ["batch", "errors"], "report", "FunctionResponseTypes: ReportBatchItemFailures")
  }
  run.wire(source, "deliver", fn, { settings, origin })
  unsimulatedMappingFeatures(run, fn, p, { partial: true })
}

/** The batching every event source mapping has, as connector settings: how many records, and how long to gather them. */
export const batching = (p: Bag): Record<string, unknown> => {
  const settings: Record<string, unknown> = {}
  const batch = asNumber(p.BatchSize)
  if (batch !== undefined) settings.batchSize = batch
  const window = asNumber(p.MaximumBatchingWindowInSeconds)
  if (window !== undefined) settings.batchWindow = seconds(window)
  return settings
}

/** What an event source mapping can say that the simulator can't do: said so, once per function. */
export const unsimulatedMappingFeatures = (run: Run, fn: Draft, p: Bag, handled: { readonly partial?: boolean } = {}): void => {
  if (!handled.partial && listOf(p.FunctionResponseTypes).includes("ReportBatchItemFailures")) {
    run.warn(`${fn.name}: ReportBatchItemFailures isn't simulated for this source: a failed batch is retried whole, not just the records that failed.`)
  }
  if (p.FilterCriteria !== undefined) run.warn(`${fn.name}: FilterCriteria on its event source isn't simulated: every record is delivered.`)
  if (asNumber(p.TumblingWindowInSeconds) !== undefined) run.warn(`${fn.name}: TumblingWindowInSeconds isn't simulated: records are delivered in ordinary batches.`)
}
