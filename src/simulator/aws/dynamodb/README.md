# DynamoDB (`aws.dynamodb`)

DynamoDB is a key-value and document store that you size by throughput rather than by machines. You either provision read and write capacity units, or let on-demand mode scale the table for you. Every request costs units by item size and consistency, every item lives on a partition that serves at most 3,000 read and 1,000 write units a second, and a request that does not fit is throttled. This component lets you learn where that bites: a hot key on a huge table, a launch that outruns on-demand scaling, an under-provisioned global secondary index that throttles writes to a table with capacity to spare, a poison record that blocks a stream shard for a day, TTL and replication that quietly spend someone else's capacity.

## Coverage

| Feature | Status | Notes |
| --- | --- | --- |
| **Requests** | | |
| Read and write capacity units | ✅ | 4 KB reads and 1 KB writes, rounded up per item; eventually consistent 0.5, strong 1, transactional 2; transactional writes cost 2 |
| Item size limit | ✅ | Over 400 KB is `Rejected` (ValidationException) |
| Batch operations | 🟡 | A message with `count` > 1 is a batch, charged per item. No `UnprocessedItems`/`UnprocessedKeys`: a batch is all-or-nothing. The 25/100 item and 16 MB batch limits are not enforced (more records stand for several calls) |
| Transactions | 🟡 | Doubled cost, 100 items / 4 MB limit enforced. No conflicts (`TransactionCanceledException`), no idempotency token, no cost for a cancelled transaction beyond the condition model |
| Conditional writes | ✅ | `conditionFailureRate`: the write costs its units, changes nothing, fails `Rejected` (not retryable) |
| Query, Scan, item collections | ❌ | A read is one request of `bytes`; there is no 1 MB result page, no scan |
| Latency | 🟡 | One lognormal distribution (assumed); no difference by consistency, size or transaction |
| **Throttling** | | |
| Provisioned throughput and burst | ✅ | Token bucket of `burstSeconds` (up to 300) of capacity; starts full. Refill rule is not published |
| Hard per-partition limit, hot keys | ✅ | 3,000 / 1,000 units a second per partition, checked before the table's own bucket; a refused request costs nothing |
| Adaptive capacity | 🟡 | A partition may use more than its even share up to the 3,000/1,000 ceiling and the table's total. Isolating a hot item by splitting its partition is not modelled; partition count and split timing are assumed |
| Failure taxonomy | ✅ | `Throttled` with the AWS exception and `ThrottlingReason` in the reason text: `ProvisionedThroughputExceededException`, `ThrottlingException`, `RequestLimitExceeded`; table vs index, key range vs provisioned vs on-demand maximum vs account limit |
| Per-table and per-account quotas | ✅ | Account quotas for per-table (also per index) and account totals, indexes included; later tables get what is left, in creation order |
| Table, index and account counts | 🟡 | Quota fields and audit warnings; tables over the limit still run |
| **Scaling** | | |
| On-demand: new-table baseline and doubling | ✅ | 4,000 writes / 12,000 reads, then twice the previous peak; the peak is never forgotten |
| On-demand: scale-out beyond double | 🟡 | One doubling per `scaleInterval` (30 minutes by default). AWS publishes no fixed step, only "throttling can occur within 30 minutes" |
| Warm throughput (pre-warming) | ✅ | `onDemand.warmReadUnits/warmWriteUnits` raise the baseline |
| Maximum throughput (on-demand) | ✅ | `ThrottlingException`; best-effort overshoot via burst is not modelled |
| Switching mode, decreasing capacity limits | ❌ | Not limited (4 switches and 27 decreases a day in AWS); a switch keeps the peak history and the table's place in the account ledger |
| **Indexes** | | |
| Global secondary indexes | ✅ | Own capacity (provisioned) or own on-demand scaling; table writes cost every index; an index that can't absorb the write throttles the table (back-pressure); queries on an index use index capacity; hot index partitions. All indexes are alike |
| GSI propagation delay | ❌ | Index writes are charged and admitted with the table write; the eventual-consistency lag is not modelled |
| Local secondary indexes | 🟡 | Writes also cost the table's capacity. Reads are priced as table reads; the 10 GB item collection limit is documentation only |
| **Streams** | | |
| Stream records and ordering | ✅ | One record per change, FIFO per shard (so ordered per item), shard per table partition, once per consumer |
| 24-hour retention | ✅ | Records older than 24 h are trimmed; a consumer that falls behind loses them (`streamExpired`) |
| Consumers (event source mapping) | 🟡 | The port polls and calls the consumer: batch size, batching window, concurrent batches per shard, retries, record age, bisect, on-failure destination. The Lambda component has no event source mapping for streams, so filters, partial batch response and tumbling windows are missing |
| Blocked shards | ✅ | A failing batch is retried and nothing behind it in the shard is read |
| Shard lineage and splits, reader limit | ❌ | The 2-readers-per-shard limit is documented, not enforced |
| TTL deletes | ✅ | No table write capacity, index capacity used, in the stream, replicated |
| **Replication** | | |
| Global tables (eventual consistency) | 🟡 | `replicas` port: each write reaches the other tables after a lag, as an ordinary write that costs there; no echo. No conflict resolution, no strongly consistent mode (MRSC), no transactions across regions |
| **Account** | | |
| Account totals and the audit | ✅ | Indexes counted; tables, index count and narrow-index warnings |
| **Not modelled** | ❌ | Table classes (cost only), DAX, backups, point-in-time recovery, exports/imports, PartiQL, Contributor Insights, control-plane limits |

