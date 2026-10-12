# EventBridge event bus (`aws.eventbridge`)

Amazon EventBridge routes events between producers and consumers that don't know each other. A producer puts events on a
bus (`PutEvents`) and is answered as soon as they are accepted; each rule whose event pattern matches an event invokes
the rule's targets (up to five) asynchronously, retrying a target that fails or throttles with exponential backoff for up
to a day, then sending the event to the target's dead-letter queue or dropping it. The component lets you learn where the
regional `PutEvents` quota throttles producers, how the regional invocation quota *delays* rather than refuses deliveries
(and how a delay can outlive an event's maximum age), what a failing target does to its own backlog and to nobody else,
how long retries go on and where events end up, and what an API destination's rate limit and 5-second timeout do.

This is the *Custom Event Bus - Classic* (rules and targets). AWS's newer Custom Event Bus (subscribers, `[EventsV2]`
quotas, a default retry policy of 5 attempts and 300 s) is not modelled. The Scheduler is its own component, in
[`../scheduler`](../scheduler/README.md); it shares this folder's delivery machinery (`delivery.ts`).

## Coverage

| Feature | Status | Notes |
| --- | --- | --- |
| **Ingestion** | | |
| `PutEvents` acknowledged before delivery | ✅ | The producer is answered after `putLatency`; matching and delivery run afterwards, off its path. |
| Regional `PutEvents` quota | ✅ | Token bucket per account and region, shared by every bus there, default from the region table, editable in the account quotas, live. Counts requests, as AWS's quota does. Over it the request fails `Throttled`. |
| 10 entries per request | ✅ | A call carrying more entries (`count` above 10, a batch from a function) is counted as the requests an SDK would split it into. |
| 1 MB per request | ✅ | An entry larger than 1,048,576 bytes is `Rejected`; entries are packed into requests under the limit. |
| Partial batch failure (`FailedEntryCount`) | ❌ | A request is accepted or refused whole. |
| Each entry is an event | ✅ | A call with `count` n becomes n events, each matched and delivered on its own. |
| **Rules** | | |
| Event patterns | 🟡 | A rate per rule (`match`), because simulated events carry no fields. |
| Targets of one rule see the same events | ✅ | One draw per rule and event; every target of the rule compares it with its own rate. |
| 5 targets per rule | ✅ | Targets wired to a rule past the fifth are left out (the probe lists them as `ignored`). |
| Rules per bus quota | ✅ | Rules past the account's `eventBridgeRulesPerBus` (300, or 100 in two regions) are left out. |
| Input transformers, input paths | ❌ | The target receives the event as put. |
| Infinite-loop detection (`DeadLetterInvocations`) | ❌ | A rule whose target puts events back on the bus loops as wired. |
| **Delivery** | | |
| Asynchronous invocation | ✅ | Every delivery is `async`: a Lambda target gets an `Event` invocation and queues it. |
| Delivery latency | 🟡 | `deliveryLatency`, lognormal with mean 40 ms, P99 about 125 ms, after AWS's published P99 of 129 ms (2024). |
| Regional invocation quota | ✅ | One pacer per account and region, shared by every bus there: invocations past the rate wait their turn (FIFO) instead of failing. The burst is one second's worth (an assumption). The wait counts against the event's maximum age. |
| API destinations | ✅ | `apiDestination.enabled`: each request is given 5 seconds (then it is a timeout, retried), and invocations are held to the destination's `rate` (default 300/s), delayed not refused. |
| `Retry-After` from API destinations | ❌ | |
| **Retries and dead letters** | | |
| Retry policy | ✅ | Per target: `maxRetries` (0 to 185, default 185) and `maxEventAge` (60 s to 24 h, default 24 h), whichever comes first. |
| Exponential backoff with jitter | 🟡 | Full jitter, doubling from `retryBackoff.initial` (1 s) to `retryBackoff.max` (16 min). AWS publishes no delays; these make the default 185 retries take about a day, as AWS describes. |
| Errors that are not retried | ✅ | `Rejected` (a missing resource, no permission, a 4xx) is final at once. Throttles, 5xx, timeouts and refused connections are retried. |
| Dead-letter queue | ✅ | `deadLetterQueue` on the target plus the bus's `dlq` port: what is finally given up goes there (`deadLettered`), or is dropped. AWS's DLQ is per target; here there is one per bus. |
| Events held while retrying | 🟡 | Bounded by `maxPendingPerTarget` (an assumption); past it new deliveries to that target are dropped as `overflow`. |
| **Not modelled** | | |
| Archive and replay | ❌ | |
| Cross-account and cross-region buses, global endpoints | ❌ | A bus targeting another bus in the same design works as any target. |
| EventBridge Pipes | ❌ | |
| Schema registry, partner event sources | ❌ | |
| The newer Custom Event Bus (`[EventsV2]`) | ❌ | Subscribers, per-event-group throughput, deduplication window. |
| **Throttling and quotas** | | |
| Event buses per account | ✅ | Audited against the account quotas (100). |
| Event pattern size, control-plane API rates | ❌ | Only `PutEvents` and invocations are requests in the simulation. |
| **Live edits** | ✅ | Bus settings and quotas apply on the next request; edge settings (rule, match, policy) on the next event. |

