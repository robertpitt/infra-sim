# S3 (`aws.s3`)

Amazon S3 is object storage: buckets of objects addressed by key, with no capacity to provision, strong read-after-write
consistency, and a request rate that is limited per key prefix and scaled by S3 itself as a prefix gets busy. The
component lets you learn where a design runs into those limits: a hot prefix that answers 503 Slow Down, a bucket whose
keys all share one prefix, large objects moved as parallel parts, archived objects that cannot be read until restored,
event notifications that arrive late or twice, replicas that fall behind, and an S3 Express One Zone directory bucket
that has no per-prefix limit. It does not store objects: there are no keys, only a key hash that picks a prefix.

## Coverage

| Feature | Status | Notes |
| --- | --- | --- |
| **Requests** | | |
| GET, HEAD, PUT, COPY, DELETE | ✅ | Reads (GET, HEAD, LIST) and writes (PUT, COPY, DELETE) are told apart by the edge's read/write operation; the mix inside each is `headShare`, `listShare`, `copyShare`, `deleteShare`. |
| LIST | 🟡 | A read with its own first-byte latency and no body. AWS publishes no LIST rate, so it draws on the read allowance (assumed). Pages, delimiters and delete-marker slowdowns are not modelled. |
| POST | 🟡 | Only the two POSTs of a multipart upload (initiate, complete), counted as `post`. Browser-based POST uploads and restore requests are folded into PUT. |
| First-byte latency, then bytes over a transfer rate | ✅ | Separate read, write and list first-byte distributions (assumed); one connection moves bytes at `transferRate` (assumed). |
| Multipart upload and ranged GET | ✅ | Optional. Parts of 5 MiB to 5 GiB, at most 10,000, `concurrency` at a time. Each part, and the initiate and complete, is a request on the prefix. A transfer's parts are charged together when it starts, not spread over its duration. |
| Single PUT/COPY limit (5 GB), object limit (48.8 TiB) | ✅ | `Rejected` (400 EntityTooLarge). |
| Strong read-after-write consistency | ✅ | Always true: there is nothing stale to read. Last-writer-wins on concurrent writes is not visible, since there are no objects. |
| **Throttling** | | |
| 3,500 write and 5,500 read requests per second per prefix | ✅ | A token bucket per prefix and class; over it the call fails `Throttled` (503 Slow Down). Keys spread evenly over `prefixes`; a hot key stays on one. |
| Gradual scale-up of a hot prefix | 🟡 | Optional (`prefixScaling`). AWS says scaling is gradual and 503s dissipate when it is done, and publishes no timing, so the model (a prefix refused for `splitAfter` doubles its rate, up to `maxSplits`) is an assumption. |
| 500 InternalError | 🟡 | A `Failed` call; there is no rate for it. Inject it with the Errors fault. 503 Service Unavailable (down) is the Outage fault (`Unavailable`). |
| SSE-KMS request limits | ❌ | KMS quotas apply to every S3 request with SSE-KMS; there is no KMS component. |
| **Scaling and bucket types** | | |
| Prefixes | ✅ | `prefixes` from 1 to 100,000; no cap on how many a bucket can have. |
| S3 Express One Zone (directory bucket) | 🟡 | `bucketType: directory`: 200,000 writes and 2,000,000 reads a second in all, no per-prefix limit, first byte `directoryLatencyFactor` times faster (assumed 10). Session tokens, the single zone and the AZ-local network path are not modelled. |
| General purpose buckets per account | 🟡 | Quota `s3GeneralPurposeBuckets` (10,000); the audit counts one region's buckets. |
| **Storage classes** | | |
| Standard, Intelligent-Tiering, Standard-IA, One Zone-IA, Glacier Instant Retrieval | 🟡 | Read in milliseconds, so they behave like Standard. Minimum durations, retrieval fees, availability and durability differences are cost and resilience properties that are not modelled. |
| Glacier Flexible Retrieval, Deep Archive | 🟡 | A GET is refused (`Rejected`, 403 InvalidObjectState) except for `restoredShare` of reads. HEAD and LIST work. Restore jobs (1 minute to 48 hours by tier) are not simulated. |
| **Data management** | | |
| Versioning and delete markers | 🟡 | A DELETE counts a delete marker (`deleteMarkers`). Nothing else changes; the cost of many markers on LIST is not modelled. |
| Lifecycle (expiration, transitions) | ❌ | No objects age. Lifecycle events would be a rate of notifications; see Not yet simulated. |
| Object Lock, tagging, ACLs, access points, Object Lambda, Batch Operations, Transfer Acceleration | ❌ | Do not change what a request costs in this model, or need objects. |
| **Replication** | | |
| Live replication (CRR, SRR) | ✅ | Wire the `replication` port to another bucket. Each new object is written there after `replicationDelay`, as a write that the destination's own limits apply to. A replica is not replicated again, so two buckets can replicate to each other. A rule's prefix or tag filter is a fraction. |
| Replication Time Control | 🟡 | `replicationTimeControl` queues replicas through the account's `s3ReplicationTransferRate` quota (1 Gb/s), so a region replicating more falls behind. The 15-minute SLA and its missed-threshold events are not modelled. |
| Replication's own requests on the source | ❌ | Each replicated object costs up to five GET/HEAD and one PUT on the source prefix; not charged. |
| Delete replication, existing objects (Batch Replication) | ❌ | |
| **Events** | | |
| Notifications to SNS, SQS, Lambda, EventBridge | ✅ | The `events` port. One event per object created or removed, after `notificationDelay`, off the request path, each destination independently, with retries. |
| Object-created vs object-removed | ✅ | Per destination, `eventTypes`. |
| Prefix and suffix filters | 🟡 | A fraction (`filter`): there are no key names to match. |
| At-least-once delivery | 🟡 | `duplicateRate` delivers some twice. AWS publishes no rate, so it defaults to none. |
| Other event types (restore, replication, lifecycle, tagging, Intelligent-Tiering) | ❌ | |
| **Metrics** | | |
| AllRequests, Get/Head/List/Put/Post/DeleteRequests, 4xx, 5xx, BytesDownloaded, BytesUploaded, FirstByteLatency, TotalRequestLatency | ✅ | See Metrics and state. |
| BucketSizeBytes, NumberOfObjects, replication metrics | 🟡 | Replication lag and backlog are reported; storage metrics are not (no objects). |

