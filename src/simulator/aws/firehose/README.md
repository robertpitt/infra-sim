# Data Firehose (`aws.firehose`)

Amazon Data Firehose (formerly Kinesis Data Firehose) takes a stream of records and lands it somewhere, in batches: it
buffers records until a size or an interval is reached, whichever comes first, then writes the buffer as one object to
Amazon S3 (or one request to an HTTP endpoint or a partner), optionally passing records through a transformation Lambda on
the way, and retries a failing destination for a long time before giving up. Records arrive by Direct PUT (PutRecord,
PutRecordBatch) or from a Kinesis data stream it reads. This component lets you learn what buffering does to object counts
and data freshness (small buffers make many small objects, every source shard has its own buffer), where the Direct PUT
quotas throttle and why reading from Kinesis instead lifts them, what a slow or failing transformation costs, and what
happens to data while the destination is down.

## Coverage

| Feature | Status | Notes |
| --- | --- | --- |
| **Ingestion** | | |
| Direct PUT: PutRecord, PutRecordBatch (500 records, 4 MiB), 1,000 KiB records | ✅ | A message is one call carrying `count` records; over the limits it is `Rejected`. |
| Direct PUT quotas per stream, by region | ✅ | Requests, records and MiB a second, all three checked (one-second buckets); past any, `Throttled` (ThrottledRecords). Defaults by region in the account quotas; raising the MiB/s raises the other two in proportion, as AWS does. |
| Automatic Direct PUT limit increase | ❌ | AWS raises a throttled stream's limit "until the throttling is contained" with no published rate; the quota stays where it is set. |
| Kinesis data stream as source | ✅ | Wiring a stream's `consumers` port to Firehose puts the `aws.firehose.kinesis-source` connector on the edge: GetRecords once a second per shard from LATEST, sharing the shard's read limits; no Firehose throughput quota. Once fed by a stream, Direct PUT is refused (PutRecord is disabled on such a stream). |
| MSK source, CloudWatch Logs, IoT, agent | ❌ | Any caller is a Direct PUT. |
| **Buffering** | | |
| Size or interval, whichever first | ✅ | `bufferSize` (1-128 MiB, 5) and `bufferInterval` (0-900 s, 300). The interval counts from a buffer's first record. |
| Buffer per source shard | ✅ | AWS applies the hints per shard: a stream read from four shards keeps four buffers and makes four times the objects at a trickle. |
| Zero buffering | 🟡 | An interval of 0 flushes once a second (AWS: "within a few seconds"). |
| Raising the buffer when delivery falls behind | ✅ | While a delivery is failing, buffers that are ready are merged into the waiting one, up to 128 MiB (64 for HTTP). |
| Multipart uploads below 60 s, dynamic partitioning, format conversion, compression, decompression | ❌ | See *Not yet simulated*. |
| **Delivery** | | |
| One object per buffer to S3 | ✅ | The `out` port gets a message with `count: 1` and the buffer's bytes, so S3 counts one PUT; its key is the stream's own (one time-based prefix). |
| HTTP endpoint destination | ✅ | `destination: http`: 64 MiB and 10,000 records a request at most; 3 minutes to answer (the edge's timeout). |
| S3 retries for 24 hours (Direct PUT), indefinitely (Kinesis source) | ✅ | Retried on Firehose's schedule (1 s doubling to 2 minutes, ±15%). A Direct PUT stream loses data still undelivered after 24 hours (`lost`). A Kinesis-sourced stream stops reading the failing shard meanwhile, so records wait in the stream (until its retention). |
| HTTP retry duration, then S3 backup | ✅ | `retryDuration` (0-7,200 s): retried that long after the first failure, then the data goes to the `backup` port. A 413 (`Rejected`) is permanent and not backed up. |
| Deliveries in order, one at a time per buffer | ✅ | An assumption: AWS doesn't say how many it runs at once. |
| Duplicates after a timed-out delivery | ❌ | AWS can deliver twice to non-S3 destinations; not modelled. |
| **Transformation** | | |
| Lambda per batch (0.2-3 MB, 0-900 s) | ✅ | Wire a function to the `transform` port. Firehose buffers for it, invokes it synchronously with each batch (`batched`, `count` records), up to 5 at once per buffer, waiting up to 5 minutes. |
| Retries, then the error output | ✅ | A failed invocation is retried `retries` times (3), then its records count as `processingFailed` and are written aside: to the S3 destination's processing-failed prefix (an object on `out`), or to the `backup` bucket for HTTP. |
| ProcessingFailed records | ✅ | Records a function reports failed (`ItemFailures`, e.g. a Lambda with `batch.errors: report`) are written aside; the rest go on. |
| Output size | ✅ | `transform.outputRatio` (assumed 1): bytes out per byte in. |
| Dropped records (status `Dropped`) | ❌ | |
| **Metrics** | | |
| IncomingRecords/Bytes, ThrottledRecords, DeliveryToS3.Records/Bytes/Success, DataFreshness | ✅ | |
| BackupToS3, ExecuteProcessing, SucceedProcessing | 🟡 | `backedUp`, `transformInvocations`, `transformFailed`, `transformedRecords`; no durations of their own (the function's metrics have them). |
| **Account** | | |
| Firehose streams per region | ✅ | Account quota and audit. |

## Settings

| Setting | Default | Range | Kind | What it models |
| --- | --- | --- | --- | --- |
| `destination` | `s3` | s3, http | | What the `out` port is. |
| `bufferSize` | 5 MiB | 1 to 128 MiB (HTTP: 64) | hard | `BufferingHints.SizeInMBs`. |
| `bufferInterval` | 300 s | 0 to 900 s | hard | `BufferingHints.IntervalInSeconds`. AWS's default is 60 s for HTTP endpoints. |
| `retryDuration` | 300 s | 0 to 7,200 s | hard | HTTP endpoint retry duration. AWS gives no default for HTTP endpoints; 300 s is its OpenSearch default. |
| `transform.bufferSize` | 1 MB | 0.2 to 3 MB | hard | Lambda processor `BufferSizeInMBs`. |
| `transform.bufferInterval` | 60 s | 0 to 900 s | hard | Lambda processor `BufferIntervalInSeconds`. |
| `transform.retries` | 3 | 0 to 10 | | `NumberOfRetries`. AWS publishes the default only; 10 is this simulator's cap. |
| `transform.outputRatio` | 1 | 0 to 10 | assumed | Size of what the function returns per byte given. |

Edge settings: the `out` port's `timeout` defaults to 3 minutes (what an HTTP endpoint gets), the `transform` port's to
5 minutes (the most Firehose allows). Leave the edges' own retries at one attempt: Firehose retries on its own schedule.

Account quotas (per region): `firehoseDirectPutMiBps` (5 MiB/s in us-east-1, us-west-2, eu-west-1; 1 elsewhere),
`firehoseStreams`.

## Limits

| Limit | Value | Kind | Source |
| --- | --- | --- | --- |
| Direct PUT throughput per stream | 5 MiB/s, 500,000 records/s, 2,000 requests/s in us-east-1, us-west-2, eu-west-1; 1 MiB/s, 100,000, 1,000 elsewhere; raised in proportion | quota | [Quota](https://docs.aws.amazon.com/firehose/latest/dev/limits.html), [General Reference](https://docs.aws.amazon.com/general/latest/gr/fh.html) (lists them as not adjustable; the developer guide says they can be raised) |
| Kinesis source | Direct PUT quotas don't apply; scales with no limit | hard | [Quota](https://docs.aws.amazon.com/firehose/latest/dev/limits.html) |
| Record size | 1,000 KiB | hard | [Quota](https://docs.aws.amazon.com/firehose/latest/dev/limits.html) |
| PutRecordBatch | 500 records or 4 MiB | hard | [Quota](https://docs.aws.amazon.com/firehose/latest/dev/limits.html) |
| Buffer size, S3 | 1 to 128 MiB, default 5 | hard | [Buffering hints](https://docs.aws.amazon.com/firehose/latest/dev/create-configure-backup.html#buffering-hints), [BufferingHints](https://docs.aws.amazon.com/firehose/latest/APIReference/API_BufferingHints.html) |
| Buffer interval | 0 to 900 s, default 300 (S3), 60 (HTTP endpoint) | hard | [Buffering hints](https://docs.aws.amazon.com/firehose/latest/dev/create-configure-backup.html#buffering-hints). The quota page still says 60-900 s; the newer buffering table and API say 0-900. |
| Buffer size, HTTP endpoint | 1 to 64 MiB, default 5 | hard | [Buffering hints](https://docs.aws.amazon.com/firehose/latest/dev/create-configure-backup.html#buffering-hints) |
| Undelivered data, Direct PUT | 24 hours | hard | [Quota](https://docs.aws.amazon.com/firehose/latest/dev/limits.html), [Handle delivery failures](https://docs.aws.amazon.com/firehose/latest/dev/retry.html) |
| S3 retries | up to 24 h (Direct PUT); indefinitely within the stream's retention (Kinesis source) | hard | [Handle delivery failures](https://docs.aws.amazon.com/firehose/latest/dev/retry.html) |
| HTTP endpoint | 3 minutes to answer; retry 1 s doubling, capped at 2 minutes, ±15%; 413 is permanent; 64 MiB, 10,000 records a request | hard | [HTTP request and response](https://docs.aws.amazon.com/firehose/latest/dev/httpdeliveryrequestresponse.html) |
| HTTP retry duration | 0 to 7,200 s | hard | [HttpEndpointRetryOptions](https://docs.aws.amazon.com/firehose/latest/APIReference/API_HttpEndpointRetryOptions.html) |
| Transformation buffer | 0.2 to 3 MB (1 MB), 0 to 900 s (60 s) | hard | [Transform source data](https://docs.aws.amazon.com/firehose/latest/dev/data-transformation.html), [ProcessorParameter](https://docs.aws.amazon.com/firehose/latest/APIReference/API_ProcessorParameter.html) |
| Transformation invocation | up to 5 minutes; 5 outstanding invocations per shard; 3 retries by default | hard | [Transform source data](https://docs.aws.amazon.com/firehose/latest/dev/data-transformation.html), [Quota](https://docs.aws.amazon.com/firehose/latest/dev/limits.html), [Failure handling](https://docs.aws.amazon.com/firehose/latest/dev/data-transformation-failure-handling.html) |
| Kinesis source reads | GetRecords once a second per shard, from LATEST | hard | [Kinesis source](https://docs.aws.amazon.com/firehose/latest/dev/writing-with-kinesis-streams.html) |
| Firehose streams per region | 5,000 / 2,000 / 500 / 100 by region | quota | [General Reference](https://docs.aws.amazon.com/general/latest/gr/fh.html). The developer guide's list differs for a few regions (Canada West); the General Reference is used. |

## Behaviour

**Buffers ("lanes").** A Direct PUT stream has one buffer; a Kinesis-sourced one has one per source shard. Records join
the buffer as counts (records, bytes, oldest arrival and birth). The buffer is flushed when it reaches `bufferSize`
(HTTP: also 10,000 records) or `bufferInterval` after its first record (1 s for an interval of 0), and becomes a delivery.
A lane delivers one at a time, in order. A buffer flushed while earlier deliveries wait is merged into the last waiting one
if that stays within 128 MiB (64 for HTTP): that is how delivery that has fallen behind catches up with bigger objects.

**Delivery.** One message per delivery: `count: 1`, the buffer's bytes, born with its oldest record (so the destination's
`age` is end-to-end). On failure the delivery is retried after `min(120 s, 1 s · 2^(attempt−1))` × a jitter in [0.85, 1.15]:
- S3: until it lands. A Direct PUT stream drops a delivery whose oldest record is over 24 hours old (`lost`). A
  Kinesis-sourced stream retries forever and refuses that shard's records meanwhile (`refusedFromStream`), so its source
  connector keeps them in the stream: KinesisMillisBehindLatest grows, nothing is lost until the stream's retention.
- HTTP endpoint: until `retryDuration` after the first failure, then the data is written to `backup`. A `Rejected` (413)
  is permanent: dropped, not backed up.

**Transformation.** With a function on `transform`, records gather in a transform buffer per lane (`transform.bufferSize`
or `transform.bufferInterval`), and each batch is one synchronous invocation with `count` records, at most five in flight
per lane. On success, records the function named as failed are written aside and the rest join the destination buffer at
`outputRatio` times their size; the destination's interval counts from when transformed data arrives, as AWS says. A
failed invocation is retried after a second, `retries` times, then its records are written aside.

**Quotas.** A Direct PUT call needs one request, `count` records and `bytes` from three one-second buckets at the
region's rates scaled by `firehoseDirectPutMiBps / base`; any short and the call is `Throttled` whole.

## Connections

- **In** (`invoke`): PutRecord/PutRecordBatch from anything, or records from a Kinesis stream (the
  `aws.firehose.kinesis-source` connector on an edge from the stream's `consumers` port).
- **`out`** (`invoke`, one): the destination. An S3 bucket, or with `destination: http` an HTTP endpoint (or a partner's).
  Unwired, deliveries count as made (to something outside the design).
- **`transform`** (`invoke`, one): the transformation Lambda. Unwired, there is no transformation.
- **`backup`** (`invoke`, one): the S3 backup bucket for an HTTP destination's failed deliveries and failed
  transformations. Unwired, that data is `lost`.

The CloudFormation importer doesn't read `AWS::KinesisFirehose::DeliveryStream` yet.

## Metrics and state

Rates: `incoming`, `incomingBytes` (IncomingRecords/Bytes), `putRequests` (IncomingPutRequests), `throttled`
(ThrottledRecords), `rejected`, `refusedFromStream`, `delivered`, `deliveredBytes` (DeliveryToS3.Records/Bytes),
`objects` (DeliveryToS3.Success: objects or requests delivered), `deliveryFailed` (failed attempts), `transformInvocations`,
`transformFailed`, `transformedRecords` (SucceedProcessing.Records), `processingFailed`, `backedUp`, `backupFailed`, `lost`.
Gauges: `dataFreshness` (DeliveryToS3.DataFreshness, in ms), `heldRecords`, `heldBytes`.

Probe: source (`direct-put` or `kinesis`), buffers in use, what is held (records, bytes, deliveries queued, buffers
whose delivery is failing), data freshness, totals.

The Kinesis source edge: rates `records`, `bytes` (DataReadFromKinesisStream), `refused`; gauges `millisBehindLatest`
(KinesisMillisBehindLatest), `backlog`. Its GetRecords calls and throttles are counted on the stream.

## Not yet simulated

1. **Dynamic partitioning.** Records split by key into up to 500 active partitions, each a buffer of its own and an S3
   prefix of its own: the real cause of small-object explosions. Needs a partition-count setting and a buffer per partition.
2. **Multipart uploads below a 60 s interval** (more S3 PUT requests per object) and **compression / format conversion**
   (fewer bytes, CPU time).
3. **Automatic Direct PUT limit increase** under sustained throttling (AWS publishes no rate).
4. **Source record backup** (all records to the backup bucket, which also makes Firehose read a Kinesis shard twice a
   second) and **zero-buffering behaviour for S3** in detail.
5. **Duplicates** on HTTP/OpenSearch/Redshift destinations after a timed-out delivery that went through.
6. **Other destinations' semantics**: Redshift COPY every 5 minutes, OpenSearch per-document failures, Iceberg tables,
   Snowflake's 1 s buffers.
7. **Availability zones.** Firehose is regional and multi-zone; a zonal outage should be absorbed, a regional one take it
   down, which an `Outage` on the node does today.

## Assumptions

| Number | Value | Why |
| --- | --- | --- |
| Zero-interval flush | once a second | AWS: "within a few seconds". |
| S3 retry schedule | the HTTP endpoint's (1 s doubling to 2 minutes, ±15%) | The S3 cadence isn't published. |
| Deliveries per buffer | one at a time, in order | Not published; keeps a failing destination from being hammered and makes catching up visible. |
| Merging while behind | up to the largest buffer size | AWS says it raises the buffer size dynamically; the bound is the hint's maximum. |
| Transformation retry delay | 1 s | Not published. |
| Error output record overhead | 300 bytes a record | The JSON envelope written for a failed record. |
| Waiting on S3 | the edge's timeout (3 minutes by default) | Not published. |
| Backpressure on a Kinesis source | a shard's records are refused while its delivery is failing | AWS says data stays in the stream; not how much Firehose holds first. |

## References

- [Amazon Data Firehose quota](https://docs.aws.amazon.com/firehose/latest/dev/limits.html), [endpoints and quotas (General Reference)](https://docs.aws.amazon.com/general/latest/gr/fh.html)
- [Buffering hints](https://docs.aws.amazon.com/firehose/latest/dev/create-configure-backup.html#buffering-hints), [BufferingHints](https://docs.aws.amazon.com/firehose/latest/APIReference/API_BufferingHints.html)
- [Understand data delivery](https://docs.aws.amazon.com/firehose/latest/dev/basic-deliver.html), [Handle data delivery failures](https://docs.aws.amazon.com/firehose/latest/dev/retry.html), [HTTP endpoint request and response](https://docs.aws.amazon.com/firehose/latest/dev/httpdeliveryrequestresponse.html), [HttpEndpointRetryOptions](https://docs.aws.amazon.com/firehose/latest/APIReference/API_HttpEndpointRetryOptions.html)
- [Transform source data](https://docs.aws.amazon.com/firehose/latest/dev/data-transformation.html), [Handle failure in data transformation](https://docs.aws.amazon.com/firehose/latest/dev/data-transformation-failure-handling.html), [ProcessorParameter](https://docs.aws.amazon.com/firehose/latest/APIReference/API_ProcessorParameter.html)
- [Kinesis Data Streams as a source](https://docs.aws.amazon.com/firehose/latest/dev/writing-with-kinesis-streams.html)
- [CloudWatch metrics](https://docs.aws.amazon.com/firehose/latest/dev/monitoring-with-cloudwatch-metrics.html)