## Settings

Bus settings:

| Setting | Default | Range | Kind | What it models |
| --- | --- | --- | --- | --- |
| `putLatency` | mean 10 ms, cv 0.3 | 0 to 10 min | assumed | Time to answer a `PutEvents` request. |
| `deliveryLatency` | mean 40 ms, cv 0.6 | 0 to 10 min | assumed shape | Ingestion to the first invocation attempt (`IngestionToInvocationStartLatency`). |
| `retryBackoff.initial` | 1 s | 0 to 1 h | assumed | Ceiling of the first retry's wait; each wait is drawn uniformly below its ceiling. |
| `retryBackoff.max` | 16 min | 0 to 24 h | assumed | The ceiling doubles after each retry up to this. |
| `maxPendingPerTarget` | 100,000 | 1 to 10,000,000 | assumed | What a target may hold (delayed or retrying) before new deliveries are dropped as `overflow`. |

Rule target (edge from `out`) settings, besides the universal edge policy:

| Setting | Default | Range | Kind | What it models |
| --- | --- | --- | --- | --- |
| `rule` | empty | text | | The rule's name. Edges naming the same rule are its targets; an empty name makes the edge a rule of its own. |
| `match` | 100% | 0 to 100% | | Share of events the rule's pattern matches. |
| `retryPolicy.maxRetries` | 185 | 0 to 185 | hard | `MaximumRetryAttempts`. |
| `retryPolicy.maxEventAge` | 24 h | 60 s to 24 h | hard | `MaximumEventAgeInSeconds`, from acceptance. |
| `deadLetterQueue` | off | on/off | | The target has a dead-letter queue (the bus's `dlq` port). |
| `apiDestination.enabled` | off | on/off | | The target is an API destination: 5 s per request, and a rate limit. |
| `apiDestination.rate` | 300/s | 1 to 1,000,000 | quota | `InvocationRateLimitPerSecond`; AWS's account default is 300 per destination. |

Leave the edge's own `retry` at 1 attempt: EventBridge's retry policy is the target's `retryPolicy`, and edge retries would
multiply it. The edge `timeout` (30 s by default) is how long one attempt may take; an API destination uses 5 s instead.

Account quotas (Region box): `eventBridgePutEventsRate`, `eventBridgeInvocationRate`, `eventBridgeRulesPerBus`, `eventBridgeBuses`.

## Limits

| Limit | Value | Kind | Source |
| --- | --- | --- | --- |
| `PutEvents` requests per second, per account and Region | us-east-1, us-west-2, eu-west-1 10,000; us-east-2, eu-central-1, eu-south-2 2,400; us-west-1, ap-northeast-1, ap-southeast-1, ap-southeast-2, eu-west-2 1,200; ap-east-1, ap-northeast-2, ap-south-1, ca-central-1, eu-north-1, eu-west-3, sa-east-1 600; every other Region 400 | quota | https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-quota.html (and https://docs.aws.amazon.com/general/latest/gr/ev.html, which agrees) |
| Invocations per second, per account and Region | us-east-1, us-west-2, eu-west-1 18,750; us-east-2, eu-central-1, eu-south-2 4,500; us-west-1, ap-northeast-1, ap-southeast-1, ap-southeast-2, eu-west-2 2,250; ap-east-1, ap-northeast-2, ap-south-1, ca-central-1, eu-north-1, eu-west-3, sa-east-1 1,100; every other Region 750. "After the limit is reached, the invocations are throttled; that is, they still happen but they are delayed." | quota | same |
| Rules per bus | 300; af-south-1 and eu-south-1 100 | quota | same |
| Targets per rule | 5 | hard | same, and https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-targets.html |
| Event buses per account and Region | 100 | quota | same |
| Entries per `PutEvents` request | 1 to 10 | hard | https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_PutEvents.html |
| `PutEvents` request size | under 1 MB (1,048,576 bytes) for all entries together; one entry may use it all | hard | https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-putevents.html#eb-putevent-size |
| Retry policy defaults | 24 hours and 185 retries, exponential backoff and jitter; then the DLQ or dropped | hard | https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rule-retry-policy.html |
| Retry policy ranges | `MaximumRetryAttempts` 0 to 185; `MaximumEventAgeInSeconds` 60 to 86,400 | hard | https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_RetryPolicy.html |
| Errors not retried | missing permissions, a target that no longer exists or cannot be found: straight to the DLQ | hard | https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rule-dlq.html |
| Dead-letter queue | a standard SQS queue (not FIFO) in the same Region | hard | same |
| Lambda and Step Functions targets | invoked asynchronously | hard | https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-targets.html |
| API destination request | 5 seconds, then retried; retried on 401, 407, 409, 429, 5xx; not on other 4xx | hard | https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-api-destinations.html |
| API destination invocation rate | 300 per second per destination, adjustable; excess delayed | quota | https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-quota.html, https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_CreateApiDestination.html |
| Delivery latency | P99 129 ms from ingestion to first invocation attempt (measured August 2024) | published figure | https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-eventbridge-improvement-latency-event-buses |

Where AWS's pages are unclear: the `PutEvents` quota is described as "requests per second", and the simulator counts
requests (a request of 10 entries uses one token); AWS doesn't say whether entries count separately. The invocation
quota's utilisation metric is `InvocationsCreated`, one per target per event, so retries are not counted against it here.

## Behaviour

**PutEvents.** A call stands for `count` entries of `bytes / count` each. An entry over 1 MB is `Rejected` (4xx, not
retried). Otherwise the entries are packed into `ceil(count / min(10, floor(1 MiB / entry)))` requests, which take that
many tokens from the region's bucket (`eventBridgePutEventsRate`, burst one second's worth); if there aren't enough the
call fails `Throttled` and the producer's own retry policy decides what happens. An accepted call waits `putLatency` and
succeeds. At that moment each entry becomes an event.

**Matching.** For each active rule, in wiring order, one uniform draw `u` per event; each of the rule's targets (the
first five) matches when `u < match`. A target that matches gets an invocation. An event no rule matches counts as
`unmatched`.