## Settings

Every setting is on the node. Defaults leave behaviour as it was before the setting existed.

| Setting | Default | Range | Kind | What it models |
| --- | --- | --- | --- | --- |
| `bucketType` | general | general, directory | choice | A general purpose bucket (per-prefix limits) or an S3 Express One Zone directory bucket. |
| `prefixes` | 1 | 1 to 100,000 | design choice | Distinct prefixes requests spread over. Each has its own allowance. |
| `prefixScaling.enabled` | off | | assumed | Gradual scale-up of a hot prefix. |
| `prefixScaling.splitAfter` | 5 minutes | 1 second to 1 day | assumed | How long a prefix is refused before its rate doubles. |
| `prefixScaling.maxSplits` | 10 | 1 to 30 | assumed | Most doublings. |
| `deleteShare` | 0 | 0 to 1 | design choice | Share of writes that are DELETEs. |
| `copyShare` | 0 | 0 to 1 | design choice | Share of writes that are server-side COPYs (after the deletes). |
| `headShare` | 0 | 0 to 1 | design choice | Share of reads that are HEADs. |
| `listShare` | 0 | 0 to 1 | design choice | Share of reads that are LISTs (before the HEADs). |
| `readLatency` | mean 40 ms, cv 1 | | assumed | First byte of a GET or HEAD. |
| `writeLatency` | mean 70 ms, cv 0.8 | | assumed | First byte of a PUT, COPY or DELETE. |
| `listLatency` | mean 100 ms, cv 0.8 | | assumed | First byte of a LIST. |
| `directoryLatencyFactor` | 10 | 1 to 100 | assumed | How much faster a directory bucket answers. |
| `transferRate` | 90 MB/s | 1 to 12,500 | assumed | Bytes per second over one connection. |
| `multipart.enabled` | off | | | Split large transfers into parallel parts. |
| `multipart.threshold` | 8 MiB | 5 to 5,120 MiB | assumed (the AWS CLI default) | Object size at which a transfer is split. |
| `multipart.partSize` | 8 MiB | 5 MiB to 5 GiB | hard range; default is the AWS CLI's | Size of a part, raised if the object would need over 10,000. |
| `multipart.concurrency` | 10 | 1 to 1,000 | assumed (the AWS CLI default) | Parts moving at once. |
| `storageClass` | standard | seven classes | choice | Whether a GET can read the objects at once. |
| `restoredShare` | 0 | 0 to 1 | design choice | Archived reads that hit a restored object. |
| `versioning` | off | | | A DELETE writes a delete marker. |
| `notificationDelay` | mean 1.5 s, cv 1 | | assumed | Delay of an event notification. |
| `duplicateRate` | 0 | 0 to 1 | assumed | Notifications delivered twice. |
| `replicationDelay` | mean 15 s, cv 1 | | assumed | Delay before a replica is written. |
| `replicationTimeControl` | off | | | Queue replicas through the account's RTC transfer quota. |

