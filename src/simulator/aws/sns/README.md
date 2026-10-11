# SNS (`aws.sns`)

Amazon SNS is publish/subscribe fan-out: a publisher hands a message to a topic, the topic acknowledges it, and SNS then delivers a copy to every subscription on its own, retrying failures, filtering per subscription and, if asked, parking what it cannot deliver in a dead-letter queue. A FIFO topic adds order within a message group and deduplication. The component lets you learn where a topic's publish quota bites (per region, per FIFO group, per FIFO topic), what a slow or dead subscriber does to its own backlog and to nobody else, how long a retry storm lasts, how much of a firehose a filter policy removes, and what ordering costs in throughput.

## Coverage

| Feature | Status | Notes |
| --- | --- | --- |
| **Publishing** | | |
| Publish acknowledged before delivery | ✅ | The publisher sees success after `publishLatency`; delivery runs afterwards, off the publisher's path. |
| Regional publish quota | ✅ | Token bucket per account and region, standard and FIFO apart, default from the region table, editable in the account quotas, live. Counts messages, so a `count` of 10 (a `PublishBatch`) costs 10. |
| Message size limit | ✅ | 256 KB default, 1 KB to 1 MiB by setting, over it is `Rejected`. Counts what the engine calls bytes (body plus attributes). Held at 256 KB while the topic has more than 100 subscriptions, as AWS only allows a larger limit with 100 or fewer. |
| `PublishBatch` (10 entries, shared size limit) | 🟡 | A batch is a message with `count` above 1 and is charged by count and checked by total bytes. The 10-entry cap is not enforced and a batch's partial failure is not represented. |
| Publish latency | 🟡 | A lognormal setting; AWS publishes no figure. |
| **FIFO** | | |
| Order within a message group | ✅ | One delivery at a time per group and subscription (`SerialLanes`); the next starts when the previous one is delivered or finally failed. Groups run side by side. |
| 300 messages/s per group | ✅ | Token bucket per group, forgotten when idle so the number of group ids does not grow memory. |
| Topic limit, 3,000 messages/s or 20 MB/s | ✅ | In the default `Topic` scope. `fifoThroughput: messageGroup` (high-throughput mode) removes it and leaves the group and regional limits. |
| Deduplication, 5-minute window | 🟡 | Setting `deduplication`. The key is the engine message id, which a retried publish reuses, so a publisher retry after a timeout is acknowledged and not delivered twice. Distinct publishes never collide and there is no content-based hashing. Off by default (see Assumptions). Scope (topic or group) cannot matter with this key. |
| Missing message group | 🟡 | AWS rejects the publish. Here the message joins one default group so a design still runs (and that group is limited to 300/s). |
| Subscribers limited to SQS | ❌ | The topic cannot tell what a subscriber is, so it does not refuse a FIFO subscription to Lambda or HTTP. |
| Message archiving and replay | ❌ | |
| **Delivery** | | |
| Each subscriber independent | ✅ | Own filter, retries, lanes, throttle and backlog. A stuck subscriber affects only its own deliveries, and on FIFO the messages of the same group behind the stuck one. |
| Asynchronous invocation of Lambda | ✅ | Deliveries are marked `async`; the subscriber accepts and works off its own queue. |
| Delivery retries | 🟡 | The edge's `retry` is the delivery policy: exponential backoff with jitter, capped at 100 attempts. AWS retries SQS and Lambda for 23 days (100,015 attempts); this model gives up after about a quarter of an hour. The 3 immediate and 2 one-second phases, and the arithmetic, geometric and linear backoff functions are not separate. |
| HTTP/S custom delivery policy | 🟡 | `numRetries + 1` is `retry.maxAttempts`, `minDelayTarget` is `retry.backoff`, `maxDelayTarget` is `retry.maxBackoff`; `maxReceivesPerSecond` is the subscription's throttle. Exponential only. |
| Client errors are not retried | ✅ | `Rejected` from a subscriber is final at once; 5xx, 429, timeouts and refusals to connect are retried. |
| Subscription dead-letter queue | ✅ | `deadLetterQueue` on the subscription plus the `dlq` port. Messages whose delivery has finally failed (retries used up, or a client error) go there. The DLQ is per topic here, not per subscription. |
| Delivery throttle (`maxReceivesPerSecond`) | ✅ | Spaces first attempts to an average rate. Held messages are not retries and do not fail. |
| Delivery latency | 🟡 | `deliveryLatency`, default 0; AWS publishes no figure. |
| Filter policies | 🟡 | A rate (`filterMatch`) per subscription, because simulated messages carry no attributes or body. Attribute and payload scope, operators, and the up-to-15-minute propagation of a policy change are not simulated. Filtered messages never enter a FIFO lane. |
| Raw message delivery | 🟡 | Off adds about 1 KB of envelope to the delivered size (an assumption). Nothing else about the format is represented. |
| Retention while retrying | 🟡 | A message is held for as long as its retries run and counted as pending. Pending deliveries per subscription are capped (`maxPendingPerSubscription`); beyond it a delivery is dropped and counted as `overflow` and `undelivered`. AWS has no such limit, so this is the simulator's bound. |
| **Protocols** | | |
| SQS, Lambda, HTTP/S | ✅ | Whatever the subscriber component is: a queue, a function, an endpoint. |
| Firehose, email, SMS, mobile push | ❌ | No component. A subscriber that is a customer-managed endpoint (SMTP, SMS, push: 50 attempts over 6 hours) is not modelled. |
| **Throttling and quotas** | | |
| Topics per account | ✅ | Audited against the account quotas (100,000 standard, 1,000 FIFO). |
| Subscriptions per topic | ❌ | 12,500,000 standard and 100 FIFO are not enforced. |
| Subscribe, create and other API rates | ❌ | Only publish is a request in the simulation. |
| Partition scale-up throttling of FIFO topics after a sudden increase | ❌ | |
| **Metrics** | | See Metrics and state. |
| **Live edits** | ✅ | Every setting and quota is read on the next publish; edge settings on the next delivery. |

