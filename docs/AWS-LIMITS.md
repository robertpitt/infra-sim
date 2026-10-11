# AWS limits used by the simulator

Compiled 2026-10-10 from the live AWS documentation (no page showed a "last updated" date). Each row says whether the number is a **hard** limit (the service enforces it, nobody can change it) or an adjustable **quota** (a default AWS raises on request, so it is an editable setting in the simulator). Items the research could not verify are marked **assumed**; those are modelling choices, not AWS facts.

URL bases: `LAMBDA` = https://docs.aws.amazon.com/lambda/latest/dg/ · `SQS` = https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/ · `SNS` = https://docs.aws.amazon.com/sns/latest/dg/ · `GR` = https://docs.aws.amazon.com/general/latest/gr/ · `DDB` = https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ · `APIGW` = https://docs.aws.amazon.com/apigateway/latest/developerguide/ · `S3` = https://docs.aws.amazon.com/AmazonS3/latest/userguide/

## Lambda

| Limit | Value | Kind | Source |
| --- | --- | --- | --- |
| Concurrent executions per Region, shared by every function in the account | 1,000 | quota | `LAMBDA`gettingstarted-limits.html, lambda-concurrency.html |
| Concurrency always left unreserved | 100 (so at most account − 100 can be reserved) | hard | lambda-concurrency.html |
| Reserved concurrency per function | floor **and** cap; 0 throttles the function | setting | configuration-concurrency.html |
| Provisioned concurrency | at most unreserved account concurrency − 100, and ≤ reserved concurrency; allocated at up to 6,000 environments/min | setting | provisioned-concurrency.html |
| Scale-up rate | 1,000 new execution environments per 10 s **per function**, refilled continuously; extra requests get 429 | hard (inferred; page does not say adjustable) | scaling-behavior.html |
| Requests per second cap | 10 × concurrency (sync) | derived | lambda-concurrency.html |
| Timeout | default 3 s, 1–900 s | hard | configuration-timeout.html |
| Memory | 128–10,240 MB; 1 vCPU at 1,769 MB, CPU proportional to memory | hard | configuration-memory.html |
| Payload, synchronous | 6 MB request and 6 MB response | hard | gettingstarted-limits.html |
| Payload, asynchronous | 1 MB | hard | gettingstarted-limits.html |
| Ephemeral storage | 512–10,240 MB | hard | gettingstarted-limits.html |
| Init (cold start) limit | 10 s for on-demand environments | hard | lambda-runtime-environment.html |
| One request per environment | an environment serves one request at a time | behaviour | lambda-concurrency.html |
| Idle environment lifetime | not stated by AWS ("some time", recycled every few hours) | **assumed** | lambda-runtime-environment.html |
| Cold start duration | "under 100 ms to over 1 s"; initialisation code dominates | **assumed** distribution | lambda-runtime-environment.html |

Behaviour:
- **Sync, concurrency or scale rate exhausted:** HTTP 429.
- **Async:** returns 202 once queued. A 429 or 5xx puts the event back on an internal queue, retried for up to 6 h with exponential backoff from 1 s to a 5 min maximum. Function errors (including timeouts) retry **0–2 times (default 2)**, waiting 1 min before the second attempt and 2 min before the third. Events that exhaust retries or exceed `MaximumEventAge` (default and max 6 h) go to the on-failure destination or DLQ. Reserved concurrency 0 sends events straight to the destination.
- **SQS event source mapping:** Lambda polls and invokes synchronously, one invocation per batch. Standard queues start with **5** concurrent batches and add up to **300 per minute** to a ceiling of **1,250**. `MaximumConcurrency` 2–1,000 caps it (not combinable with provisioned mode). Batch size default 10, standard max 10,000 (needs a batching window ≥ 1 s above 10), FIFO max 10. `MaximumBatchingWindow` 0–300 s, standard only. Batches stop at 6 MB. On function error the batch's messages become visible again after the visibility timeout and Lambda backs off the mapping's concurrency; on throttling it reduces concurrency and keeps retrying. AWS recommends visibility timeout ≥ 6 × function timeout (+ batching window), and `maxReceiveCount` ≥ 5 on the queue's DLQ. Partial batch response (`ReportBatchItemFailures`) returns only the failed messages.
- Unverified: provisioned-mode poller maximum (docs say both 2,000 and 10,000).

## SQS

