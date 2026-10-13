# SQS (`aws.sqs`)

Amazon SQS decouples a producer from a consumer with a durable queue: the producer is told "accepted" at once, and the
consumer takes messages when it can, deletes them when it is done, and gets them again if it never says so. A **standard**
queue is effectively unlimited in throughput and delivers at least once with best-effort ordering; a **FIFO** queue
delivers in order within each message group, optionally deduplicates, and is rate-limited. This component lets you learn
what that does to a design: backlog and its age, what a visibility timeout shorter than the consumer does (work done
twice), what a poison message does to a FIFO group, where a dead-letter queue and a redrive loop come from, and how
Lambda's event source mapping scales up on a backlog, backs off when throttled and spends the visibility timeout while it
gathers a batch.

Everything runs on virtual time with seeded randomness, and the hot path is plain functions and timers (no effect per message).

## Coverage

| Feature | Status | Notes |
| --- | --- | --- |
| **Requests** | | |
| Send (single and batch), 1 MiB limit | ✅ | A call with `count` records makes `count` messages; over 1 MiB in total is `Rejected`. A `count` of 0 sends nothing. |
| Standard queue: at-least-once, best-effort order | ✅ | Redeliveries go to the back of the queue. Duplicate work from a slow consumer is counted (`duplicates`). |
| FIFO: order within a message group, one message in flight per group | ✅ | A group is blocked while any of its messages is in flight; a redelivered message goes back to the head of its group. A call with no group uses one group called `default` (AWS rejects it). |
| FIFO batches span groups | ✅ | A receive of up to 10 is filled from one group, then the next. |
| FIFO deduplication (5 minutes) | 🟡 | Off by default (`deduplication`). The sender's message id is the deduplication id, so a producer retrying a send is deduplicated. Content-based deduplication and `DeduplicationScope` are not modelled: messages have no body. |
| Per-message timers (`DelaySeconds` on a send) | ❌ | The message has no delay field. |
| Receive: short polling, false empties, `WaitTimeSeconds` | ❌ | Consumers take through the `deliver` port's `pull` protocol: Lambda's event source mapping (long polls) or a fixed pool of workers (`core.poller`). Neither short-polls. |
| `ChangeMessageVisibility`, 12 hour cap | ❌ | Consumers can't call back into the queue. |
| **Throttling** | | |
| FIFO 300 calls/s per action, 3,000 messages/s batched | ✅ | Sends are refused with `Throttled`; receives wait for a token. Deletes are not limited. |
| FIFO high-throughput mode and regional quota | ✅ | The quota is an account setting (`sqsFifoHighThroughput`), live and per region. |
| One message group held to one partition (300 calls/s) | 🟡 | Only for messages that name a group, in high-throughput mode. AWS does not publish how groups map to partitions, so this is the ceiling for a single group, not a model of shared partitions. |
| Standard queue throughput | ✅ | Unlimited, as AWS publishes no number. |
| In-flight limit | ✅ | A receive returns nothing at the limit (what long polling does), and a batch is cut to fit. No `OverLimit` error: nothing short-polls. |
| **Visibility and delivery** | | |
| Visibility timeout, redelivery, receive count | ✅ | One timer per ReceiveMessage. A message belongs to the receive that last took it; a delete by an older receive does nothing (counted as a duplicate). |
| Delay queue | ✅ | `delay`, not retroactive. (FIFO's is retroactive in AWS: not modelled.) |
| Retention (60 s to 14 days) | ✅ | Applies to every message whatever its state, including in flight and delayed. |
| Dead-letter queue, `maxReceiveCount` | ✅ | Moved when the visibility timeout lapses with the count reached. A standard DLQ keeps counting retention from the original enqueue time, FIFO restarts it. A move the DLQ refuses is retried and the message stays in flight (a FIFO group stays blocked). |
| Poison pill leaves ApproximateAgeOfOldestMessage | ✅ | Standard queues stop counting a message received three or more times. |
| DLQ redrive (move back) | 🟡 | `redrive` plus an edge on the `redrive` port: moves oldest first at the chosen velocity (up to 500/s), as new messages. There is no "task" that finishes, no 36 hour limit, no redrive allow policy, and the destination must be wired (AWS defaults to the source). |
| Fair queues (standard queue with `MessageGroupId`) | ❌ | See *Not yet simulated*. |
| **Lambda event source mapping** (the `aws.sqs.event-source-mapping` connector) | | |
| Start at 5, +300/minute while messages wait, to 1,250 | ✅ | Per consumer edge. Scales back down when the backlog clears. |
| Waits for the function, however long it runs | ✅ | The function's own timeout ends a slow batch; the mapping has no caller timeout of its own (only the 15 minute Invoke ceiling). |
| Maximum concurrency, batch size, batching window, 6 MB cut | ✅ | |
| Gathered messages are in flight | ✅ | The visibility timeout starts at the receive, not at the invocation. |
| Throttled: keep the batch, retry until the visibility timeout ends | ✅ | Retry interval is an assumption (`throttleRetry`). |
| Function error: messages stay hidden, mapping backs off | ✅ | The back-off speed is an assumption. |
| Provisioned mode | 🟡 | `provisionedMinPollers`/`provisionedMaxPollers`: 10 invocations per poller, +1,000 a minute, to 100,000. Poller throughput (1 MB/s, 10 polls/s) is not modelled. |
| Partial batch responses (`ReportBatchItemFailures`) | ✅ | `reportBatchItemFailures` on the edge: a success naming failed records deletes the rest and leaves those to come back, without backing off. Off, the reply is ignored and the failed records are deleted too (`itemFailuresIgnored`). FIFO keeps a failed record's later messages of the same group. |
| Event filtering | ❌ | |
| **Metrics** | | |
| Visible, not visible, delayed, oldest age, groups in flight | ✅ | Gauges. |
| Sent, received, deleted, deduplicated | ✅ | Per-second rates. |
| Empty receives | 🟡 | An estimate from idle pollers: one empty long poll per 20 s each. |
| `SentMessageSize`, fair-queue metrics | ❌ | |

## Settings

Queue (`aws.sqs`):

| Setting | Default | Range | Kind | What it models |
| --- | --- | --- | --- | --- |
| `kind` | `standard` | `standard`, `fifo` | | The queue type. Fixed when the queue is created, as in AWS. |
| `retention` | 4 days | 1 minute to 14 days | hard | `MessageRetentionPeriod`. |
| `visibilityTimeout` | 30 seconds | 0 to 12 hours | hard | `VisibilityTimeout`. |
| `delay` | 0 | 0 to 15 minutes | hard | `DelaySeconds` (a delay queue). |
| `maxReceives` | 5 | 1 to 1,000 | hard | `maxReceiveCount` of the redrive policy. AWS has no default; 5 is what it recommends for a Lambda consumer. Without a DLQ edge nothing is dead-lettered. |
| `inFlightLimit` | 120,000 | 1 to 10,000,000 | quota | Messages in flight. The upper bound is an assumption. |
| `highThroughput` | off | | | FIFO high-throughput mode. |
| `deduplication` | off | | | FIFO deduplication by message id. Off because components that fan a batch out re-send records with one id. |
| `redrive` | off | | | Run a DLQ redrive to the `redrive` port while on. |
| `redriveVelocity` | 0 | 0 to 500 | hard | Messages per second. 0 is "system optimised": 1,000/s assumed. |

An edge on the `deliver` port carries the `aws.sqs.event-source-mapping` connector unless it names another (see
[PRIMITIVES.md](../../../../PRIMITIVES.md)). Its settings, besides transport's latency:

| Setting | Default | Range | Kind | What it models |
| --- | --- | --- | --- | --- |
| `batchSize` | 10 | 1 to 10,000 (FIFO: 10) | hard | `BatchSize`. Above 10 AWS requires a window of at least a second; not enforced. |
| `batchWindow` | 0 | 0 to 5 minutes (standard only) | hard | `MaximumBatchingWindowInSeconds`. |
| `maxConcurrency` | 0 (none) | 0 to 1,000 | hard | `ScalingConfig.MaximumConcurrency`. AWS accepts 2 to 1,000; 1 is allowed here. |
| `initialConcurrency` | 5 | 1 to 1,250 | hard | AWS starts a standard mapping at 5. Fixed in AWS, editable here. |
| `scaleUpPerMinute` | 300 | 0 to 10,000 | hard | AWS adds up to 300 a minute. |
| `reportBatchItemFailures` | off | | | `FunctionResponseTypes: [ReportBatchItemFailures]`: act on a reply that names the records that failed. |
| `throttleRetry` | 1 second | 100 ms to 1 minute | assumed | Wait before a throttled batch is retried. |
| `provisionedMinPollers` | 0 (off) | 0 to 200 | hard | `ProvisionedPollerConfig.MinimumPollers` (AWS: 2 to 200). Ignores `maxConcurrency`, as AWS does not allow both. |
| `provisionedMaxPollers` | 200 | 2 to 10,000 | hard | `MaximumPollers`. See the discrepancy below. |

Account quota (per region, in the Region box): `sqsFifoHighThroughput`, non-batched requests per second per queue in
high-throughput mode, 300 or more.

## Limits

| Limit | Value | Kind | Source |
| --- | --- | --- | --- |
| Message size | 1 MiB (1,048,576 bytes). The general reference still says 256 KB: stale. | hard | [message quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html), [reference](https://docs.aws.amazon.com/general/latest/gr/sqs-service.html) |
| Messages per send, receive or delete batch | 10 | hard | message quotas |
| Retention | 60 s to 14 days, default 4 days | hard | message quotas |
| Visibility timeout | 0 to 12 hours, default 30 s; 12 hours from the first receive in total | hard | message quotas, [visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html) |
| Delay (queue or message timer) | 0 to 15 minutes; timers not on FIFO | hard | message quotas, [delay queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-delay-queues.html) |
| Long poll wait | 20 s | hard | [queue quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-queues.html) |
| In-flight messages, standard | about 120,000 ("depending on queue traffic and message backlog"); adjustable | quota | queue quotas, reference |
| In-flight messages, FIFO | 120,000, "depends on active message groups"; contact Support | quota | visibility timeout page, reference |
| Standard throughput | "very high, nearly unlimited"; no number | | message quotas |
| FIFO throughput, normal mode | 300 transactions/s per API action per partition; 3,000 messages/s with batching | hard | message quotas |
| FIFO high-throughput, per region (non-batched calls/s) | us-east-1, us-west-2, eu-west-1: 70,000 · us-east-2, eu-central-1: 19,000 · ap-south-1, ap-southeast-1, ap-southeast-2, ap-northeast-1, eu-south-2 (Spain): 9,000 · eu-west-2, sa-east-1: 4,500 · every other region: 2,400. Batched is ten times these. | quota (account setting) | message quotas. The general reference says 18,000 for Ohio and Frankfurt and omits Spain: the developer guide is newer and is used. |
| FIFO partition | 3,000 messages/s batched or 300/s per action; a message group is on one partition | hard | [high-throughput FIFO](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/high-throughput-fifo.html) |
| FIFO deduplication window | 5 minutes, also after the message was deleted | hard | [deduplication](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/using-messagededuplicationid-property.html) |
| `maxReceiveCount` | 1 to 1,000; DLQ must be the same type, account and region | hard | [dead-letter queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-configure-dead-letter-queue.html) |
| DLQ redrive | custom velocity up to 500 messages/s; tasks run up to 36 hours; 100 active tasks per account; messages get a new id and enqueue time | hard | [redrive](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-configure-dead-letter-queue-redrive.html) |
| Lambda mapping: batch size | 10,000 standard, 10 FIFO; over 10 needs a window of at least 1 s | hard | [parameters](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-parameters.html), [configure](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html) |
| Lambda mapping: batching window | 0 to 300 s, standard only | hard | parameters |
| Lambda mapping: payload | 6 MB per invocation | hard | [Lambda limits](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html) |
| Lambda mapping: scaling | 5 at first, +300 concurrent invokes a minute, at most 1,250 | hard | [scaling](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-scaling.html) |
| Lambda mapping: maximum concurrency | 2 to 1,000; FIFO also capped by the number of message groups | hard | scaling |
| Lambda mapping: provisioned mode | 2 to 200 minimum pollers; maximum pollers 2 to 2,000 on the parameters and configure pages but 2 to 10,000 (100,000 invocations) on the [SQS](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html) and scaling pages: the 10,000 is used; 10 invocations per poller; +1,000 invocations a minute | hard | with-sqs, scaling |
| Visibility timeout advice | at least 6 x function timeout + batching window; maxReceiveCount at least 5 | advice | configure |

## Behaviour

**Messages.** Each record is an entry in one of four states: delayed, ready, in flight (hidden) or gone. The gauges are
counters kept on every transition, not scans. A call with `count` records makes that many entries sharing one sender
message; the call's `bytes` is split between them.

**Receive and visibility.** A poller's receive takes up to 10 messages, hides them under a new receipt and arms a timer for
the visibility timeout (read at receive time). A message knows its current receipt. When the timer fires, every message
still owned by that receipt returns (a standard queue: to the back; FIFO: to the head of its group, in its original order) or,
if the queue has a DLQ edge and the message has been received `maxReceives` times, moves to the DLQ. When the consumer
succeeds, the messages its receipt still owns are deleted; any that a later receive took over are not, and count as
`duplicates` (the work was done twice).

**Standard vs FIFO.** A standard queue hands out whatever is next. A FIFO queue keeps a list of groups that have messages
waiting and nothing in flight; a receive takes from the first group, then the next, until it has 10, and blocks every group it
took from until those messages are deleted or return. A message that keeps failing therefore blocks its group (head-of-line
blocking) and the queue's `groups.blocked` shows it. Only messages ahead of it in the same group wait; other groups proceed.

**FIFO throughput.** A send takes `ceil(count / 10)` tokens from a bucket of 300 (or the regional quota in high-throughput
mode) refilled per second, and fails with `Throttled` when empty. A receive takes one token per ReceiveMessage the same way,
and waits for a refill rather than failing. In high-throughput mode a message that names a group also takes tokens from that
group's own bucket of 300 calls/s. Messages moved internally (DLQ, redrive) bypass these limits, as they do in AWS.

**Deduplication.** With `deduplication` on, a FIFO send whose message id was accepted in the last 5 minutes is acknowledged and
dropped (`deduplicated`). The window starts at first acceptance. Memory is bounded by 5 minutes of traffic.

**Retention and depth.** Messages are filed by enqueue second. Retention sweeps once a second from the oldest second and
stops at the first still-young one; the oldest-age gauge reads the oldest second that holds a counted message. Neither
scans the queue, and a delete is O(1), so memory follows what is in the queue. Messages that leave a queue's line while
waiting (expiry) are tombstones skipped on read and cleared when they outnumber live ones, so a DLQ nobody reads does not
fill up with expired messages. FIFO groups are removed when their last message leaves. Oldest age is to the second.

**Dead-letter queue.** The move is made by the queue, not through the API: the DLQ does not count it as `sent`, it is not
throttled and not deduplicated. The message keeps its group; a standard destination counts retention from the original enqueue
time (the receiving queue's `retention` should be longer), FIFO restarts it. If the DLQ edge fails (an outage fault on the DLQ),
the message stays in flight and the move is tried again every second; nothing is lost.

**Redrive.** With `redrive` on and an edge on the `redrive` port, the queue receives its own messages in batches of up to 10
at the chosen velocity (credit builds with time, at most a quarter second of it), sends each to the destination as a new
message (new id, no carried enqueue time, receive count 0) and deletes it once the destination accepts it. A refused message
returns after the visibility timeout. A message that keeps failing in the source goes round again: that is the redrive loop.

**Event source mapping.** The mapping is the connector on a consumer edge (`EventSourceMapping.ts`), not part of the queue:
the queue offers ReceiveMessage on its `pull` port (`internal/pull.ts`: at most ten a receive, the in-flight limit, FIFO's receive
rate and groups, the visibility timer each receive starts) and says when something becomes receivable; the mapping takes.
Each mapping has pollers (no fibers). `pump` hands receivable messages to idle pollers when the queue says so. It invokes
synchronously and waits for the function however long it runs (the function's timeout ends a slow batch). With a batching window a poller holds what it has received (its visibility timers already
running) until the batch is full, 6 MB is reached or the window ends. If some of its messages lapse meanwhile they are dropped
from the batch. Once a second the mapping works out its target concurrency: while messages wait and no poller is idle,
`ramp += scaleUpPerMinute / 60`; otherwise `ramp` decays by 10% of its distance to the starting concurrency (at least 1) per second;
target = `min(ramp, cap)` where cap is the maximum concurrency or 1,250. Each failed batch multiplies `ramp` by 0.9 (not
below the start). On a throttle (`Throttled`) the poller keeps the batch and retries after `throttleRetry` until the
visibility timeout lapses; on any other failure it lets go and the messages come back after the timeout. FIFO uses the same
ramp (AWS publishes it for standard queues only), with concurrency in practice capped by the number of groups with work.

**Where the model departs from AWS.** `ChangeMessageVisibility` and short polling cannot be done (a consumer can only take
and acknowledge); everything a producer sends is accepted or refused atomically; a late delete with a stale receipt never
removes a message (AWS may, for a standard queue that has not been received again); in-flight messages are deleted at retention.

## Connections

- **In:** any component calls the queue with a message (producers, SNS, S3, Lambda); the queue also receives the internal
  moves of other queues.
- `deliver` (many, `pull`): consumers. Each edge carries a connector that takes from the queue: by default
  `aws.sqs.event-source-mapping` with the settings above, or `core.poller` (a fixed pool of workers) when the edge names it.
  A consumer is anything that handles a call with a batch (`count` records, `bytes` total, `attempt` = highest receive count,
  invocation `sync`); Lambda's `batchCalls` handles the fan-out. Failure types: `Throttled` is retried within the visibility
  timeout; every other failure leaves the messages hidden. The mapping's state (`concurrency`, `busy`) is the edge's probe
  (`Simulation.probeEdge`) and gauges of the same names in the edge's frames.
- `dlq` (one): the dead-letter queue; must be a queue of the same kind (not checked).
- `redrive` (one): where a redrive sends messages. Wiring a DLQ back to its source forms a loop (the engine's loop warning
  applies, and is correct).

CloudFormation import (`importers/internal/cloudformation/sqs.ts`):

| CloudFormation | Setting |
| --- | --- |
| `AWS::SQS::Queue` `FifoQueue` | `kind: fifo` |
| `VisibilityTimeout`, `MessageRetentionPeriod`, `DelaySeconds` (seconds) | `visibilityTimeout`, `retention`, `delay` |
| `RedrivePolicy` `maxReceiveCount` and `deadLetterTargetArn` | `maxReceives` and the `dlq` edge (a JSON string with `${Queue.Arn}` tokens is read too) |
| `FifoThroughputLimit: perMessageGroupId` with `DeduplicationScope: messageGroup` (FIFO only) | `highThroughput` |
| `ContentBasedDeduplication: true` (FIFO only) | `deduplication: true` (approximation: dedup by sender id) |
| `AWS::Lambda::EventSourceMapping` and SAM `SQS` events: `BatchSize`, `MaximumBatchingWindowInSeconds`, `ScalingConfig.MaximumConcurrency` | `batchSize`, `batchWindow`, `maxConcurrency` on the `deliver` edge |
| `ProvisionedPollerConfig.MinimumPollers` / `MaximumPollers` | `provisionedMinPollers` / `provisionedMaxPollers` on the same edge; values outside the component's ranges are clamped and listed in the report |
| `FunctionResponseTypes: [ReportBatchItemFailures]` | `reportBatchItemFailures: true` on the `deliver` edge, and `batch.errors: report` on the function |
| `FilterCriteria`, `TumblingWindowInSeconds` | not simulated: reported once per function (every record is delivered) |
| a disabled mapping (`Enabled: false`) | left out, quietly |
| `ReceiveMessageWaitTimeSeconds`, `MaximumMessageSize`, `KmsMasterKeyId`, `RedriveAllowPolicy` | not read: no effect on load |

An absent value keeps the component's default; a value only known at deploy time keeps the default and is listed under unresolved. A queue's `QueuePolicy` is skipped quietly. A queue nothing in the template sends to gets an assumed traffic source if something consumes it.

## Metrics and state

Counters (per second in frames), after the CloudWatch metric they stand in for. Everything counts messages, not calls:

| Name | CloudWatch | Meaning |
| --- | --- | --- |
| `sent` | NumberOfMessagesSent | Accepted from callers. Not DLQ moves or redrive. |
| `sentBytes` | SentMessageSize (Sum) | Bytes of those messages; over `sent`, the average SentMessageSize. |
| `received` | NumberOfMessagesReceived | Every message a receive returned, redeliveries included. |
| `deleted` | NumberOfMessagesDeleted | Deleted by the receive that owned them. |
| `deduplicated` | NumberOfDeduplicatedSentMessages | FIFO sends dropped as duplicates. |
| `emptyReceives` | NumberOfEmptyReceives | Estimate: idle pollers complete one empty 20 s long poll each. |
| `redelivered` | | Messages returned by a visibility timeout. |
| `duplicates` | | Deliveries whose messages a later receive had taken: work done twice. |
| `deadLettered`, `dlqFailed` | | Moved to the DLQ; moves the DLQ refused (retried). |
| `expired` | | Deleted by retention. |
| `redriven` | | Moved out by a redrive. |
| `throttled` | | FIFO sends refused. |

Failed deliveries are counted on the consumer edge, where they happen: its `fail` and `fail.<Tag>` (a throttled batch counts
each time it is tried).

Plus the framework's `in`, `ok`, `fail`, `fail.<Tag>`, `latency`, `inflight`. Gauges: `depth` (ApproximateNumberOfMessagesVisible),
`hidden` (NotVisible), `delayed`, `oldestAgeMs` (ApproximateAgeOfOldestMessage), `groupsInflight` (FIFO,
ApproximateNumberOfGroupsWithInflightMessages). Distribution: `sentMessageSize` (SentMessageSize in bytes, one sample per
send call: a batch's messages share a size).

The event source mapping's edge records, beside transport's `calls`, `ok`, `fail`, `fail.<Tag>`, `latency`: rates `polled`
(PolledEventCount: records the pollers received), `batches` (invocations, a throttled batch's retries included), `invoked`
(InvokedEventCount: records in those invocations), `failedInvoke` (FailedInvokeEventCount: records in invocations that
failed), `itemFailures`, `itemFailuresIgnored`; gauges `concurrency` (the concurrent batches it is running at), `busy`
(pollers holding or running a batch), `batchSize` (what a batch is gathered to). `core.poller` records `batches`, `records`,
`batchesFailed`, `recordsFailed` and gauges `workers`, `busy`, `batchSize`.

The node's dashboard (`internal/dashboard.ts`) charts these the way CloudWatch does; the mapping's charts follow transport's on its
edge. Not charted, because the simulator doesn't model them: the fair-queue metrics (`...InQuietGroups`,
ApproximateNumberOfNoisyGroups) and the mapping's DeletedEventCount (the queue's NumberOfMessagesDeleted counts deletes).

Probe state: `ready`, `hidden`, `delayed`, `oldestAge`, `totals` (running totals of the counters above plus `enqueued`, which
includes internal moves), `groups` (FIFO: `waiting`, `blocked` behind an in-flight message, `inflight`), `parked` (DLQ moves
being retried) and `sample` (the 20 oldest messages). Each consumer's mapping is probed on its edge.

## Not yet simulated

1. **Fair queues**: standard queues give priority to quiet message groups when one group has over 10% of in-flight messages
   and at least 30 in flight (or over 10% of processing time), until it is quiet for 5 minutes. Needs per-group in-flight accounting on standard queues.
2. **`ChangeMessageVisibility`** and heartbeats, **per-message timers**, **content-based deduplication**,
   **`DeduplicationScope: messageGroup`**: need fields on the message (delay, body hash) and a lease the taker can extend.
3. **Short polling and false empty receives**, `ReceiveMessageWaitTimeSeconds`, OverLimit errors.
4. **Redrive tasks** (completion, cancellation, 36 hour limit, redrive allow policy, redrive to source by default), and an
   action instead of an on/off setting.
5. **FIFO retroactive delay**, delete and ChangeMessageVisibility rate limits, partition splitting and hash placement of groups.
6. Event filtering, mapping scale-down to 2 pollers, provisioned poller throughput limits, FIFO ramp rules.
7. CloudWatch's one-minute reporting and approximation; `SentMessageSize`; metadata counted in the 6 MB payload.

## Assumptions

| Value | Why |
| --- | --- |
| `maxReceives` default 5 | Not an AWS default; the figure AWS recommends for Lambda consumers. |
| In-flight limit up to 10,000,000 | An upper bound for the setting, not a published maximum. |
| `deduplication` off by default | Existing designs, and components that re-send records of one batch under one id, would otherwise lose messages. |
| System-optimised redrive velocity 1,000/s | AWS says "the maximum" and gives no number. |
| Throttle retry 1 s; error back-off ×0.9 per failed batch, decay 10%/s | AWS says Lambda backs off and retries; no figures. |
| DLQ move retry 1 s | A real move cannot fail; this only matters under an injected fault. |
| Retention sweep, mapping re-evaluation once a second | AWS gives no cadence. |
| Empty receives: one per idle poller per 20 s | Derived from long polling and 5 pollers; AWS says Lambda may run as few as 2. |
| FIFO mapping uses the standard ramp | AWS publishes the ramp for standard queues only. |
| In-flight messages expire with retention | The docs say messages are deleted after the retention period; not stated for in-flight ones. |
| Per-group ceiling of 300 calls/s in high-throughput mode | Derived from the per-partition limit and "a group is on one partition". |
| A stale-receipt delete never removes the message | AWS's behaviour for standard queues is not clearly documented; this is the conservative reading. |
| FIFO send without a group id goes to group `default` | AWS rejects it; clients here have none unless configured. |

## References

All under `https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/` unless noted:
`quotas-messages.html`, `quotas-queues.html`, `high-throughput-fifo.html`, `FIFO-queues-exactly-once-processing.html`,
`FIFO-queues-understanding-logic.html`, `using-messagededuplicationid-property.html`, `sqs-visibility-timeout.html`,
`sqs-delay-queues.html`, `sqs-message-timers.html`, `sqs-short-and-long-polling.html`, `sqs-dead-letter-queues.html`,
`sqs-configure-dead-letter-queue.html`, `sqs-configure-dead-letter-queue-redrive.html`, `sqs-available-cloudwatch-metrics.html`,
`sqs-fair-queues.html`, `sqs-fair-queues-detailed.html`; `https://docs.aws.amazon.com/general/latest/gr/sqs-service.html`;
Lambda (`https://docs.aws.amazon.com/lambda/latest/dg/`): `with-sqs.html`, `services-sqs-configure.html`,
`services-sqs-scaling.html`, `services-sqs-parameters.html`, `services-sqs-errorhandling.html`, `gettingstarted-limits.html`.
Checked against the live pages in October 2026.