**Invocation.** Each invocation takes a token from the regional invocation pacer (`eventBridgeInvocationRate`), and from
the target's own pacer when it is an API destination. Pacers go into debt rather than refuse: an invocation that finds
no token waits `(1 − tokens) / rate` seconds, so invocations leave at exactly the rate, in order, and the wait grows as
long as more are created than the rate allows (the `quotaWait` gauge). After the wait and `deliveryLatency` the target
is called (`async`). An invocation whose wait is longer than its maximum event age is never attempted: it is held until
its age runs out, then given up (`expired`).

**Retries.** A failure other than `Rejected` is retried while retries remain: the wait before retry k (from 0) is
`U(0, min(max, initial × 2^k))`. If that wait would end past the event's maximum age, the event is held until its age
runs out and given up then. With the defaults (1 s doubling to 16 min, full jitter) the expected total over 185 retries is
`511.5 s + 175 × 480 s ≈ 23.5 h`. A given-up event goes to the dead-letter queue if the target has one (`deadLettered`,
or `deadLetterFailed` if the `dlq` port is not wired or the queue refuses it), otherwise it is `dropped`.

**A stuck target** holds only its own deliveries. Each target may hold `maxPendingPerTarget`; past it new deliveries to it
are dropped (`overflow`, also counted `failed` and `dropped`), so memory is bounded however long it stays down.

## Connections

Called by anything that publishes: a client, a Lambda function, an S3 or SES event destination, a Scheduler schedule,
another bus. Calls its targets through ports:

- `out` (Rule targets, many): one edge per target. Edge settings: `rule`, `match`, `retryPolicy`, `deadLetterQueue`,
  `apiDestination`, plus the universal `latency`, `timeout` (one attempt) and `cancelOnTimeout`. Any component can be a
  target: an SQS queue, a Lambda function, an SNS topic, a Step Functions state machine, another bus, an HTTP endpoint.
- `dlq` (Dead-letter queue, one): an SQS queue for targets with `deadLetterQueue` on.

CloudFormation import: not mapped yet. `importers/cloudformation/events.ts` turns a scheduled `AWS::Events::Rule` into a
client; event-pattern rules are reported as skipped.

## Metrics and state

Counters (rates per second in frames, totals in the probe), with the CloudWatch metric each stands for:

| Name | Meaning | CloudWatch |
| --- | --- | --- |
| `requests` | `PutEvents` requests accepted | `PutEventsApproximateSuccessCount` |
| `entries` | entries accepted | `PutEventsEntriesCount` |
| `putThrottled` | requests refused by the quota (also `fail.Throttled`, per call) | `PutEventsApproximateThrottledCount` |
| `rejected` | entries refused for size (also `fail.Rejected`) | `PutEventsFailedEntriesCount` |
| `matched`, `unmatched` | events that matched at least one rule, or none | `MatchedEvents` |
| `invocations` | invocations created, one per matched target per event | `InvocationsCreated` |
| `attempts` | every attempt, first and retries | `InvocationAttempts` |
| `delivered` | invocations a target accepted | `SuccessfulInvocationAttempts` |
| `retries` | retry attempts | `RetryInvocationAttempts` |
| `failed` | invocations given up (retries or age used up, an error not retried, overflow) | `FailedInvocations` |
| `expired` | of those, given up because of their age | (`EXHAUSTED_RETRY_CONDITION` = `MaximumEventAgeInSeconds`) |
| `deadLettered`, `deadLetterFailed` | given up and moved to the DLQ, or not | `InvocationsSentToDlq`, `InvocationsFailedToBeSentToDlq` |
| `dropped` | given up with no DLQ: lost | none |
| `delayed` | invocations that had to wait for a rate limit | `ThrottledRules` |
| `overflow` | dropped because the target's pending bound was full | none (simulator bound) |
| `targetErrors`, `targetThrottled` | attempts a target answered with an error, and of those the throttled ones (rates only: most are retried) | none for a bus (Scheduler's TargetErrorCount, TargetErrorThrottledCount) |

Distributions: `requestSize` (bytes per request, `PutEventsRequestSize`), `startLatency` (creation to first attempt,
`IngestiontoInvocationStartLatency`), `successLatency` (creation to success, `IngestionToInvocationSuccessLatency`).
Gauges: `pending` (invocations not finished), `quotaWait` (ms a new invocation would wait for the regional quota).

Probe state: the counters above as totals (not `targetErrors`, `targetThrottled`), `pending`, `quotaWait`, `rules` (each
rule's name, whether it is active, its targets and the targets left out) and `backlog` (pending per target).

The node's dashboard (`dashboard.ts`) charts these under CloudWatch's names; `Invocations` is drawn as invocations that
ended (`delivered` + `failed`). Not charted, because not modelled: DeadLetterInvocations (targets not invoked, such as
loop protection), TriggeredRules and per-rule dimensions (the counters are per bus), IngestiontoInvocationCompleteLatency.

## Not yet simulated

1. Event patterns as rules. Messages carry no fields, so a pattern is a match rate; a message model with attributes
   (see SIMULATOR.md, "What a message says") would let rules filter on them, and let one edge carry a pattern.
2. A dead-letter queue per target. The bus has one `dlq` port; per-target queues need a port per target or an edge
   naming its queue.
3. The real backoff schedule. AWS doesn't publish it; if it does, `retryBackoff` becomes hard numbers.
4. Partial `PutEvents` failure (`FailedEntryCount`, per-entry `ThrottlingException`), and whether the quota counts
   entries.
5. Archive and replay, cross-account and cross-region delivery (and their `CROSS_REGION_INGESTION_FAILED` errors),
   global endpoints, Pipes, the schema registry, the newer Custom Event Bus.
6. Input transformers (they change the size of what a target receives) and the bus-level DLQ for KMS errors.
7. `Retry-After` from API destinations, and their connection and authorization model.
8. A CloudFormation mapping of `AWS::Events::EventBus`, `AWS::Events::Rule` with `EventPattern` and its `Targets`
   (`RetryPolicy`, `DeadLetterConfig`), and `AWS::Events::ApiDestination` (`InvocationRateLimitPerSecond`).

## Assumptions

| Number | Value | Why |
| --- | --- | --- |
| `putLatency` | mean 10 ms, cv 0.3 | AWS publishes no figure. |
| `deliveryLatency` | mean 40 ms, cv 0.6 | Lognormal with a P99 of about 125 ms, near AWS's published 129 ms; the shape is ours. |
| Retry backoff | full jitter, 1 s doubling to 16 min | AWS says "exponential back off and jitter" and 185 retries in 24 hours; these make the two arrive together on average. |
| Quota bursts | one second's worth (`PutEvents`, invocations, API destination) | AWS gives rates only. |
| Retries outside the invocation quota | | The quota's metric is `InvocationsCreated`. |
| `maxPendingPerTarget` | 100,000 | A memory bound; AWS holds events for up to 24 hours. |
| Entries of a call are equal in size | | A message has one size. |

## References

- https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-quota.html
- https://docs.aws.amazon.com/general/latest/gr/ev.html
- https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_PutEvents.html
- https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-putevents.html
- https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rule-retry-policy.html
- https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rule-dlq.html
- https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_RetryPolicy.html
- https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-targets.html
- https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-api-destinations.html
- https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_CreateApiDestination.html
- https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-monitoring.html
- https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-eventbridge-improvement-latency-event-buses