## Settings

Names marked * are stable: designs, examples and the CloudFormation importer use them.

| Path | Default | Range | Kind | What it models |
| --- | --- | --- | --- | --- |
| `mode`* | `provisioned` | provisioned, on-demand | | Capacity mode |
| `readCapacity`* | 100 RCU | 1 to 10,000,000 | quota | Provisioned reads; capped by the per-table and account quotas |
| `writeCapacity`* | 100 WCU | 1 to 10,000,000 | quota | Provisioned writes |
| `partitions`* | 0 | 0 to 10,000 | assumed | Partitions; 0 derives `ceil(max(read/3000, write/1000))` from capacity |
| `readConsistency`* | `eventual` | eventual, strong, transactional | | Read cost multiplier |
| `writeMode`* | `standard` | standard, transactional | | Transactional writes cost twice |
| `burstSeconds`* | 300 s | 0 to 300 | hard | Banked capacity |
| `latency`* | 5 ms, cv 0.5 | | assumed | Request latency |
| `conditionFailureRate` | 0 | 0 to 1 | | Share of writes whose condition is false |
| `onDemand.maxReadUnits`, `maxWriteUnits` | 0 (none) | 0 to 10,000,000 | quota | On-demand maximum throughput |
| `onDemand.warmReadUnits`, `warmWriteUnits` | 0 (AWS default) | 0 to 10,000,000 | quota | Pre-warmed baseline |
| `onDemand.scaleInterval` | 30 minutes | 1 s to 24 h | assumed | One doubling of the ceiling per interval |
| `gsi.count` | 0 | 0 to 100 | quota | Global secondary indexes (the account quota, 20, caps it) |
| `gsi.readCapacity`, `writeCapacity` | 0 (table's) | 0 to 10,000,000 | quota | Provisioned capacity of each index |
| `gsi.maxReadUnits`, `maxWriteUnits` | 0 (none) | 0 to 10,000,000 | quota | On-demand maximum per index |
| `gsi.entryBytes` | 0 (whole item) | 0 to 409,600 | | Index entry size |
| `gsi.writeShare` | 1 | 0 to 1 | | Share of writes that touch each index |
| `gsi.keyChangeShare` | 0 | 0 to 1 | | Share of indexed writes that move the entry (two index writes) |
| `gsi.readShare` | 0 | 0 to 1 | | Share of reads that are index queries |
| `gsi.keyValues` | 0 | 0 to 1,000,000 | | Distinct index partition-key values; small numbers make hot index partitions |
| `lsi.count` | 0 | 0 to 5 | hard | Local secondary indexes |
| `lsi.entryBytes`, `lsi.writeShare` | 0, 1 | | | As for GSIs |
| `ttl.expiresPerSecond` | 0 | 0 to 1,000,000 | | Items deleted by TTL per second |
| `ttl.itemBytes` | 1,024 | 1 to 409,600 | assumed | Size of an expiring item |
| `stream.view` | `new-and-old` | off, keys, new, old, new-and-old | | StreamViewType; sets record size |
| `stream.propagation` | 100 ms, cv 0.5 | | assumed | Write to readable stream record |
| `replication.lag` | 800 ms, cv 0.6 | | assumed | Write to replica, before network latency |

Port settings on each `stream` edge (the event source mapping): `batchSize` (100; 1 to 10,000, hard), `batchWindow` (0 to 5 minutes, hard), `parallelization` (1; 1 to 10, hard), `maxRecordAge` (-1 = infinite; 60 to 604,800 s, hard), `maxRetries` (-1 = infinite; 0 to 10,000, hard), `bisectOnError` (false), `retryBackoff` (1 s, assumed), `maxRetryBackoff` (1 minute, assumed), `timeout` (5 minutes). `replicas` and `discarded` edges carry a retry policy only.

Account quotas (`Quotas.ts`): `dynamodbTableReadUnits` and `dynamodbTableWriteUnits` (40,000), `dynamodbAccountReadUnits` and `dynamodbAccountWriteUnits` (80,000), `dynamodbTables` (2,500), `dynamodbIndexesPerTable` (20).

## Limits

| Limit | Value | Kind | Source |
| --- | --- | --- | --- |
| Per-partition throughput | 3,000 read units, 1,000 write units a second | hard | [bp-partition-key-design](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-design.html), [burst-adaptive-capacity](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/burst-adaptive-capacity.html) |
| Item size | 400 KB (attribute names and values) | hard | [Constraints](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html) |
| Unit sizes | 4 KB read, 1 KB write; transactional x2 | hard | [read-write-operations](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/read-write-operations.html) |
| Batch | BatchGetItem 100 items, BatchWriteItem 25, 16 MB | hard | [Constraints](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html) |
| Transaction | 100 items, 4 MB | hard | [Constraints](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html), [transaction-apis](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html) |
| Burst capacity | up to 300 s of unused capacity ("might change") | hard (refill assumed) | [burst-adaptive-capacity](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/burst-adaptive-capacity.html) |
| New on-demand table | 4,000 writes, 12,000 reads a second; then 2x previous peak | hard | [on-demand-capacity-mode](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/on-demand-capacity-mode.html), [warm-throughput](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/warm-throughput.html) |
| Growth beyond double the previous peak | throttling can occur within 30 minutes | quota-like guidance; step assumed | [on-demand-capacity-mode](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/on-demand-capacity-mode.html) |
| Throughput per table or index | 40,000 read and 40,000 write units (provisioned and on-demand) | quota | [ServiceQuotas](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ServiceQuotas.html) |
| Throughput per account, provisioned | 80,000 read and 80,000 write units, tables and indexes summed; on-demand tables don't count | quota | [ServiceQuotas](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ServiceQuotas.html) |
| Tables per region | 2,500 (10,000 on request) | quota | [ServiceQuotas](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ServiceQuotas.html) |
| Global secondary indexes per table | 20 | quota | [ServiceQuotas](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ServiceQuotas.html) |
| Local secondary indexes per table | 5; 10 GB per item collection | hard | [ServiceQuotas](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ServiceQuotas.html), [LSI](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/LSI.html) |
| Provisioned decreases | 4 at the start of a day, +1 an hour (27 a day); mode switches 4 per 24 h | hard (not enforced) | [ServiceQuotas](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ServiceQuotas.html), [Constraints](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html) |
| Stream retention | 24 hours; each record once, ordered per item | hard | [Streams](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.html) |
| Stream readers | 2 per shard (1 on global tables) | hard (not enforced) | [Streams](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.html) |
| GetRecords | 1,000 records or 1 MB | hard (not enforced) | [GetRecords](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_streams_GetRecords.html) |
| Lambda stream polling | 4 times a second per shard; batch 100 default, 10,000 max; window 0 to 5 minutes; concurrency 1 to 10 per shard; payload 6 MB | hard | [with-ddb](https://docs.aws.amazon.com/lambda/latest/dg/with-ddb.html), [services-ddb-params](https://docs.aws.amazon.com/lambda/latest/dg/services-ddb-params.html) |
| TTL | deletes within a few days of expiry, using no write capacity | behaviour | [TTL](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html) |
| Global table replication | typically a second or less (MREC) | behaviour; distribution assumed | [V2globaltables_HowItWorks](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/V2globaltables_HowItWorks.html) |
| Latency | "single-digit milliseconds"; no percentiles | assumed | [Introduction](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Introduction.html) |

Pages that differ, or that the code had wrong: the earlier model forgot the previous on-demand peak after 30 minutes and doubled it every second; AWS keeps it ("you can instantly achieve the same throughput again") and puts the 30 minutes on how quickly growth beyond double may be spaced. The account quota counts global secondary indexes as well as tables, and the per-table quota applies to each index separately; `docs/AWS-LIMITS.md` says "all tables". AWS defines the account quota only for provisioned tables, so on-demand tables never count against it.

## Behaviour

**Units.** A request of `count` items and `bytes` bytes costs `count x ceil(bytes/count / unit)` units, each item at least one: reads per 4 KB times 0.5, 1 or 2; writes per 1 KB times 1 or 2. This is BatchGetItem and BatchWriteItem accounting (each item rounded, then added). An index Query is one read: entries are added up and rounded once.

**Admission.** A request has to fit three things: the bucket of the partition its key lands on (`key` x partitions), the table's bucket, and, for writes, the bucket and partition of every global secondary index. All are checked first, then all are taken, so a request refused anywhere costs nothing anywhere (the earlier code spent the partition's tokens when the table then refused). A provisioned bucket refills at the provisioned rate and holds `burstSeconds` of it; an on-demand bucket holds a tenth of a second.

**Partitions.** `partitions` is `ceil(max(read/3000, write/1000))` unless set. The table's key space is spread evenly over them, so a hot key (the client's `hotKeys`) keeps landing on one partition and is held to its 1,000 writes (or 3,000 reads) a second however big the table. A fixed `partitions` of 1 makes one big bucket.