## Settings

Topic settings:

| Setting | Default | Range | Kind | What it models |
| --- | --- | --- | --- | --- |
| `kind` | `standard` | `standard`, `fifo` | | Topic type. |
| `maxMessageSize` | 256 KB | 1 to 1,024 KB | hard | `MaximumMessageSize`. Effective value is 256 while there are more than 100 subscriptions. |
| `publishLatency` | mean 5 ms, cv 0.3 | 0 to 10 min | assumed | Time to acknowledge a publish. |
| `deliveryLatency` | mean 0, cv 0.3 | 0 to 10 min | assumed | Time from acceptance to a delivery starting. On FIFO it is paid inside the group's lane. |
| `fifoThroughput` | `topic` | `topic`, `messageGroup` | hard rule | `FifoThroughputScope`. |
| `deduplication` | off | on/off | assumed default | Drop publishes whose id was accepted in the last 5 minutes (FIFO). |
| `maxPendingPerSubscription` | 100,000 | 1 to 10,000,000 | assumed | Bound on what a subscription may hold; the rest is `overflow`. |

Account quotas (Region box): `snsPublishRate`, `snsFifoPublishRate` (messages/s, regional defaults below), `snsStandardTopics` (100,000), `snsFifoTopics` (1,000).

Subscription (edge from `out`) settings, besides the universal edge policy (latency, timeout, weight):

| Setting | Default | Range | What it models |
| --- | --- | --- | --- |
| `filterMatch` | 100% | 0 to 100% | Share of messages the filter policy lets through. |
| `rawMessageDelivery` | on | on/off | Off adds the JSON envelope (about 1 KB) to what the subscriber receives. AWS's own default is off. |
| `deadLetterQueue` | off | on/off | Redrive failed deliveries to the `dlq` port. |
| `maxReceivesPerSecond` | 0 (none) | 0 to 10,000,000 | Throttle policy of an HTTP/S delivery policy. |
| `retry` | 100 attempts, 1 s, ×2, cap 20 s, jitter | edge ranges | Delivery policy; see Behaviour. |

## Limits