Edge settings on the `events` port: `eventTypes` (all, created, removed; default all), `filter` (share matching, default 1), `retry`
(10 attempts, 1 s to 20 s backoff, assumed). On the `replication` port: `filter` (share of objects the rule covers,
default 1) and `retry` (the same). Account quotas (Account quotas panel of a Region box): `s3GeneralPurposeBuckets`
(10,000), `s3DirectoryBuckets` (100), `s3ReplicationTransferRate` (1 Gb/s).

## Limits

| Limit | Value | Kind | Source |
| --- | --- | --- | --- |
| Requests per partitioned prefix | at least 3,500 PUT/COPY/POST/DELETE and 5,500 GET/HEAD per second | hard floor (S3 scales above it, see Behaviour) | https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html |
| Prefixes per bucket | no limit | hard | same |
| Scaling above the floor | gradual, not instantaneous, 503 Slow Down meanwhile; no timing published | assumed (model is optional) | same, and optimizing-performance-design-patterns.html |
| Directory bucket requests | up to 2,000,000 GET and 200,000 PUT per second per bucket; directories scale instantly | hard | https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-optimizing-performance-design-patterns.html |
| Directory buckets per account | 100 | quota | https://docs.aws.amazon.com/general/latest/gr/s3.html |
| General purpose buckets per account | 10,000 | quota | https://docs.aws.amazon.com/general/latest/gr/s3.html, BucketRestrictions.html |
| Single PUT or COPY | 5 GB | hard | https://docs.aws.amazon.com/AmazonS3/latest/userguide/upload-objects.html |
| Maximum object size | 48.8 TiB (the quotas page: 48.828125 TB) | hard | https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html |
| Multipart parts | 10,000 per upload, 5 MiB to 5 GiB each, the last may be smaller | hard | qfacts.html, https://docs.aws.amazon.com/general/latest/gr/s3.html |
| Event notifications | at least once; "typically in seconds but can sometimes take a minute or longer"; SNS, SQS (not FIFO), Lambda, EventBridge | hard | https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventNotifications.html |
| Notification configurations | 100 per bucket | hard, not enforced | https://docs.aws.amazon.com/general/latest/gr/s3.html |
| Consistency | strong read-after-write for PUT, DELETE, LIST, HEAD; bucket configuration eventually consistent | hard | https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html |
| Replication Time Control | 99.9% of objects within 15 minutes; 1 Gb/s default transfer quota (adjustable) | hard / quota | https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-time-control.html |
| Replication requests | up to five GET/HEAD and one PUT on the source per replicated object, one PUT per destination | hard, source side not modelled | same |
| Archive retrieval | Expedited 1 to 5 min, Standard 3 to 5 h (Deep Archive within 12 h), Bulk 5 to 12 h (Deep Archive within 48 h); 1,000 restore requests per second per account | hard, not simulated | https://docs.aws.amazon.com/AmazonS3/latest/userguide/restoring-objects-retrieval-options.html |
| Glacier Instant Retrieval, Standard-IA, One Zone-IA, Intelligent-Tiering frequent tiers | millisecond access | hard | https://docs.aws.amazon.com/AmazonS3/latest/userguide/storage-class-intro.html |
| First-byte latency | "roughly 100 to 200 milliseconds" for latency-sensitive workloads; tens of ms median for small requests; no distribution | assumed distribution | optimizing-performance.html, optimizing-performance-design-patterns.html |
| Throughput per connection | not published in current docs; "use multiple connections" | assumed (90 MB/s from older guidance) | optimizing-performance-guidelines.html |
| Large-transfer defaults | AWS CLI: 8 MB threshold and part size, 10 concurrent requests | assumed for SDKs in general | https://docs.aws.amazon.com/cli/latest/topic/s3-config.html |