**Provisioned capacity and the account.** The region's ledger holds each provisioned table together with its indexes (each clamped to the per-table quota). A table gets what the account total has left after the tables created before it; on-demand tables hold zero but keep their place. The share is recomputed when settings, quotas or the ledger change; an idle table notices because its gauges are read every frame.

**On-demand.** The ceiling is `max(baseline, 2 x counted)` clamped to the per-table quota and the optional maximum, where the baseline is 4,000 writes / 12,000 reads (or the pre-warmed value). `counted` follows the highest units used in any one second (`peak`, never forgotten), but may at most double once per `scaleInterval`. A table pinned at its ceiling therefore doubles every interval, and a table that has been there before is instantly back. Throttles read `ThrottlingException` (still scaling, or the maximum) or `RequestLimitExceeded` (the per-table quota). Consumption is counted lazily, so an idle table costs nothing.

**Global secondary indexes.** Each write costs every index `ceil(entry/1 KB) x writeShare x (1 + keyChangeShare)` units, as an expected value (no per-write randomness). An index has its own buckets and partitions; its partition key is a fixed function of the table key, so hot table keys stay hot on the index, and `keyValues` limits how many index partitions exist at all. If any index has no room the table write is throttled with the index named in the reason: back-pressure. Index queries (`readShare` of reads) use index read capacity, half a unit per 4 KB, never the table's. Index writes are charged immediately: AWS's propagation lag is not modelled, so the back-pressure is also immediate.

