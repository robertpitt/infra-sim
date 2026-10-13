# Kinesis Data Streams (`aws.kinesis`)

Amazon Kinesis Data Streams is an ordered, replayable log of records, split into shards by partition key. Producers put
records; every consumer reads every shard on its own, in order, and the stream keeps the records for its retention period
whether anyone has read them or not. Capacity is per shard: each takes 1 MiB/s or 1,000 records/s in and serves 2 MiB/s and
five GetRecords calls a second out, shared by every polling consumer. This component lets you learn where that bites: a
hot partition key that throttles one shard while the others idle, a third consumer that starves the other two, an on-demand
stream that can't double fast enough, and, through the Lambda event source mapping connector
(`aws.kinesis.event-source-mapping`), a function that falls behind (IteratorAge), a parallelization factor that helps until
the key is hot, and a single bad record that blocks its shard until it is split out, retried away or expires.

Everything runs on virtual time with seeded randomness. Records are kept as segments (counts, sizes and times), not as
objects, so a busy stream costs a few words per shard per 200 ms.

## Coverage

| Feature | Status | Notes |
| --- | --- | --- |
| **Writes** | | |
| PutRecord: 1 MiB/s and 1,000 records/s per shard | ✅ | A token bucket per shard for each, both or neither taken. Past either: `Throttled` (ProvisionedThroughputExceededException), counted as `throttled` (WriteProvisionedThroughputExceeded). |
| Partition key picks the shard | ✅ | `Message.key` (a hash in [0, 1)) is the hash key; a shard owns a range of it. A client's `hotKeys` share sends one key, which loads one shard. |
| PutRecords: 500 records, 10 MiB, records fail one by one | ✅ | A message with `count` > 1 is a PutRecords whose records have independent keys: spread over the shards by the width of their ranges. Records whose shard is over its limit fail, the rest are stored, and the caller hears `ItemFailures` naming them; all refused is `Throttled`. Over 500 records or 10 MiB is `Rejected`. |
| Record size (1 MiB, raisable to 10 MiB) and burst | ✅ | `maxRecordSize`; a bigger record is `Rejected`. A large record draws on the shard's burst (the bucket holds one maximum-size record) and throttles what follows until it refills. The burst's real size is unpublished. |
| A PutRecords' records with one key | ❌ | Every record of a batch is spread as if its keys were independent; a hot key in a batch can't be expressed. |
| **Capacity modes** | | |
| Provisioned: shard count | ✅ | `shards`. |
| UpdateShardCount (resharding) | ✅ | Changing `shards` while running: uniform steps of at most double or half, two minutes each (assumed: "a few minutes"), ten in a rolling 24 hours; a change past that waits (`updatesWaiting`). Old shards close and are read to their end before their children. |
| SplitShard / MergeShards on chosen shards | ❌ | Only uniform scaling; see *Not yet simulated*. |
| On-demand: 4 MB/s start, about double the peak | ✅ | Starts at four shards. A shard whose offered traffic (accepted or throttled, averaged over about a minute) is over 500 KB/s or 500 records/s is split in two `splitDelay` later (15 minutes, AWS's "within 15 minutes"). So capacity keeps about twice the peak, and traffic more than doubling faster than that is throttled meanwhile. |
| On-demand: hot key | ✅ | Splitting is even and doesn't isolate a key: the key's shard keeps splitting, and the key stays at one shard's limit. |
| On-demand: regional ceiling | ✅ | 10 GB/s in N. Virginia, Oregon and Ireland, 200 MB/s elsewhere (`kinesisOnDemandWriteMBps`); the stream stops splitting there. |
| On-demand: scale-down after 30 days, warm throughput, On-demand Advantage | ❌ | Capacity never shrinks within a run; Advantage (warm throughput, 50 consumers) isn't modelled. |
| Switching modes | 🟡 | Keeps the shards there are, as AWS does. The twice-a-day limit isn't enforced. |
| **Reads** | | |
| Shared throughput: 2 MiB/s and 5 GetRecords/s per shard | ✅ | Every standard consumer (Lambda's standard iterator, Firehose, a generic poller) draws on one allowance per shard. A call may overdraw the bytes, as AWS lets one call return 10 MiB and then throttles for about five seconds. A throttled call waits a second (`readThrottled`: ReadProvisionedThroughputExceeded). Idle polls cost calls too. |
| GetRecords: 10,000 records or 10 MiB a call | ✅ | Whole segments, at least one. |
| Enhanced fan-out: 2 MiB/s per shard per consumer, pushed | ✅ | A mapping with `enhancedFanOut` gets its own allowance and is pushed records as they become readable (no polling, no calls). 20 registered consumers a stream: the 21st reads nothing (`refused`). |
| Propagation delay | 🟡 | Records become readable when their segment seals, 200 ms after its first record: about 100 ms on average (AWS: about 70 ms to an enhanced fan-out consumer). |
| Retention, 24 hours to 365 days | ✅ | `retention`. Records are kept until every consumer is past them; a consumer that reaches records past retention skips them and counts them `expired`. With no consumer, nothing is kept. |
| Shard lineage (parents before children) | ✅ | A consumer reads a child shard only once it has finished every parent. |
| GetShardIterator, iterator expiry, AT_TIMESTAMP | ❌ | Every consumer starts at LATEST when the run starts (TRIM_HORIZON reads the same, since the stream is empty at t = 0). |
| KPL aggregation, server-side encryption, tagging | ❌ | No effect on load here. |
| **Lambda event source mapping** (`aws.kinesis.event-source-mapping`) | | |
| One poller per shard, records in order | ✅ | Base rate of one GetRecords a second when caught up, at once while behind (within the shard's five calls a second). |
| Batch size, 6 MB cut, batching window | ✅ | |
| Parallelization factor (1 to 10), in order per key | ✅ | A shard is cut by hash key into that many lanes, each processed in order, one batch at a time. A hot key is in one lane and gains nothing. A slice of the range straddling two lanes is shared between them in proportion (see *Behaviour*). Changing it applies once the shard's lanes are idle. |
| Failing batch blocks its lane | ✅ | Retried with a backoff (assumed: 1 s doubling to 1 minute) until it succeeds, is older than `maxRecordAge`, has used `maxRetries`, or expires; nothing behind it in the lane is processed. |
| Maximum record age on read | ✅ | Records already older than `maxRecordAge` when their lane reaches them aren't sent (AWS: "the maximum age of a record that Lambda sends to your function"): a mapping that has fallen behind skips them, and the on-failure destination hears of each skipped run. Whole segments only. |
| Throttled or unavailable function | ✅ | Retried until the records are too old, without using up retries, and without bisecting. |
| Bisect on error | ✅ | Split in two, the halves tried in order; splitting doesn't use up retries. |
| Discard to an on-failure destination | ✅ | The stream's `discarded` port gets one record of metadata (1 KiB) per discarded batch, from every mapping reading the stream. A record over 6 MB goes there without an invocation. |
| ReportBatchItemFailures | ✅ | Checkpoints before the first failed record and retries the rest of the batch; off, the reply is a success (`itemFailuresIgnored`). With bisect too, the batch is "bisected at the returned sequence number", which is the same. |
| Poison records | ✅ | `poisonRecords`: a share of records the function can never process (the stream has no record contents, so this is set on the mapping). |
| IteratorAge | ✅ | Age of the oldest record written and not yet processed, per mapping and for the stream. |
| Tumbling windows, event filtering, starting position, provisioned pollers for Kinesis | ❌ | |
| **Generic consumers** | | |
| `core.poller` on the consumers port | 🟡 | One shared consumer, like a Kinesis Client Library application: a shard's records in order, one lease per shard; an acknowledged lease is a checkpoint, a failed or abandoned one is offered again (after 60 s if never answered). No lease table, workers or failover, and records past retention are still handed out. |
| **Account** | | |
| Shards per region, on-demand streams per account | ✅ | Account quotas and an audit (`kinesis-shards`, `kinesis-on-demand-streams`). Not enforced while running. |

## Settings

Stream (`aws.kinesis`):

| Setting | Default | Range | Kind | What it models |
| --- | --- | --- | --- | --- |
| `mode` | `provisioned` | provisioned, on-demand | | Capacity mode. |
| `shards` | 1 | 1 to 10,000 | quota | Provisioned shard count; a change while running is UpdateShardCount. |
| `retention` | 24 hours | 24 to 8,760 hours | hard | Retention period. |
| `maxRecordSize` | 1,024 KiB | 1,024 to 10,240 KiB | hard | Maximum record size (UpdateMaxRecordSize). |
| `splitDelay` | 15 minutes | 0 to 1 hour | assumed | On-demand: from a shard going over the threshold to its split. AWS: "within 15 minutes". |

Event source mapping (an edge from `consumers` to a function), besides transport's latency:

| Setting | Default | Range | Kind | What it models |
| --- | --- | --- | --- | --- |
| `batchSize` | 100 | 1 to 10,000 | hard | `BatchSize`. AWS asks for a window of at least 1 s above 10; not enforced (its own default, 100, has none). |
| `batchWindow` | 0 | 0 to 5 minutes | hard | `MaximumBatchingWindowInSeconds`. |
| `parallelization` | 1 | 1 to 10 | hard | `ParallelizationFactor`. |
| `maxRecordAge` | -1 | -1, 60 to 604,800 s | hard | `MaximumRecordAgeInSeconds`; 0 to 59 are read as 60. |
| `maxRetries` | -1 | -1 to 10,000 | hard | `MaximumRetryAttempts`. |
| `bisectOnError` | off | | | `BisectBatchOnFunctionError`. |
| `reportBatchItemFailures` | off | | | `FunctionResponseTypes: ReportBatchItemFailures`. |
| `enhancedFanOut` | off | | hard (20 a stream) | Map to a registered stream consumer. |
| `retryBackoff`, `maxRetryBackoff` | 1 s, 1 minute | | assumed | Retry schedule of a failing batch. |
| `poisonRecords` | 0 | 0 to 1 | | Share of records the function can't process. |

The `discarded` port's edges have a retry policy of their own (3 attempts, 1 s doubling to 10 s).

## Limits

| Limit | Value | Kind | Source |
| --- | --- | --- | --- |
| Write per shard | 1 MiB/s and 1,000 records/s | hard | [Quotas and limits](https://docs.aws.amazon.com/streams/latest/dev/service-sizes-and-limits.html), [PutRecords](https://docs.aws.amazon.com/kinesis/latest/APIReference/API_PutRecords.html) |
| Read per shard (shared) | 2 MiB/s, 5 GetRecords calls/s | hard | [Quotas and limits](https://docs.aws.amazon.com/streams/latest/dev/service-sizes-and-limits.html) |
| GetRecords | 10,000 records, 10 MiB; after a 10 MiB call, 5 s of throttling; after throttling, wait 1 s | hard | [GetRecords](https://docs.aws.amazon.com/kinesis/latest/APIReference/API_GetRecords.html) |
| PutRecords | 500 records, 10 MiB a request (was 5 MiB) | hard | [PutRecords](https://docs.aws.amazon.com/kinesis/latest/APIReference/API_PutRecords.html) |
| Record size | 1 MiB by default, up to 10 MiB | hard | [Large records](https://docs.aws.amazon.com/streams/latest/dev/large-records.html) |
| Retention | 24 hours by default, 24 to 8,760 hours | hard | [Retention](https://docs.aws.amazon.com/streams/latest/dev/kinesis-extended-retention.html) |
| Enhanced fan-out | 2 MiB/s per shard per consumer; 20 consumers a stream (50 with On-demand Advantage) | hard | [Enhanced fan-out](https://docs.aws.amazon.com/streams/latest/dev/enhanced-consumers.html) |
| On-demand start | 4 MB/s write, 8 MB/s read | hard | [Quotas and limits](https://docs.aws.amazon.com/streams/latest/dev/service-sizes-and-limits.html) |
| On-demand scaling | Up to double the previous 30 days' peak; a shard over 500 KB/s split within 15 minutes; throttling if traffic more than doubles within 15 minutes | hard | [Capacity modes](https://docs.aws.amazon.com/streams/latest/dev/how-do-i-size-a-stream.html) |
| On-demand ceiling per stream | 10 GB/s write (us-east-1, us-west-2, eu-west-1), 200 MB/s elsewhere | quota | [Quotas and limits](https://docs.aws.amazon.com/streams/latest/dev/service-sizes-and-limits.html) |
| On-demand streams | 50 per account | quota | [Quotas and limits](https://docs.aws.amazon.com/streams/latest/dev/service-sizes-and-limits.html) |
| Shards per region | 20,000 (us-east-1, us-west-2, eu-west-1); 6,000 (us-east-2, ap-northeast-1, ap-south-1, ap-southeast-1, ap-southeast-2, eu-central-1, eu-west-3); 1,000 elsewhere | quota | [General Reference](https://docs.aws.amazon.com/general/latest/gr/ak.html). The developer guide says "1,000 or 6,000" for other regions without naming them. |
| UpdateShardCount | at most double / half per call, 10 calls a rolling 24 hours, 10,000 shards a stream | quota | [UpdateShardCount](https://docs.aws.amazon.com/kinesis/latest/APIReference/API_UpdateShardCount.html) |
| Lambda batch | 100 by default, up to 10,000 records; 6 MB | hard | [Kinesis ESM parameters](https://docs.aws.amazon.com/lambda/latest/dg/services-kinesis-parameters.html), [with-kinesis](https://docs.aws.amazon.com/lambda/latest/dg/with-kinesis.html) |
| Lambda batching window | 0 to 300 s | hard | [CreateEventSourceMapping](https://docs.aws.amazon.com/lambda/latest/api/API_CreateEventSourceMapping.html) |
| Parallelization factor | 1 to 10 | hard | [CreateEventSourceMapping](https://docs.aws.amazon.com/lambda/latest/api/API_CreateEventSourceMapping.html) |
| Maximum record age | -1, or 60 to 604,800 s | hard | [CreateEventSourceMapping](https://docs.aws.amazon.com/lambda/latest/api/API_CreateEventSourceMapping.html) |
| Maximum retry attempts | -1 to 10,000 | hard | [CreateEventSourceMapping](https://docs.aws.amazon.com/lambda/latest/api/API_CreateEventSourceMapping.html) |
| Lambda polling | once a second per shard when caught up (standard iterator) | hard | [with-kinesis](https://docs.aws.amazon.com/lambda/latest/dg/with-kinesis.html) |

The docs write the shard limit as "1 MB" in some places and "1 MiB" in others; MiB is used.

## Behaviour

**Writes.** A record with key `k` goes to the open shard whose range `[lo, hi)` holds `k`. The shard admits it if both
of its buckets have room: bytes (refilling at 1 MiB/s, holding `max(1 MiB, maxRecordSize)`) and records (1,000/s, holding
1,000). A PutRecords of `n` records is spread over the open shards by range width, `floor(n·hi + u) − floor(n·lo + u)`
records each with `u` drawn once per call, and each shard admits or refuses its share as a whole. Refused shares are named
in `ItemFailures` (positions in shard order), so a Lambda that wrote the batch passes the failures back to its own event
source; a caller that ignores the reply has lost them, which is the classic PutRecords mistake.

**Segments.** Records appended to a shard within 200 ms share a segment, which becomes readable ("sealed") 200 ms after
its first record and never changes after that. A segment remembers its first and last arrival and birth, and how its
records spread over ten slices of the shard's key range. Inside a segment records are taken to have arrived evenly.

**On-demand.** Every second each open shard's offered traffic (accepted and throttled) is folded into a one-minute
exponential average. A shard over 500 KB/s or 500 records/s is marked, and split at its midpoint `splitDelay` later; its
children get fresh allowances. Capacity therefore settles at about twice the peak. Traffic jumping from 2 MB/s (4 shards at
the threshold) to 6 MB/s is throttled down to 4 MiB/s until the splits land, then flows.

**UpdateShardCount.** A new `shards` value starts a step towards it: `clamp(desired, ceil(n/2), 2n)`. After two minutes
the open shards close and the new ones open, each a child of the old shards it overlaps, and the next step starts if the
target isn't reached. Ten steps in 24 hours, then the change waits.

**Reading.** Each consumer has a cursor per shard. A standard reader calls GetRecords when it wants records: at once if
it is behind (Lambda) or at its cadence (Firehose: once a second), and every second when it has caught up. A call needs a
call token (5/s per shard) and a non-negative byte allowance (2 MiB/s per shard), takes whole segments up to 10,000
records and 10 MiB, and charges their bytes. A refused call waits a second. An enhanced fan-out consumer is pushed every
segment as it seals, within its own 2 MiB/s per shard, and makes no calls. A consumer reads a child shard only when it has
finished every parent.

**Lambda's mapping.** Each shard is cut into `parallelization` lanes by key: lane `j` of `p` holds the records whose key
lies in `[j/p, (j+1)/p)` of the shard's range. Lane counts are worked out from the segment's ten slices, a slice
straddling two lanes shared in proportion with rounding on the running total, so lanes always add up to the segment and a
hot key is in one lane (except in a straddling slice). Each lane forms one batch at a time: up to `batchSize` records and
6 MB, waiting up to `batchWindow` for more unless the shard is closed and read. The batch is one synchronous invocation
(`count` records, `batched`), waited for up to 15½ minutes. On success the lane moves on. On a function error: bisect (if
on and more than one record), else retry after `retryBackoff · 2^(attempts−1)` (capped), until `maxRetries`. Before any
retry, a batch older than `maxRecordAge` or than the stream's retention is discarded. A throttle or an unavailable function
is retried the same way without counting. A discarded batch sends one metadata record to the stream's `discarded` port.
Before a batch is formed, segments whose newest record is already older than `maxRecordAge` are skipped the same way, so
a mapping that is behind by more than the maximum age sheds the oldest records instead of processing them late.

**Poison records.** With `poisonRecords` = p, each lane draws the gap to its next poison record from a geometric
distribution with mean 1/p as its records are first needed, so the same record is poison on every try and after a split.
An invocation of a batch holding one returns an error, or with `reportBatchItemFailures` reports that record. Bisecting
isolates it in about `log2(batchSize)` invocations; without bisect the whole batch is discarded once retries run out.

## Connections

- **In** (`invoke`): PutRecord / PutRecords from anything. Answers success, `ItemFailures` (a PutRecords partly refused),
  `Throttled` or `Rejected`.
- **`consumers`** (`pull`): every edge is a consumer that reads every shard. To a function (or any invocable target) the
  connector is `aws.kinesis.event-source-mapping`; to a Firehose stream, Firehose's `aws.firehose.kinesis-source`;
  `core.poller` can be named on the edge for a generic consumer.
- **`discarded`** (`invoke`, many): the on-failure destination of the mappings reading this stream: an SQS queue, SNS
  topic or S3 bucket. In AWS the destination belongs to each mapping; here it is the stream's port, shared.

The CloudFormation importer doesn't read `AWS::Kinesis::Stream` yet.

## Metrics and state

Stream node, per-second rates: `incoming`, `incomingBytes` (IncomingRecords, IncomingBytes), `throttled`
(WriteProvisionedThroughputExceeded, records), `rejected`, `getRecords` (GetRecords calls), `outgoing`, `outgoingBytes`
(GetRecords.Records, .Bytes; pushed bytes too), `readThrottled` (ReadProvisionedThroughputExceeded, calls), `pushed`
(SubscribeToShardEvent.Records), `expired` (records a consumer found past retention, once per consumer), `splits`,
`reshards`, `onFailureSent`, `onFailureFailed`. Gauges: `shards` (open), `iteratorAgeMs` (GetRecords.IteratorAgeMilliseconds
of the slowest consumer), `backlog` (most records one consumer has still to process), `retained`; what the open shards can
take and serve, `writeCapacityBytes`, `writeCapacityRecords` (1 MiB/s and 1,000 records/s each), `readCapacityBytes`,
`readCapacityCalls` (2 MiB/s and five GetRecords a second each, shared by standard consumers); and the hot-spot gauges
`hottestShardLoad`, `medianShardLoad`: the traffic offered to the busiest open shard and to the median one over the last
second, as a share of a shard's write limit (bytes or records, whichever is nearer), which is what the shard-level
IncomingBytes and IncomingRecords show.

Probe: mode, open and closed shards, UpdateShardCount state, IteratorAge, backlog, retained records, totals of the counters,
each consumer (edge, enhanced fan-out, refused, IteratorAge, backlog) and the ten busiest shards (range, offered bytes and
records per second averaged over a minute).

Mapping edge, besides transport's `calls`, `ok`, `fail`, `latency`: rates `batches`, `records`, `batchRetries`, `bisected`,
`discarded`, `expired`, `itemFailures`, `itemFailuresIgnored`, `throttledInvokes`, `poisonFailures`, and Lambda's event source
mapping counts `polledEvents` (PolledEventCount: records read for it), `invokedEvents` (InvokedEventCount: records sent to
the function, a retried batch again), `failedInvokeEvents` (FailedInvokeEventCount); gauges `iteratorAge`, `backlog`,
`concurrency` (batches in flight), `maxConcurrency` (its lanes: shards read times the parallelization factor), `blocked`
(records in batches that have failed), `batchSize`.

The stream's and the mapping's dashboards (`internal/dashboard.ts`) chart these under CloudWatch's names. Not charted, because not
modelled: GetRecords.Latency, PutRecord(s).Latency (calls are answered at once), PutRecords.FailedRecords (internal
failures), SubscribeToShard.* subscription events, and per-shard series (the hot-spot gauges summarise them). Probe: shards read, in
flight, IteratorAge, backlog, blocked, enhanced fan-out and refusal, totals.

## Not yet simulated

1. **SplitShard / MergeShards on a chosen shard.** Splitting the hot shard by hand (the provisioned answer to a hot key)
   needs a control action on the stream; the shard machinery (lineage, parents before children) is already there.
2. **Starting position and late consumers.** Every consumer starts at LATEST at t = 0. A consumer added mid-run with
   TRIM_HORIZON would replay retained records; it needs edges that appear while running.
3. **Records with one key in a PutRecords.** A batch's records are spread over shards as independent keys; carrying a
   key distribution on `Message` would let a batch be hot.
4. **On-demand scale-down and On-demand Advantage** (warm throughput, 50 enhanced fan-out consumers, minimum commitment).
5. **Tumbling windows and event filtering** on the mapping; **provisioned pollers**.
6. **Lease table, worker count and failover** for a KCL consumer, and DynamoDB checkpoint costs.
7. **Availability zones.** Kinesis replicates across three zones and survives the loss of one; when the engine has zones a
   zonal outage should be absorbed (no effect) and a regional one take the stream down, which an `Outage` on the node does
   today.

## Assumptions

| Number | Value | Why |
| --- | --- | --- |
| Segment span and seal delay | 200 ms | Bounds memory; gives about 100 ms propagation on average, between AWS's 70 ms (enhanced fan-out) and 200 ms (one GetRecords reader). |
| Write burst | one second of the shard's limits, or one maximum-size record | AWS describes a "burst capacity" for large records without sizing it. |
| On-demand traffic window | one-minute exponential average | AWS says it monitors traffic per shard; no window is published. |
| On-demand record threshold | 500 records/s | AWS publishes 500 KB/s only; half the record limit by analogy. |
| On-demand split delay | 15 minutes | AWS: "within 15 minutes". |
| UpdateShardCount step | 2 minutes | AWS: "a few minutes". |
| Mapping retry backoff | 1 s doubling to 1 minute | AWS doesn't publish it. |
| Mapping invocation wait | 15½ minutes | The function's own 15-minute timeout ends a batch first. |
| On-failure record size | 1 KiB | The metadata document (the records stay in the stream). |
| Generic consumer lease | 60 s | How long an unanswered lease is held before its records are offered again. |
| Key slices per segment | 10 | Enough to split a shard into 1 to 10 lanes by key. |

## References

- [Kinesis Data Streams quotas and limits](https://docs.aws.amazon.com/streams/latest/dev/service-sizes-and-limits.html)
- [Choose the capacity mode](https://docs.aws.amazon.com/streams/latest/dev/how-do-i-size-a-stream.html)
- [Large records](https://docs.aws.amazon.com/streams/latest/dev/large-records.html)
- [Retention](https://docs.aws.amazon.com/streams/latest/dev/kinesis-extended-retention.html)
- [Enhanced fan-out consumers](https://docs.aws.amazon.com/streams/latest/dev/enhanced-consumers.html)
- [CloudWatch metrics](https://docs.aws.amazon.com/streams/latest/dev/monitoring-with-cloudwatch.html)
- [PutRecords](https://docs.aws.amazon.com/kinesis/latest/APIReference/API_PutRecords.html), [GetRecords](https://docs.aws.amazon.com/kinesis/latest/APIReference/API_GetRecords.html), [UpdateShardCount](https://docs.aws.amazon.com/kinesis/latest/APIReference/API_UpdateShardCount.html)
- [Kinesis Data Streams endpoints and quotas (General Reference)](https://docs.aws.amazon.com/general/latest/gr/ak.html)
- Lambda: [Using Lambda with Kinesis](https://docs.aws.amazon.com/lambda/latest/dg/with-kinesis.html), [parameters](https://docs.aws.amazon.com/lambda/latest/dg/services-kinesis-parameters.html), [on-failure destinations and error handling](https://docs.aws.amazon.com/lambda/latest/dg/kinesis-on-failure-destination.html), [partial batch response](https://docs.aws.amazon.com/lambda/latest/dg/services-kinesis-batchfailurereporting.html), [CreateEventSourceMapping](https://docs.aws.amazon.com/lambda/latest/api/API_CreateEventSourceMapping.html)