Where two pages disagree: the replication overview says RTC replicates 99.99% within 15 minutes, the RTC page says 99.9%
(the table on the overview page also says 99.9%); the simulator uses 99.9% and does not model the SLA anyway. Older S3
pages gave a 5 TB object limit and 85 to 90 MB/s per connection; the current quotas page says 48.8 TiB, and the
performance pages no longer give a per-connection figure.

## Behaviour

**A call.** The engine tells S3 only that a call is a read or a write (set on the edge into the bucket: `request.operation`,
which defaults to **write**, so a client wired to a bucket writes unless the edge says read). A read is a GET, or with
`headShare`/`listShare` a HEAD or LIST. A write is a PUT, or with `deleteShare`/`copyShare` a DELETE or COPY. One random
draw per call decides, and none is drawn when the shares are 0. A message with `count` above 1 is a batch of that many
requests of one kind (a count below 1 is treated as 1, a negative or missing body as empty).

*The `deleteShare` convention.* The message has no way to say "delete", and the edge settings that carry the operation
belong to the engine, so the kind of request is a property of the bucket, not of the caller: every client wired to a
bucket sees the same mix. Where two callers do different things (one only reads, another only deletes), use the edge's
read or write for the read/write split and put them on separate buckets for any finer split. A cleaner mechanism needs
the engine to carry a request kind on the message or the edge (see the end of this file).

**Per-prefix limit.** A call lands on prefix `floor(key × prefixes)`. Each prefix has two token buckets, reads and
writes (rate = burst = the allowance, so it starts with a second's worth), taking one token per request. If the bucket has
too few tokens the whole call fails `Throttled` with "503 Slow Down"; a call asking for more than the whole bucket takes
the bucket. Refused calls are retried by the edge's retry policy, as an SDK would, and the retry is another request.
A multipart transfer takes the tokens of all its parts at once when it starts; a real client spreads them over the
transfer, so a very large object looks burstier than it is.

**Scale-up (optional).** With `prefixScaling.enabled`, a prefix refused for `splitAfter` without a break longer than ten
seconds (an assumption) has its allowance doubled, up to `maxSplits` doublings, and the run starts over. Demand above
the guaranteed rate therefore sees 503s that stop when the prefix has caught up. The model is deliberately plain: AWS gives
no timing and no ceiling. Turning it off, or lowering `maxSplits` below the current level, returns the prefix to its
guaranteed rate at the next call. Scaled prefixes appear in the `scaled` state and the `readCeiling`/`writeCeiling` gauges.

**Directory buckets.** The prefix tables are replaced by one pair of allowances for the whole bucket (200,000 writes,
2,000,000 reads a second). First-byte latencies are divided by `directoryLatencyFactor`. Switching `bucketType` live resets
the allowances.

**Time.** A call takes first byte + transfer time, one timer. Plain: first byte (a lognormal draw of the setting for that
kind) + bytes / `transferRate`, a batch moving its bytes one after another. HEAD, LIST and DELETE move no bytes. With
multipart on and each object at or over the threshold: each object is cut into parts of `partSize` (raised if more than
10,000 would be needed), `concurrency` parts move at once, so the bytes move at up to `concurrency × transferRate`; every
wave of parts after the first pays a mean first byte; an upload also pays an initiate and a complete round trip. COPY moves
its bytes inside S3 at `transferRate` and nothing crosses the client's connection (it is not in `bytesUploaded`). The
transfer is not slowed by other traffic: S3 has no shared bandwidth to model, only the per-connection rate.

**Sizes.** A PUT or COPY of over 5 GB each is refused `Rejected` (400 EntityTooLarge) unless multipart is on; with
multipart on, over 48.8 TiB is refused. Reads have no size limit.

**Archived objects.** In an archive class, a GET that does not hit a restored object is `Rejected` (403 InvalidObjectState,
not retryable). Writes, HEAD and LIST are unaffected.

**Events.** After a write completes, each destination on the `events` port hears of it after its own draw of
`notificationDelay`, through the edge (so network latency, timeout and retry apply), without making the writer wait. Reads
and LISTs send nothing. A PUT, COPY or completed multipart upload is one object-created event; a DELETE is one
object-removed event (with versioning, DeleteMarkerCreated, the same here). Each destination's `eventTypes` and `filter`
choose which it gets. A message with `count` objects sends that many events in at most 100 messages, so one call can
never arm unbounded timers. The sender's message group is dropped (S3 notifications have none). An event that exhausts
the destination's retries is counted `undelivered`; events are unordered.

**Replication.** With something wired to the `replication` port, each new object (PUT, COPY, multipart; not a DELETE) is
written to each destination after `replicationDelay`, as a write to the destination bucket, carrying its key hash and
size, so the destination's prefix limits, latency, events and its own replication all apply. It is marked as a replica
(message group `s3:replica`) and is not replicated again. With Replication Time Control the bytes also go through one
FIFO pipe per account and region (`s3ReplicationTransferRate`), and a replica is delayed until the pipe has carried it, so
demand above the quota turns into growing lag, visible in `replicationLag` and `replicating`. The replica write fails with
the destination's failure if it is throttled or down, and the port's retry policy applies.

**Departures from AWS.** There are no objects, so reads never miss and nothing is ever stale, deleted or restored on its own.
Prefix keys are an even spread of a hash, not real key names, so a sequential key pattern's effect is the `prefixes` setting
and `hotKeys` on the client. Request rate is checked at the start of a call, not while its bytes stream.

## Connections

- **In**: any component that calls a bucket (a client, a Lambda function, an API Gateway integration). The edge's
  `request.operation` (read or write) and `payload` decide what the bucket sees.
- **`events`** (many): event notifications. Wire to Lambda, SQS (standard), SNS or an HTTP endpoint standing in for
  EventBridge. Edge settings: `eventTypes`, `filter`, `retry`, plus the universal latency, timeout and weight. Messages are
  about 1 KiB, asynchronous.
- **`replication`** (many): replicas. Wire to another `aws.s3`. Edge settings: `filter`, `retry`, plus the universal ones.

CloudFormation import (`importers/cloudformation/s3.ts`): `AWS::S3::Bucket` is an `aws.s3`; `VersioningConfiguration.Status:
Enabled` gives `versioning: true`; `AWS::S3Express::DirectoryBucket` gives `bucketType: directory`.

- **Notifications** (the bucket's `NotificationConfiguration`, the custom resource CDK writes next to it, or a SAM `S3`
  event) become edges on the `events` port to a function, queue or topic of the template. `s3:ObjectCreated:*` and
  `s3:ObjectRemoved:*` events set `eventTypes` (created, removed, or `all`); entries to one destination merge into one
  edge. Any other event type (restore, replication, tagging, lifecycle) is not produced by the simulator: it is dropped and
  reported, and a notification of only such events draws no edge. `EventBridgeConfiguration` is reported (no component), as
  is a destination outside the template.
- **Key filters are an assumed share.** A template can't say what part of a bucket's keys a prefix or suffix rule keeps, so
  a rule on one end assumes 50% and rules on both ends 25%; this is set as the edge's `filter` (alternative entries for one
  event type add up, capped at 1) and every such filter is listed under unresolved ("set the edge's filter").