**Streams.** While at least one consumer is wired to the `stream` port and `stream.view` is not `off`, every successful write appends a record (size by view) to the shard of the partition it landed on, readable after the stream delay. Records are kept as segments (a shard's records within 100 ms), so memory is a few words per tenth of a second per shard, and freed once every consumer has read them. Each consumer has its own cursor per shard. When idle it notices new records at its next poll (within 250 ms); when it has just finished a batch it reads again at once. A batch holds up to `batchSize` records within 6 MB; with a window it waits for the window or a full batch. It is sent to the consumer as a synchronous call. If that fails, the same batch is retried after a backoff that doubles up to a cap, and nothing behind it in that lane is read; the shard has `parallelization` lanes. A batch is dropped (counted, and reported to the `discarded` port) when it is older than `maxRecordAge`, has used up `maxRetries`, or is 24 hours old. With `bisectOnError` a failing batch is split in two without using a retry. A consumer that is behind by more than 24 hours loses the records (`expired`).

**TTL.** `ttl.expiresPerSecond` items a second are deleted: no table write units, but one write per index (they wait when an index has no room), a stream record each, and a replicated delete each.

**Global tables.** Wire the table's `replicas` port to the other tables (and theirs back). After the replication lag and the edge's network time each write arrives as a plain write, charged to the replica's capacity (it can throttle there and is retried with backoff); it is marked so it is not replicated onward. Writes at home never wait for replicas.

**Where it departs from AWS.** Partition counts and splits, the burst refill, the on-demand scale-out step, the transactional and index latency, stream propagation and replication lag are assumptions. A batch is all-or-nothing. GSIs are alike, and index back-pressure is synchronous.

## Connections

- `in` (any caller): reads and writes by the edge's `request.operation`, `payload`, hot key and `count`. Failures: `Throttled` (capacity: the reason names the AWS exception and throttling reason), `Rejected` (item or transaction too large, failed condition: retrying can't help).
- `out`: unused; kept so designs that have it still load.
- `stream`: change records for consumers (a Lambda, or anything). Each edge is one event source mapping; its settings are above. A plain edge to an `aws.lambda` works: the Lambda sees synchronous batch invocations with `count` records, `bytes` of payload, `group` = the shard.
- `replicas`: other tables of the same global table. The receiving table needs the reverse edge for writes there to replicate back.
- `discarded`: gets one small asynchronous message per dropped batch (AWS sends metadata, not the records), for an SQS queue or SNS topic.