| Limit | Value | Kind | Source |
| --- | --- | --- | --- |
| Publish rate, per account per Region, standard | us-east-1 30,000/s; us-west-2 and eu-west-1 9,000/s; us-east-2, us-west-1, ap-south-1, ap-northeast-1, ap-northeast-2, ap-southeast-1, ap-southeast-2, eu-central-1 1,500/s; every other Region 300/s | quota | https://docs.aws.amazon.com/general/latest/gr/sns.html |
| Publish rate, per account per Region, FIFO | us-east-1 30,000/s; us-west-2 and eu-west-1 9,000/s; every other Region 3,000/s | quota | same |
| Message size | 256 KiB; 1,024 to 1,048,576 bytes by setting; counts body and attributes | hard | https://docs.aws.amazon.com/sns/latest/dg/large-message-payloads.html |
| Above 256 KiB | at most 100 subscriptions, only Firehose, SQS and Lambda | hard | same |
| FIFO per message group | 300 messages/s | hard | https://docs.aws.amazon.com/sns/latest/dg/fifo-message-grouping.html |
| FIFO per topic (Topic scope) | 3,000 messages/s or 20 MB/s, whichever first | hard (change scope to lift) | https://docs.aws.amazon.com/general/latest/gr/sns.html, https://docs.aws.amazon.com/sns/latest/dg/fifo-high-throughput.html |
| FIFO deduplication | 5 minutes | hard | https://docs.aws.amazon.com/sns/latest/dg/fifo-message-dedup.html |
| FIFO delivery targets | SQS standard and FIFO queues only | hard | https://docs.aws.amazon.com/sns/latest/dg/fifo-message-delivery.html |
| Topics per account | 100,000 standard, 1,000 FIFO | quota | https://docs.aws.amazon.com/general/latest/gr/sns.html |
| Subscriptions per topic | 12,500,000 standard, 100 FIFO (Firehose: 5 per topic per owner) | quota | same |
| `PublishBatch` | 10 entries; combined size within `MaximumMessageSize` | hard | https://docs.aws.amazon.com/sns/latest/api/API_PublishBatch.html |
| Delivery retries, SQS and Lambda | 3 immediate, 2 at 1 s, 10 backing off 1 to 20 s, then 100,000 at 20 s: 100,015 attempts over 23 days, jittered; not changeable | hard | https://docs.aws.amazon.com/sns/latest/dg/sns-message-delivery-retries.html |
| Delivery retries, SMTP, SMS, mobile push | 50 attempts over 6 hours | hard (not modelled) | same |
| HTTP/S delivery policy | `numRetries` 0 to 100, delays 1 to 3,600 s, total retry time at most 3,600 s, backoff arithmetic, exponential, geometric or linear, `maxReceivesPerSecond` 1 or more; default 3 retries 20 s apart | hard bounds, editable policy | same, and https://docs.aws.amazon.com/sns/latest/dg/SendMessageToHttp.prepare.html |
| HTTP/S response wait | about 15 s | hard (not enforced: set the edge `timeout`) | https://docs.aws.amazon.com/sns/latest/dg/SendMessageToHttp.prepare.html |
| Retryable HTTP/S results | 5xx and 429; other errors are permanent | hard | https://docs.aws.amazon.com/sns/latest/dg/sns-message-delivery-retries.html |
| Subscription dead-letter queue | an SQS queue in the same account and Region; a FIFO topic needs a FIFO queue | hard | https://docs.aws.amazon.com/sns/latest/dg/sns-dead-letter-queues.html |

Where AWS's pages are unclear: the quotas page says the publish quota counts "both standard and FIFO topic types" yet gives separate columns; the simulator keeps two buckets. The FIFO topic limit is written "20MB"; read as MiB.

## Behaviour

**Publish.** In order: the size check (`Rejected`, a 4xx, not retried); then the limits, most specific first so a publish refused by its group does not spend the topic's or the region's allowance: the message group's 300/s, then in `Topic` scope the topic's 3,000/s and 20 MiB/s (FIFO), then the regional account quota (standard or FIFO). Any of them refuses with `Throttled`, which a publisher's retry policy will retry. An accepted publish waits `publishLatency` and succeeds; at that moment the topic deduplicates (if on) and hands the message to the subscriptions. The publisher never waits for delivery.

**Fan-out.** For every subscription, independently: the filter decides first (`filterMatch`; filtered messages are counted and vanish); then the pending cap (over it the delivery is dropped as `overflow`); then the delivery is admitted. On a FIFO topic it joins the lane of its message group for that subscription; on a standard topic it starts at once. A delivery waits `deliveryLatency`, then its turn in the subscription's throttle (`maxReceivesPerSecond`), then calls the subscriber through the edge with `invocation: async`. The edge applies its own latency, timeout and retry policy. The answer is final: success counts `delivered`; failure counts `undelivered` and, if the subscription has `deadLetterQueue`, the message goes to whatever is wired to the `dlq` port (`redriven`, or `redriveFailed` if nothing is wired or that call fails). The lane is then released and the group's next message starts. A subscriber that is down therefore blocks a FIFO group's messages to that subscriber for the length of its retries, and never anything for another subscriber.

**Retry formula.** With `retry` of `maxAttempts` N, backoff b, factor f, cap m, jitter on: the wait before attempt k+1 is `U(0,1) × min(b × f^(k−1), m)`; the default is 1 s doubling to 20 s, so about 15 to 30 minutes in all before a message is given up. To express an HTTP/S delivery policy set `maxAttempts = numRetries + 1`, `backoff = minDelayTarget`, `maxBackoff = maxDelayTarget`. AWS's default HTTP/S policy (3 retries, 20 s apart) is `maxAttempts: 4, backoff: 20 s, backoffFactor: 1, jitter: off`. Departures from AWS: the retry horizon (100 attempts is the engine's limit, AWS's is 23 days for SQS and Lambda), the immediate phase, and the backoff function.