- **Replication** (`ReplicationConfiguration.Rules`, enabled rules only) becomes an edge on the `replication` port to the
  destination bucket (by reference, or by ARN or name of a bucket in the template); `Destination.ReplicationTime.Status:
  Enabled` sets `replicationTimeControl: true`. A rule with a `Filter` or `Prefix` assumes 50% as `filter` and is listed
  under unresolved. A destination outside the template is reported and not connected.

Not read (no effect on load): `LifecycleConfiguration`, `BucketEncryption`, `PublicAccessBlockConfiguration`,
`CorsConfiguration`, `Tags`, `AWS::S3::BucketPolicy`.

## Metrics and state

Counters (per second in frames). Request counters are per request: a batch counts `count`, a multipart transfer counts its parts.

| Name | CloudWatch name | Meaning |
| --- | --- | --- |
| `requests` | AllRequests | Every request, including refused ones. |
| `get`, `head`, `list`, `put`, `post`, `delete` | Get/Head/List/Put/Post/DeleteRequests | Requests served. `put` includes copies (CloudWatch counts a copy as a PUT on the destination) and upload parts; `post` is the multipart initiate and complete. |
| `copy` | | COPY requests served. |
| `deleteMarkers` | | DELETEs that wrote a delete marker (versioning on). |
| `bytesDownloaded`, `bytesUploaded` | BytesDownloaded, BytesUploaded | Bytes of GET bodies, and of PUT bodies (not COPY). |
| `4xxErrors` | 4xxErrors | Requests refused as too large or archived. |
| `5xxErrors` | 5xxErrors | Requests answered 503 Slow Down. |
| `delivered`, `undelivered` | | Event messages delivered, or abandoned after retries. |
| `replicated`, `replicationFailed` | | Replicas written, or abandoned after retries. |