| Limit | Value | Kind | Source |
| --- | --- | --- | --- |
| Standard throughput | "nearly unlimited"; no number published | — | `SQS`quotas-messages.html |
| In-flight messages, standard | about 120,000 | quota | quotas-queues.html |
| In-flight messages, FIFO | 120,000 (older docs said 20,000; "depends on active message groups") | quota (contact Support) | quotas-fifo.html |
| FIFO throughput, normal | 300 transactions/s per API action; 3,000 msg/s with batching | hard | quotas-messages.html, high-throughput-fifo.html |
| FIFO high-throughput, per Region (non-batched TPS / batched msg/s) | us-east-1, us-west-2, eu-west-1: 70,000 / 700,000 · us-east-2, eu-central-1: 19,000 / 190,000 (GR says 18,000 / 180,000) · ap-south-1, ap-southeast-1, ap-southeast-2, ap-northeast-1, eu-south-2: 9,000 / 90,000 · eu-west-2, sa-east-1: 4,500 / 45,000 · other: 2,400 / 24,000 | quota | quotas-messages.html |
| Message size | 1 MiB (GR still says 256 KB; stale) | hard | quotas-messages.html |
| Retention | 60 s – 14 days, default 4 days | setting | quotas-messages.html |
| Visibility timeout | 0 – 12 h, default 30 s | setting | quotas-messages.html |
| Delay | 0 – 15 min (per-message timers not on FIFO) | setting | sqs-delay-queues.html |
| Receive batch | 10 messages | hard | quotas-messages.html |
| Long poll wait | 20 s | hard | quotas-queues.html |
| Redrive `maxReceiveCount` | 1 – 1,000 | setting | sqs-configure-dead-letter-queue.html |
| FIFO deduplication window | 5 minutes | hard | using-messagededuplicationid-property.html |

Behaviour: standard queues are at-least-once with best-effort ordering. In FIFO, while any message of a group is in flight no further message of that group is delivered; the group is released when the message is deleted or becomes visible again (inferred: a redelivered message goes first and the group stays blocked behind it). Standard DLQ keeps the original enqueue time, so retention counts from there; FIFO resets it. When the in-flight limit is reached long polling returns nothing until it drops.

## SNS

| Limit | Value | Kind | Source |
| --- | --- | --- | --- |
| Publish rate per account per Region | us-east-1: 30,000 msg/s · us-west-2, eu-west-1: 9,000 · us-east-2, us-west-1, ap-south-1, ap-northeast-1/2, ap-southeast-1/2, eu-central-1: 1,500 (standard) / 3,000 (FIFO) · all other Regions: 300 (standard) / 3,000 (FIFO) | quota | `GR`sns.html |
| Message size | 256 KiB, raisable to 1 MiB via `MaximumMessageSize` | setting (max 1 MiB) | `GR`sns.html |
| Subscriptions per topic | standard 12,500,000; FIFO 100 | quota | `GR`sns.html |
| FIFO topic, per message group | 300 msg/s; topic default 3,000 msg/s or 20 MB/s | hard | fifo-message-grouping.html |
| FIFO delivery targets | SQS only | hard | fifo-message-delivery.html |