CloudFormation import (`importers/internal/cloudformation/dynamodb.ts`; `AWS::DynamoDB::Table`, `AWS::DynamoDB::GlobalTable` and SAM `SimpleTable`, which keeps its default 5/5 capacity):

- **Capacity:** `BillingMode: PAY_PER_REQUEST` gives `mode: on-demand`; otherwise `ProvisionedThroughput` gives `mode: provisioned`, `readCapacity`, `writeCapacity`. `OnDemandThroughput.MaxReadRequestUnits/MaxWriteRequestUnits` give `onDemand.maxReadUnits/maxWriteUnits` (-1 is 0, no limit); `WarmThroughput.ReadUnitsPerSecond/WriteUnitsPerSecond` give `onDemand.warmReadUnits/warmWriteUnits`.
- **Indexes:** `GlobalSecondaryIndexes` give `gsi.count`, and the component models them alike, so `gsi.readCapacity/writeCapacity` (provisioned) and `gsi.maxReadUnits/maxWriteUnits` (on-demand) take the largest index's values; indexes that differ are reported. `gsi.entryBytes` is 128 when every index is `KEYS_ONLY`, and stays 0 (the whole item) for `ALL`; an `INCLUDE` projection is charged as whole items and reported. `LocalSecondaryIndexes` give `lsi.count`.
- **Stream:** `StreamSpecification.StreamViewType` gives `stream.view` (KEYS_ONLY keys, NEW_IMAGE new, OLD_IMAGE old, NEW_AND_OLD_IMAGES new-and-old). For every enabled `AWS::Lambda::EventSourceMapping` (or SAM `DynamoDB` event) on the table's stream, an edge from the `stream` port to the function carries `BatchSize`, `MaximumBatchingWindowInSeconds`, `ParallelizationFactor`, `MaximumRecordAgeInSeconds`, `MaximumRetryAttempts`, `BisectBatchOnFunctionError` as `batchSize`, `batchWindow`, `parallelization`, `maxRecordAge`, `maxRetries`, `bisectOnError` (values outside the component's ranges are clamped and reported), and `DestinationConfig.OnFailure` gives an edge from `discarded` to that queue or topic (anything else, or a destination outside the template, is reported). `ReportBatchItemFailures`, `FilterCriteria` and `TumblingWindowInSeconds` are reported as not simulated. A stream nothing in the template reads is reported, since none is produced.
- **TTL is not representable:** `TimeToLiveSpecification` can't give how many items expire each second, so `ttl.expiresPerSecond` stays 0 and the import reports it (set it to model the deletes). `TableClass` has no behaviour and is not read.
- **Global tables:** `Replicas` give one table per known region, each in its region's box, with `replicas` edges between every pair; a region the simulator doesn't know is left out and reported. The table in the stack's region is the one the template's functions talk to (the first replica stands in, with a report, if the stack's region isn't listed). Write capacity comes from `WriteProvisionedThroughputSettings` and read capacity per replica from `ReadProvisionedThroughputSettings`; autoscaling isn't simulated, so the most it allows is used and reported. A table nothing writes to gets an assumed writer (replica copies don't: replication feeds them).

## Metrics and state