**Stuck subscriber and memory.** A delivery is remembered from admission to its final answer. Each subscription may hold `maxPendingPerSubscription` (default 100,000); past that, new deliveries to it are dropped, counted as `overflow` (and as `undelivered`) and not redriven, so memory is bounded however long a subscriber stays down. Lanes exist only while a group has work, group publish buckets only while they are not full, and deduplication ids only for the window and at most 500,000.

**Throttle.** `maxReceivesPerSecond` spaces first attempts `1/rate` apart (per message counted by `count`); it is an average, not a hard cap, as in AWS. Retries are not paced.

**Size.** `message.bytes` is compared with the limit at publish. With raw message delivery off the subscriber receives `bytes + 1,024`.

## Connections

Called by anything (a client, a Lambda function, an API Gateway integration, an S3 event destination). Calls its subscribers through ports:

- `out` (Subscribers, many): one edge per subscription, to an SQS queue, Lambda function, HTTP endpoint or another topic. Edge settings: the universal policy (`weight` is unused; `latency`, `timeout`, `cancelOnTimeout`), plus `filterMatch`, `rawMessageDelivery`, `deadLetterQueue`, `maxReceivesPerSecond` and `retry` (above). A queue subscriber receives the message group on a FIFO topic.
- `dlq` (Dead-letter queue, one): an SQS queue that receives deliveries that finally failed, for subscriptions with `deadLetterQueue` on.

CloudFormation import (`importers/cloudformation/sns.ts`): `AWS::SNS::Topic` `FifoTopic: true` becomes `kind: fifo`; on a FIFO topic `FifoThroughputScope: MessageGroup` becomes `fifoThroughput: messageGroup` and `ContentBasedDeduplication: true` becomes `deduplication: true` (a standard topic's FIFO-only properties are ignored); `MaximumMessageSize` (bytes) becomes `maxMessageSize` in KB, rounded up. A subscription (`AWS::SNS::Subscription`, the topic's inline `Subscription` list, or the SAM `SNS` event) becomes an edge from `out`; `email`, `email-json`, `sms`, `application` and `firehose` subscriptions have no component and are reported as skipped, and an `http`/`https` endpoint not in the template becomes an external endpoint named by its host. Edge settings:

- `RawMessageDelivery` becomes `rawMessageDelivery`; **absent imports as `false`** (AWS's own default is the JSON envelope, and a function always gets the envelope), although the component's own default is `true`.
- For `http`/`https` only, `DeliveryPolicy.healthyRetryPolicy` becomes `retry`: `numRetries` plus one is `maxAttempts`, `minDelayTarget` is `backoff`, `maxDelayTarget` is `maxBackoff`; `throttlePolicy.maxReceivesPerSecond` becomes `maxReceivesPerSecond`. **With no delivery policy (or no value in it) AWS's defaults are assumed: 4 attempts, 20 s apart** (3 retries). A `backoffFunction` other than `exponential` or `geometric` is reported as not simulated. A `DeliveryPolicy` on any other protocol is ignored and reported. Values outside the component's ranges are clamped, and the report lists each adjustment.
- `RedrivePolicy.deadLetterTargetArn` becomes `deadLetterQueue: true` plus an edge from the topic's `dlq` port to that queue. The topic has one `dlq` port: a second subscription naming a different queue is reported and gets no redrive, and a queue outside the template is reported.
- `FilterPolicy` is **reported as not simulated**: messages carry no attributes, so `filterMatch` is left at its default (set it to the share you expect to pass).

## Metrics and state

Counters (rates per second, in frames), each next to the CloudWatch metric it corresponds to:

| Name | Meaning | CloudWatch |
| --- | --- | --- |
| `published` | messages accepted | `NumberOfMessagesPublished` |
| `publishSize` (distribution, bytes) | size of each accepted publish | `PublishSize` |
| `delivered` | deliveries the subscriber accepted | `NumberOfNotificationsDelivered` |
| `undelivered` | deliveries finally given up (once per message, not per attempt; includes `overflow`) | `NumberOfNotificationsFailed` (SQS-style: AWS counts every attempt for HTTP/S; the edge's own `fail` counter has per-attempt counts) |
| `filteredOut` | messages a filter policy removed | `NumberOfNotificationsFilteredOut` |
| `redriven`, `redriveFailed` | messages moved to, or that could not reach, the dead-letter queue | `NumberOfNotificationsRedrivenToDlq`, `...FailedToRedriveToDlq` |
| `duplicates` | FIFO publishes accepted and dropped as duplicates | none |
| `overflow` | deliveries dropped because a subscription's pending cap was full | none (simulator bound) |
| `fail.Throttled`, `fail.Rejected` | publishes refused for rate, for size | `Publish` API errors |

Gauges: `pending` (deliveries admitted and not finished, across subscriptions), `openGroups` (FIFO lanes with work, summed over subscriptions). The standard `in`, `ok`, `fail`, `latency` and `inflight` are the publish path.

Probe state: `published`, `subscribers`, `pending`, `throttled`, `delivered`, `undelivered`, `filteredOut`, `duplicates`, `overflow`, `redriven`, `redriveFailed`, `openGroups` (all totals since the start), `maxMessageSize` (the limit in force, KB) and `backlog` (pending per subscriber).

## Not yet simulated

1. A 23-day retry horizon and the real phased schedule (3 immediate, 2 at 1 s, 10 exponential, then every 20 s) and the four backoff functions. Needs the engine's edge retry to allow more than 100 attempts and a phase schedule; the pending cap would then matter more.
2. Filter policies as rules. The engine's message has no attributes or body, so attribute and payload filtering, `FilterPolicyScope`, and the propagation delay of a policy change can only be a rate.
3. Subscriptions as first-class: a dead-letter queue per subscription (AWS), enforcement of FIFO-to-SQS only, and subscription limits. The topic cannot see the type of what it is wired to, and an audit sees nodes, not edges.
4. Firehose, email, SMS and mobile push subscribers, and their retry policy (50 attempts over 6 hours, 10 per second for email).
5. FIFO partition scale-up: throttling for as long as the deduplication window after traffic jumps several times its usual volume.
6. Content-based deduplication on message bodies; archiving and replay.
7. The 10-entry `PublishBatch` limit and partial batch failure; API throttling of Subscribe and the other control-plane calls.
8. HTTP/S: the 15-second response wait is a plain edge `timeout` (default 30 s), content type, and subscription confirmation.
9. Cross-region delivery latency for FIFO groups beyond what the edge latency already adds.

## Assumptions

| Number | Value | Why |
| --- | --- | --- |
| `publishLatency` | mean 5 ms, cv 0.3 | AWS publishes no figure. |
| `deliveryLatency` | mean 0, cv 0.3 | No figure; 0 so deliveries start with the publish. |
| Retry default | 100 attempts, 1 s, ×2, cap 20 s, jitter | The engine's maximum, shaped like AWS's backoff phase; the exact schedule cannot be expressed. |
| Envelope size | 1,024 bytes | Counted from the example notification in the developer guide (signature, certificate and unsubscribe URLs). |
| `maxPendingPerSubscription` | 100,000 | A memory bound; AWS holds messages for up to 23 days. About 50 MB per stuck subscription. |
| Deduplication off, capacity 500,000 ids | | Real FIFO topics always deduplicate; the simulator keeps up to 900,000 ids at 3,000/s over 5 minutes otherwise. |
| 20 MB read as 20 MiB | | The page does not say which. |
| Missing FIFO group is the default group | | AWS rejects the publish; running the design is more useful. |

## References

- https://docs.aws.amazon.com/general/latest/gr/sns.html
- https://docs.aws.amazon.com/sns/latest/dg/sns-message-delivery-retries.html
- https://docs.aws.amazon.com/sns/latest/dg/sns-dead-letter-queues.html
- https://docs.aws.amazon.com/sns/latest/dg/SendMessageToHttp.prepare.html
- https://docs.aws.amazon.com/sns/latest/dg/fifo-message-delivery.html
- https://docs.aws.amazon.com/sns/latest/dg/fifo-message-grouping.html
- https://docs.aws.amazon.com/sns/latest/dg/fifo-message-dedup.html
- https://docs.aws.amazon.com/sns/latest/dg/fifo-high-throughput.html
- https://docs.aws.amazon.com/sns/latest/dg/large-message-payloads.html
- https://docs.aws.amazon.com/sns/latest/api/API_PublishBatch.html
- https://docs.aws.amazon.com/sns/latest/dg/sns-message-filtering.html
- https://docs.aws.amazon.com/sns/latest/dg/sns-subscription-filter-policies.html
- https://docs.aws.amazon.com/sns/latest/dg/sns-large-payload-raw-message-delivery.html
- https://docs.aws.amazon.com/sns/latest/dg/sns-monitoring-using-cloudwatch.html
- https://docs.aws.amazon.com/sns/latest/dg/sns-firehose-as-subscriber.html