Delivery retries (`SNS`sns-message-delivery-retries.html), not adjustable for AWS-managed endpoints: **SQS and Lambda** get 3 immediate retries, 2 at 1 s, 10 with exponential backoff from 1 to 20 s, then 100,000 at 20 s: 100,015 attempts over 23 days, with jitter. HTTP/S is configurable (`numRetries` 0–100, delays 1–3,600 s, total ≤ 3,600 s; default **assumed** 3 retries at 20 s). 5xx and 429 are retried; other errors are permanent. Exhausted messages are discarded unless the subscription has an SQS DLQ. Unverified: whether SNS invokes Lambda asynchronously (it does in AWS practice; the fetched pages don't say).

## DynamoDB

| Limit | Value | Kind | Source |
| --- | --- | --- | --- |
| Per-partition throughput | 3,000 read units, 1,000 write units per second | hard | `DDB`bp-partition-key-design.html, burst-adaptive-capacity.html |
| Per-table throughput, provisioned | 40,000 RCU and 40,000 WCU | quota | ServiceQuotas.html |
| Per-account throughput, provisioned | 80,000 RCU and 80,000 WCU (all tables in a Region) | quota | ServiceQuotas.html |
| Per-table throughput, on-demand | 40,000 read and 40,000 write request units | quota | ServiceQuotas.html |
| New on-demand table baseline | 4,000 writes/s and 12,000 reads/s | behaviour | on-demand-capacity-mode.html |
| On-demand scaling | instantly absorbs 2× the previous peak; throttling possible beyond double the previous peak within 30 minutes | behaviour | on-demand-capacity-mode.html |
| Burst capacity | up to 300 s of unused capacity retained ("might change"); refill mechanics **assumed** | behaviour | burst-adaptive-capacity.html |
| Adaptive capacity | always on; raises a hot partition within the table's total and the partition maximum | behaviour | burst-adaptive-capacity.html |
| Item size | 400 KB | hard | Constraints.html |
| BatchGetItem / BatchWriteItem | 100 items / 25 items | hard | Constraints.html |
| Transaction | 100 items, 4 MB; costs 2× | hard | transaction-apis.html |
| Latency | "single-digit milliseconds"; no percentiles published | **assumed** distribution | Introduction.html |

Capacity maths: reads round up to 4 KB (strongly consistent 1 unit, eventually consistent 0.5, transactional 2); writes round up to 1 KB (1 unit, transactional 2). Failed conditional writes still consume capacity. Throttling returns `ProvisionedThroughputExceededException` (400, retryable). AWS SDK default for DynamoDB clients: 4 attempts, full-jitter backoff, 25 ms base for transient errors and 1,000 ms for throttling (this applies only with the 2026 opt-in; older defaults unverified). The number of partitions a table has, and how fast it splits, is not published (**assumed**).

## API Gateway

| Limit | REST | HTTP | Kind | Source |
| --- | --- | --- | --- | --- |
| Account steady-state rate per Region (shared across API types) | 10,000 rps | 10,000 rps | quota | `APIGW`limits.html |
| Account burst (bucket size) | 5,000 | 5,000 | hard ("not a quota a customer can control") | limits.html |
| Reduced Regions (Cape Town, Milan, Jakarta, UAE, Hyderabad, Melbourne, Spain, Zurich, Tel Aviv, Calgary, Malaysia, Thailand, Mexico Central) | 2,500 rps / 1,250 burst | same | quota | limits.html |
| Stage / method / route throttle | configurable, cannot exceed account limits | same | setting | api-gateway-request-throttling.html |
| Integration timeout | 50 ms – 29 s (Regional/private REST can be raised above 29 s) | max 30 s | hard (HTTP), quota (REST Regional) | api-gateway-execution-service-limits-table.html, http-api-quotas.html |
| Payload | 10 MB | 10 MB | hard | same |

Throttling is a token bucket (one token per request, `rate` refills, `burst` is the bucket size); best effort. Over-limit requests get **429**; integration timeout gives **504**; oversized request gives **413**. Added latency is not stated by AWS (**assumed**). Precedence: usage-plan/method limits, stage limits, account limits.

## S3

| Limit | Value | Kind | Source |
| --- | --- | --- | --- |
| Request rate per partitioned prefix | at least 3,500 PUT/COPY/POST/DELETE and 5,500 GET/HEAD per second | hard (a documented floor: S3 scales a busy prefix gradually, so the real ceiling grows) | `S3`optimizing-performance.html, optimizing-performance-design-patterns.html |
| Prefixes per bucket | unlimited; read/write capacity multiplies with prefixes | behaviour | optimizing-performance.html |
| Over the rate | HTTP 503 Slow Down; SDKs retry with exponential backoff | behaviour | optimizing-performance-design-patterns.html |
| Scale-up of a new request rate | gradual, not instant; 503s dissipate once S3 has scaled (timing not published, so not modelled) | **assumed** (not modelled) | optimizing-performance.html |
| Consistency | strong read-after-write for PUT, overwrite and DELETE; bucket configuration is eventually consistent | behaviour | Welcome.html#ConsistencyModel |
| Single PutObject | 5 GB | hard | upload-objects.html |
| Maximum object size | 48.8 TiB (the quotas page says 48.828125 TB; older docs said 5 TB) | hard | qfacts.html, `GR`s3.html |
| Multipart upload | 10,000 parts; part 5 MiB to 5 GiB (last part may be smaller) | hard | qfacts.html, `GR`s3.html |
| Console upload | 160 GB | hard | upload-objects.html |
| Event notifications | designed for at-least-once delivery, "typically in seconds but can sometimes take a minute or longer"; to SNS, SQS (not FIFO), Lambda, EventBridge | behaviour | EventNotifications.html |
| Notification configurations | 100 per bucket | hard | `GR`s3.html |
| General purpose buckets | 10,000 per account | quota | `GR`s3.html |
| First-byte latency | "roughly 100-200 ms" for latency-sensitive workloads; "tens of milliseconds" median for small requests; no distribution published | **assumed** distribution (read: mean 40 ms, cv 1; write: mean 70 ms, cv 0.8) | optimizing-performance.html, optimizing-performance-design-patterns.html |
| Transfer rate per request | not stated in current docs (AWS advises parallel connections; one EC2 instance can reach 100 Gb/s); the default of 90 MB/s per connection comes from older guidance | **assumed** | optimizing-performance-guidelines.html |
| Event notification delay distribution | mean 1.5 s, cv 1 | **assumed** | EventNotifications.html |
| Event delivery retries to destinations | 10 attempts backing off 1 to 20 s | **assumed** (AWS documents at-least-once, not a schedule) | EventNotifications.html |

Modelled in the simulator: requests land on a prefix by their key (`prefixes` spreads them evenly; a hot key is one prefix); each prefix has a token bucket (rate = burst) of 3,500 for writes and deletes and 5,500 for reads, and an empty bucket fails the call with `Throttled` (503 Slow Down). Latency is first byte plus bytes / transfer rate. A write over 5 GB is `Rejected`. A successful write or delete publishes an event off the request path, after the notification delay, to every connected destination as an async ~1 KB message. Not modelled: multipart upload, storage classes (only Standard-like latency), versioning, lifecycle, replication, KMS request limits, and S3's gradual per-prefix scale-up.