Counters (per-second rates in frames): `consumedRead`, `consumedWrite` (capacity units), `consumedIndexRead`, `consumedIndexWrite`, `throttledPartition`, `throttledIndex`, `conditionFailed`, `ttlDeleted`, `streamAppended`, `streamDelivered`, `streamBatches`, `streamFailedBatches`, `streamDiscarded`, `streamExpired`, `replicated`, `replicationFailed` (records); plus the usual `in`, `ok`, `fail.<Tag>`, `latency`. Sampler `replicationLag` (ms). Gauges: `readTokens`, `writeTokens` (banked burst), `readCapacity`, `writeCapacity` (what the table can serve now; on-demand: scaled out so far), `indexWriteTokens` (fewest in any index), `streamBacklog`, `streamBlocked` (records in failing batches), `iteratorAge` (ms), `replicating`.

Probe `state`: `mode`, `readCapacity`, `writeCapacity`, `partitions`, `readTokens`, `writeTokens`, `served`, `throttled` (reads, writes, partition, index), `consumed` (units), `peak`, `conditionFailed`, `lastThrottle` (the reason text of the latest throttle), `indexes` (count, capacities, lowest write tokens, units consumed), `ttl`, `stream` (active, consumers, shards, segments, appended, delivered, backlog, blocked, iteratorAge, discarded, expired), `replication`.

## Not yet simulated

1. Partial batch results (`UnprocessedItems`, `UnprocessedKeys`): it takes a way for a call to succeed with a remainder, so that the sender retries only that. Today a batch fails whole.
2. Transaction conflicts and idempotency tokens: needs item identity, which a message doesn't carry.
3. Scans and queries with result pages (1 MB) and filtering: needs a result-size model; a read is one request.
4. Event source mapping for streams in the Lambda component: filters, partial batch response (`ReportBatchItemFailures`), tumbling windows, per-key grouping when `ParallelizationFactor` > 1, the "more than two readers" throttle. The `stream` port polls on Lambda's behalf until it exists.
5. GSI propagation lag and index creation back-fill (a new index throttles the table while it fills).
6. Indexes that differ from each other (today all alike), strongly consistent LSI reads and fetches of non-projected attributes.
7. Adaptive capacity isolation and partition splitting over time, and the burst refill rule (the bucket starts full).
8. Provisioned scale-up rate, mode-switch and decrease limits, auto scaling, reserved capacity.
9. Global table conflict resolution, strong consistency (MRSC), regional isolation.
10. Latency that depends on size, consistency, transactions and indexes.
11. DAX, backups, exports, PartiQL, Contributor Insights, table classes.

## Assumptions

- Latency 5 ms, cv 0.5 (AWS: "single-digit milliseconds").
- Partitions = `ceil(max(read/3000, write/1000))`; keys spread evenly (AWS publishes neither count nor split timing).
- On-demand smoothing of a tenth of a second instead of burst capacity; every index scales from the same new-table baseline as a table (AWS says warm throughput exists for tables and indexes, not the starting values for indexes).
- On-demand growth beyond double: one doubling per `scaleInterval`, 30 minutes (from AWS's "within 30 minutes" guidance).
- The burst bucket starts full and refills at the rate.
- Index write cost is the expected value, and transactional writes don't double index writes.
- A stream record carries the whole item for `new` or `old`, twice it for `new-and-old`, 128 bytes for `keys`.
- Stream propagation 100 ms (cv 0.5), replication lag 800 ms (cv 0.6), retry backoff 1 s doubling to 1 minute, TTL item size 1 KB, consumer timeout 5 minutes.
- Records within 100 ms of each other in a shard become readable together.

## References

- https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ServiceQuotas.html
- https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html
- https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/on-demand-capacity-mode.html
- https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/on-demand-capacity-mode-max-throughput.html
- https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/warm-throughput.html
- https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/burst-adaptive-capacity.html
- https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-design.html
- https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/read-write-operations.html
- https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html
- https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/gsi-throttling.html
- https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/LSI.html
- https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.html
- https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html
- https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/time-to-live-ttl-streams.html
- https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/V2globaltables_HowItWorks.html
- https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html
- https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Programming.Errors.html
- https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TroubleshootingThrottling.html
- https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.TableClasses.html
- https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_streams_GetRecords.html
- https://docs.aws.amazon.com/lambda/latest/dg/with-ddb.html
- https://docs.aws.amazon.com/lambda/latest/dg/services-ddb-params.html
- https://docs.aws.amazon.com/lambda/latest/dg/services-dynamodb-errors.html