The framework also counts `in`, `ok`, `fail` and `fail.<Tag>` per call (a batch is one call).

Distributions: `firstByteLatency` (FirstByteLatency, including a multipart initiate), `totalRequestLatency`
(TotalRequestLatency), `replicationLag` (time from the write to the replica landing). The framework's `latency` is the node's time per call.

Gauges: `transferring` (calls moving bytes), `pending` (notifications not yet delivered), `replicating` (replicas not yet
landed), `readCeiling` and `writeCeiling` (highest per-prefix rate now: the guarantee, or what scale-up reached).

Probe state: `bucketType`, `prefixes`, `served` (`reads`, `writes`, `deletes`, `heads`, `lists`, `copies`, `deleteMarkers`,
`multipartParts`), `throttled` (`reads`, `writes`: requests), `refused` (`archived`, `tooLarge`), `transferring`, `scaled`
(`prefixes`, `readCeiling`, `writeCeiling`), `notifications` and `replication` (`destinations`, `pending`, `delivered`, `undelivered`).

## Not yet simulated

1. **Replication's source-side requests** (one PUT and up to five GET/HEAD per object on the source prefix). Matters when a bucket is near its limit and replicates. Needs a deferral queue for replicas the prefix cannot afford.
2. **KMS request limits** for SSE-KMS buckets (shared regional rates). Needs a KMS component or an account-level KMS rate.
3. **Archive restore jobs** (RestoreObject with Expedited, Standard and Bulk tiers, provisioned capacity, the 1,000/s restore request quota). Would need per-object state or a restored-share ramp over time.
4. **Lifecycle**: expiration and transition events as a notification rate, and transitions changing the storage class over time.
5. **Per-kind edge settings**: a request kind chosen per edge instead of per bucket (needs the engine; see below).
6. **Replication Time Control SLA and events** (OperationMissedThreshold), delete-marker replication, Batch Replication.
7. **Express One Zone sessions** (CreateSession tokens refreshed every 5 minutes) and the directory-bucket single zone.
8. **Notification limits**: the 100 configurations per bucket, SQS FIFO as an invalid destination (an audit that sees edges).
9. **S3 Object Lambda, Access Points, Multi-Region Access Points, Transfer Acceleration.**

## Assumptions

- Read first-byte 40 ms (cv 1), write 70 ms (cv 0.8), list 100 ms (cv 0.8): AWS says "roughly 100 to 200 ms" for consistent latency and tens of milliseconds median for small requests, and publishes no distribution. Lognormal, centred below the quoted figure because it is a median for small requests.
- `transferRate` 90 MB/s per connection: older AWS guidance; current docs give no figure.
- `directoryLatencyFactor` 10: AWS says "up to 10x faster".
- Multipart defaults (8 MiB threshold and parts, 10 connections): the AWS CLI's documented defaults, standing in for "the SDK".
- Scale-up: doubling per `splitAfter` (5 minutes), at most 2^10, runs bridging gaps up to 10 seconds. AWS describes the behaviour without numbers.
- `notificationDelay` mean 1.5 s, cv 1 ("typically seconds, sometimes a minute or longer"); `duplicateRate` 0; notification and replica retry: 10 attempts, 1 s to 20 s, jittered.
- `replicationDelay` mean 15 s, cv 1: RTC says "most in seconds, 99.9% within 15 minutes"; there is no figure without RTC.
- An event notification weighs 1 KiB.
- LIST counts against the read allowance.

## References

- https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance-design-patterns.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance-guidelines.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-optimizing-performance-design-patterns.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/directory-bucket-high-performance.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html
- https://docs.aws.amazon.com/general/latest/gr/s3.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/BucketRestrictions.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventNotifications.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/storage-class-intro.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/restoring-objects-retrieval-options.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-time-control.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/metrics-dimensions.html
- https://docs.aws.amazon.com/cli/latest/topic/s3-config.html

## What would help from the engine

A request kind on the message (`get | head | list | put | copy | delete`) set from the edge's `request` group, in place of
the two-valued `operation`, would remove the bucket-wide mix settings (`deleteShare`, `headShare`, `listShare`,
`copyShare`) and let two callers of one bucket do different things.
