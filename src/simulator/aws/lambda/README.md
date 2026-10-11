# Lambda (`aws.lambda`)

AWS Lambda runs code on demand in execution environments that each serve one request at a time. What matters for an
architecture is not the code but the machinery around it: a concurrency limit shared by the whole account in a Region
(which one noisy function can use up), reserved and provisioned concurrency carved out of it, cold starts when a request
finds no warm environment, a timeout that kills the work, and asynchronous invocation with its own queue and retries. This
component lets you see those play out under load: where a design throttles, how a cold start shows up in latency, what a
reservation protects and costs, how events retry and when they are given up on.

The handler's own work is a duration distribution (an assumption: the simulator doesn't run code). Everything else follows
AWS's documented rules, cited in [Limits](#limits).

The code is split by mechanism:

| File | What it holds |
| --- | --- |
| `Lambda.ts` | The component: ports, state schema, wiring, the sync/async entry |
| `config.ts` | The settings schema (every setting, with its limit source) |
| `invocation.ts` | One invocation attempt: admission, environment, cold start, run, timeout, settle |
| `environments.ts` | Warm environments: reuse, idle expiry, maximum lifetime |
| `provisioned.ts` | Provisioned concurrency: allocation delay, busy count |
| `concurrency.ts` | The regional pool: claims, a function's standing |
| `async.ts` | Asynchronous invocation: queue, retries, age, destinations |
| `stats.ts` | The counters and samplers |
| `limits.ts` | Named constants with their sources |
| `quotas.ts`, `audit.ts` | The account-level concurrency quota, and checks of a design against it |

## Coverage

| Feature | Status | Notes |
| --- | --- | --- |
| **Invocation** | | |
| Synchronous invocation | ✅ | Answered when the handler and its downstream calls finish; a function error comes back as `Failed`, a throttle as `Throttled`. |
| Asynchronous invocation | ✅ | Accepted at once (202), run and retried from an internal queue. See below. |
| Payload limits, request | ✅ | 6 MB sync, 1 MB async, `Rejected` (413) above. |
| Payload limit, response; streamed responses (200 MB) | ❌ | Messages carry no response size. |
| Function URL as an entry point | ✅ | Wire a client (or CloudFront) straight to the function: it is a synchronous invocation, throttled with 429 by the same limits. A URL's auth type and CORS don't change load behaviour and are not modelled. The CloudFormation importer draws a client for a `FunctionUrlConfig` (not when a CloudFront distribution fronts it). |
| Invoked by API Gateway, SQS, SNS, S3, EventBridge | ✅ | Those components call it over an edge; the invocation type comes from the message. |
| **Concurrency and throttling** | | |
| Regional concurrent-executions quota, shared by all functions | ✅ | `lambdaConcurrency` in the account quotas; edit it live. |
| 100 always unreserved | ✅ | Reservations can hold back at most quota − 100; the audit warns beyond that and the pool never falls below 100. |
| Reserved concurrency (floor and cap, 0 switches the function off) | ✅ | An idle reserved function still holds its reservation back from everyone else's pool. |
| Provisioned concurrency | 🟡 | Environments that never cold start, counted against the pool, clamped to the reservation, allocated after a delay when raised live. Not modelled: it applying to a version or alias only, Application Auto Scaling, the 10-requests-per-second spillover per provisioned unit. |
| Scale-up rate (1,000 environments per 10 s per function) | ✅ | A token bucket of 1,000 refilling 100 a second; empty means 429. The "10,000 requests per second every 10 s" form of the same limit is not modelled. |
| Requests-per-second limit (10 × concurrency) | 🟡 | Per function, synchronous calls only, behind a switch that is **off by default** (`rpsLimit`) so existing designs behave as before. The account-wide form (10 × the account quota across all functions) is not modelled. |
| 429 with the right reason | ✅ | The reason names AWS's: `ConcurrentInvocationLimitExceeded` (the account pool), `ReservedFunctionConcurrentInvocationLimitExceeded` (the reservation), scaling rate, request rate. |
| **Environments and cold starts** | | |
| One request per environment, warm reuse | ✅ | Last-used first. |
| Cold start (Init) | ✅ | Duration is an assumed lognormal; the timeout does not cover it. |
| Init limit of 10 s, repeated inside the invocation | ✅ | An Init past 10 s costs 10 s, then runs again under the function timeout. |
| Idle expiry | ✅ | Assumed (AWS says "some time"); live-editable. |
| Maximum lifetime ("every few hours") | 🟡 | Off by default: AWS publishes no number. When set, environments are retired at that age even while busy. |
| SnapStart | 🟡 | Replaces Init with an assumed shorter Restore; ignored with provisioned concurrency, as AWS doesn't support the two together. Not modelled: published versions only, runtime support, runtime hooks, restore billing. |
| Environment reset after a timeout | ✅ | The environment is discarded; the next request is cold. A provisioned environment is re-initialised in the background. |
| Init failures (crash during Init) | ❌ | No failure model for Init. |
| Environments initialised ahead of requests (on-demand) | ❌ | AWS says not to depend on it. |
| Init billing, `INIT_REPORT` | ❌ | The simulator has no cost model. |
| **Execution** | | |
| Timeout (1 s to 15 min) | ✅ | Kills the work, cancels downstream calls, discards the environment. Counted as `timeouts` and `errors`. |
| Memory to CPU | 🟡 | Below 1,769 MB the CPU-bound share of the handler slows in proportion. Above it nothing speeds up (extra vCPUs help only multi-threaded code). Init is not scaled by memory. |
| Handler duration | ✅ | A lognormal; optionally multiplied by the records in a batch. |
| Error rate | ✅ | Per invocation or per record in a batch. A failing downstream call is a function error too. |
| Out of memory, `/tmp` storage (512–10,240 MB), network bandwidth by memory | ❌ | The simulator has no memory, disk or bandwidth use. |
| Extensions, layers, deployment package size, VPC networking | ❌ | Not load behaviour. |
| **Asynchronous invocation** | | |
| Internal queue, 202 | ✅ | |
| Function errors retried 0–2 times, after 1 min and 2 min | ✅ | Timeouts are function errors. |
| Throttles retried with backoff from 1 s to 5 min until the event is too old | ✅ | The interval doubles; AWS also slows its queue reads when the queue is long (not modelled). |
| Maximum event age (60 s to 6 h) | ✅ | Also bounds retries after function errors: a retry that would come later is not waited for, the event is discarded at its age. |
| On-failure destination, dead-letter queue | ✅ | The `onFailure` port. A DLQ and an on-failure destination are the same here; AWS's record differs (a destination gets the response too). |
| On-success destination | ✅ | The `onSuccess` port. |
| Reserved concurrency 0 | ✅ | Events go straight to the failure destination, unretried. |
| Destination delivery failures | ✅ | Counted (`destinationFailures`). |
| Duplicate delivery of an event with no error | ❌ | AWS says the queue is eventually consistent; no duplicates are produced. |
| **Event source mappings** | | |
| SQS batches | ✅ | The SQS component polls and calls the function with a batch (`count` records, up to 6 MB). `batchCalls` and `batch.*` decide how the function treats it. |
| Partial batch response (`ReportBatchItemFailures`) | ❌ | Needs engine support: the call outcome cannot say "these records failed". See [Not yet simulated](#not-yet-simulated). |
| Kinesis, DynamoDB streams, MSK, MQ mappings | ❌ | No such components. |
| **Regions and accounts** | | |
| Regional differences | ✅ | AWS publishes one default (1,000) for every Region, so there is none to model. New accounts start lower; set it in the account quotas. |

## Settings

Names are stable: designs, `examples/*.yaml`, the SQS component and the CloudFormation importer use them. A dot is a group.
"Kind" is the limit's kind (see `../README.md`): hard, quota, or assumed. Settings new in this revision default to the old
behaviour.

| Setting | Default | Range | Kind | What it models |
| --- | --- | --- | --- | --- |
| `memory` | 128 MB | 128–10,240 | hard | CPU is proportional to memory. |
| `timeout` | 3 s | 1 s–15 min | hard | Invocation limit. (90 min applies only to Lambda Managed Instances, not modelled.) |
| `duration` | mean 100 ms, cv 0.5 | mean 0–10 min | assumed | Handler time at 1,769 MB or more, excluding cold starts. |
| `cpuBound` | 0.5 | 0–1 | assumed | Share of the handler that slows below 1,769 MB. |
| `coldStart.init` | mean 300 ms, cv 0.5 | mean 0–10 min | assumed | Init duration. AWS: "under 100 ms to over 1 s". |
| `coldStart.idleTtl` | 10 min | 1 min–6 h | assumed | Idle environment lifetime. |
| `coldStart.maxLifetime` | 0 (off) | 0–48 h | assumed | Retire environments at this age. New. |
| `coldStart.snapStart` | false | | | Resume from a snapshot instead of Init. New. |
| `coldStart.restore` | mean 200 ms, cv 0.5 | mean 0–10 min | assumed | SnapStart restore duration. New. |
| `reserved.enabled` | false | | | Turns the reservation on. |
| `reserved.concurrency` | 100 | 0–1,000,000 | hard (≤ quota − 100 in total) | Floor and cap. |
| `provisioned` | 0 | 0–1,000,000 | quota | Provisioned environments (clamped to the reservation). |
| `provisionedAllocation` | 90 s | 0–1 h | assumed | Delay before provisioned concurrency raised while running becomes usable. New. |
| `rpsLimit` | false | | | Enforce 10 synchronous requests/s per unit of concurrency. New, off. |
| `errorRate` | 0 | 0–1 | | Chance an invocation (or record) fails. |
| `fanOut` | sequential | sequential, parallel, weighted, none | | How downstream edges are called. |
| `batchCalls` | each | each, once | | Downstream calls per record or per batch. |
| `batch.duration` | invocation | invocation, record | assumed | Handler duration once or per record in a batch. New. |
| `batch.errors` | invocation | invocation, record | assumed | Error rate rolled once or per record in a batch. New. |
| `async.maxRetries` | 2 | 0–2 | hard | Retries after function errors. |
| `async.firstRetryDelay` | 1 min | 0–6 h | hard (AWS value) | Wait before the first retry. |
| `async.secondRetryDelay` | 2 min | 0–6 h | hard (AWS value) | Wait before the second retry. |
| `async.maxEventAge` | 6 h | 1 min–6 h | hard | Discard events older than this. |

Account quota (in `quotas.ts`): `lambdaConcurrency`, default 1,000, 10 to 1,000,000, quota.

Edge settings on the ports are the universal edge policy (latency, timeout, retry, cancel on timeout); the function adds none.

## Limits

| Limit | Value | Kind | Source |
| --- | --- | --- | --- |
| Concurrent executions per Region (all functions) | 1,000; "tens of thousands" on request; new accounts start lower | quota | [gettingstarted-limits](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html) |
| Regional differences in that default | none published: 1,000 in every Region | n/a | same |
| Concurrency kept unreserved | 100 | hard | [lambda-concurrency](https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html), [configuration-concurrency](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html) |
| Reserved concurrency | floor and cap; 0 stops the function | hard | [configuration-concurrency](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html) |
| Provisioned concurrency | at most unreserved − 100; at most the reservation; not on `$LATEST` | hard | [provisioned-concurrency](https://docs.aws.amazon.com/lambda/latest/dg/provisioned-concurrency.html) |
| Provisioned allocation | "a minute or two of preparation", then up to 6,000 environments per minute per function; none usable until all are | hard | [lambda-concurrency](https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html) |
| Scale-up rate | 1,000 environments (or 10,000 rps) every 10 s per function, refilled continuously, no accrual beyond 1,000 | hard | [scaling-behavior](https://docs.aws.amazon.com/lambda/latest/dg/scaling-behavior.html) |
| Requests per second | 10 × concurrency, synchronous; async limited by concurrency only; 10 × provisioned for the provisioned part | hard | [lambda-concurrency](https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html), [gettingstarted-limits](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html) |
| Memory | 128–10,240 MB; one vCPU at 1,769 MB | hard | [configuration-memory](https://docs.aws.amazon.com/lambda/latest/dg/configuration-memory.html) |
| Timeout | 3 s default, 1–900 s | hard | [configuration-timeout](https://docs.aws.amazon.com/lambda/latest/dg/configuration-timeout.html) |
| Payload | 6 MB sync (request and response), 200 MB streamed response, 1 MB async | hard | [gettingstarted-limits](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html) |
| Ephemeral storage | 512–10,240 MB | hard | [gettingstarted-limits](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html) |
| Init phase | 10 s; past it, re-run at the first invocation under the function timeout. Not applied to provisioned concurrency or SnapStart (130 s or the timeout) | hard | [lambda-runtime-environment](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html) |
| SnapStart | not with provisioned concurrency, EFS or more than 512 MB `/tmp`; published versions only; Restore limited to 10 s | hard | [snapstart](https://docs.aws.amazon.com/lambda/latest/dg/snapstart.html), [lambda-runtime-environment](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html) |
| Cold start duration | "under 100 ms to over 1 second", under 1% of invocations | assumed | [lambda-runtime-environment](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html) |
| Idle environment lifetime | not published ("some time") | assumed | same |
| Maximum environment lifetime | "every few hours", not published | assumed | same |
| Async retries after function errors | 0–2, default 2; 1 min then 2 min apart | hard | [invocation-async-error-handling](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-error-handling.html), [PutFunctionEventInvokeConfig](https://docs.aws.amazon.com/lambda/latest/api/API_PutFunctionEventInvokeConfig.html) |
| Async retries after throttles or system errors | exponential from 1 s to 5 min, up to the maximum age | hard | [invocation-async-error-handling](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-error-handling.html) |
| Async maximum event age | 60 s–6 h, default 6 h | hard | [PutFunctionEventInvokeConfig](https://docs.aws.amazon.com/lambda/latest/api/API_PutFunctionEventInvokeConfig.html) |
| Reserved concurrency 0, async | events go to the DLQ or failure destination without retry | hard | [invocation-async-retain-records](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-retain-records.html) |
| Destinations | SQS standard, SNS standard, S3 (failure only), Lambda, EventBridge; no FIFO | hard | [invocation-async-retain-records](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-retain-records.html) |

Verified against the current pages, and what changed from what the code did before: the async maximum event age (60 s to 6 h)
and retries (0 to 2) match; the maximum event age used to bound only throttle retries and now bounds retries after function
errors too; an asynchronous event on a function reserved at 0 used to be retried for hours and now goes straight to the
destination, as AWS documents; provisioned concurrency was read once at start and ignored live edits (now applied, with
AWS's allocation delay); an idle reserved function did not hold its reservation back until it first took a call (now it
does); the 10 s Init limit was only a display entry (now enforced); the `errors` total in the probe was never counted (now
is); 10 × concurrency requests per second was not enforced (now optional). No number in the code turned out to be wrong.
`docs/AWS-LIMITS.md` agrees with the pages for everything it lists for Lambda.

## Behaviour

**Admission.** A call is admitted or throttled before it takes anything. In order: the optional request-rate limit
(`rpsLimit`, synchronous calls); the concurrency limit; the scaling rate. A function with a reservation is capped at it
(`ownInUse >= reservation` throttles). A function without one may use a provisioned environment if one is free, and
otherwise needs the shared pool to have room: pool = quota − min(everything claimed, quota − 100). A claim is the
reservation, or the provisioned concurrency if there is no reservation. A function with provisioned concurrency and no
reservation can therefore run `pool + provisioned` at once. If no warm environment is idle, a new one needs a token from the
function's scale-up bucket (1,000, refilling 100 a second).

**Throttling.** `Throttled` (429) for all of these. A synchronous caller gets it; its edge may retry. An asynchronous event
is retried by Lambda with a backoff of 1 s, 2 s, 4 s ... capped at 5 minutes until it is too old.

**Cold start.** The first request with no idle environment waits for Init (`coldStart.init`) before the handler. The function
timeout does not cover it. Init is limited to 10 s: past that, Lambda re-runs it inside the invocation, so the request costs
10 s + Init + handler and the Init counts against the timeout. With SnapStart on (and no provisioned concurrency) Init is
replaced by `coldStart.restore`, itself limited to 10 s (past it the call fails). `coldStarts` counts every environment
created; `initDuration` samples what it cost.

**Reuse and expiry.** After an invocation the environment waits for the next request. The most recently used idle one is
taken first. An environment idle longer than `idleTtl` is discarded, and with `maxLifetime` set one is retired when taken
or released at that age. Expiry is lazy (checked when something touches the pool), so `environments` is exact when read.

**Provisioned concurrency.** Environments that never cold start. A design starts with them allocated. Raising the setting
while running starts an allocation: usable after `provisionedAllocation` plus `n / 6,000` minutes. Lowering it takes effect
at once for idle environments, and busy ones retire when they finish. After a timeout the provisioned environment is
re-initialised in the background and its slot returns after an Init.

**Handler time.** `duration × cpuScale × records`, where `cpuScale = 1 + cpuBound × (max(1, 1769 / memory) − 1)` and `records`
is 1 unless `batch.duration` is `record`. At 128 MB and `cpuBound` 1 the handler takes about 14 times as long. After it
the function calls what is wired to `out` (`fanOut`; a batch a record at a time, ten at once, unless `batchCalls` is
`once`). The first failure there ends the invocation as a function error.

**Errors.** Each invocation fails with `errorRate` (or, with `batch.errors` set to `record`, with `1 − (1 − p)^records`, so
any bad record fails the batch). A synchronous caller sees `Failed` ("function error: ..." with the cause). `errors` counts
every function error, timeouts included, as CloudWatch's `Errors` does.

**Timeout.** When it fires the work is cancelled (downstream calls abandoned), the environment is discarded, the invocation
is a function error ("task timed out"), and concurrency is given back.

**Giving back.** Everything an attempt holds (its concurrency, its pool slot, its environment) is returned exactly once,
whether it finishes, times out or is cancelled; every timer it armed is cancelled when it ends. A caller that gives up does
not stop Lambda in AWS, and here the edge decides: with "cancel on timeout" off (the default) the function runs on to the end,
holding its concurrency, which is how a retry storm exhausts a function; with it on the invocation is cancelled and its
environment kept warm.

**Asynchronous invocation.** The event is accepted at once and the caller is done. Attempts then run off the queue and hold
concurrency only while running. A function error (or timeout) is retried up to `async.maxRetries` times, waiting
`firstRetryDelay` then `secondRetryDelay`. A throttle is retried on the backoff above, without limit but the age. An event
whose next retry would come after `maxEventAge` is discarded at that age. Discarded events go to the `onFailure` port;
successes go to `onSuccess`. A function reserved at 0 discards at once. Pending events hold memory only until their maximum
age (6 h at most). `asyncPending` counts events not yet finished.

**Live edits.** Settings and quotas are read at the next call and cannot corrupt state: what an attempt holds is recorded
when it is admitted, and returned the same way whatever changed in between. A change to a reservation or to provisioned
concurrency is also applied at once (not at the next call), so an idle function holds back, or releases, its share of the pool
immediately. Lowering a limit below what is running throttles new calls and lets the running ones finish.

**Departures from AWS.** The handler is a distribution, not code. Throttle retries are not jittered and don't slow down as
the queue grows. The per-function request-rate bucket has a burst of one second. Init and Restore durations don't depend on
memory. Environments are not tied to function versions.

## Connections

- `in` (everything calls it): a synchronous or asynchronous invocation, from a client (a Function URL), API Gateway, SQS
  (as an event source mapping, with `count` records), SNS, S3 events, or another function.
- `out` (many): what the handler calls after its work. Weighted, sequential or parallel per `fanOut`.
- `onFailure` (one): asynchronous events given up on (retries used up, too old, or reserved at 0). SQS or SNS standard; also
  stands in for a dead-letter queue.
- `onSuccess` (one): asynchronous events that succeeded.

An SQS consumer edge carries `batchSize`, `batchWindow` and `maxConcurrency`; those belong to the queue's component. The
edge's `cancelOnTimeout` is what decides whether a caller that gives up stops the function (see Giving back).

**CloudFormation import** (`importers/cloudformation/lambda.ts`, `events.ts`, `vpc.ts`): `AWS::Lambda::Function` and SAM
`AWS::Serverless::Function` map `MemorySize` to `memory`, `Timeout` to `timeout`, `ReservedConcurrentExecutions` to
`reserved` (enabled when given), `ProvisionedConcurrencyConfig` to `provisioned`, and `SnapStart.ApplyOn: PublishedVersions`
to `coldStart.snapStart`. `EventInvokeConfig` (inline in SAM, or the `AWS::Lambda::EventInvokeConfig` resource) maps
`MaximumRetryAttempts` and `MaximumEventAgeInSeconds` to `async.maxRetries` and `async.maxEventAge`, and
`DestinationConfig.OnFailure` / `OnSuccess` to the `onFailure` / `onSuccess` ports. `DeadLetterConfig` (or SAM's
`DeadLetterQueue`) goes to `onFailure`, to an SQS queue or SNS topic only. A destination that isn't a component of the
template (an ARN, an EventBridge bus), or a SAM destination left for SAM to create, is reported and not connected.
`AWS::Lambda::Version`, `Alias` and `Url` stand for the function they point at, so something triggering an alias
triggers the function, and a version's or alias's `ProvisionedConcurrencyConfig` becomes `provisioned`. A
`FunctionUrlConfig` (or `AWS::Lambda::Url`) adds an assumed client calling the function, unless a CloudFront
distribution fronts the URL. `VpcConfig.SubnetIds` draws the function inside the VPC that owns those subnets (see VPC).
Triggers: `AWS::Lambda::EventSourceMapping` and the SAM events draw SQS queues and DynamoDB streams (see those
components for the edge settings); SNS, S3, `Api`/`HttpApi` and schedule events become edges or an assumed
traffic source. A mapping that is disabled is left out, a mapping to anything else (Kinesis, MSK, ...) or any other
trigger type is reported and not connected, and `ReportBatchItemFailures`, `FilterCriteria` and `TumblingWindowInSeconds`
are reported as not simulated (see below). What a function uses (queues, tables, buckets, SES) is inferred from its
environment variables and its own policies, with reads and writes told apart; a role shared by several functions is not
read as any one's use. A function that nothing triggers and that calls nothing is reported as idle.

## Metrics and state

Frames (per second unless noted; names as in the node's frame):

| Name | Kind | Meaning |
| --- | --- | --- |
| `in`, `ok`, `fail`, `fail.<Tag>`, `latency`, `age`, `inflight` | framework | Every call to the node, including asynchronous ones as accepted. |
| `invocations` | rate | Attempts admitted. Async retries count each time. |
| `coldStarts` | rate | On-demand environments created. |
| `throttles` | rate | Attempts refused with 429 (any reason). |
| `timeouts` | rate | Invocations killed at the timeout. |
| `errors` | rate | Function errors, timeouts included. |
| `asyncRetries`, `asyncSucceeded`, `asyncFailed`, `destinationFailures` | rate | Asynchronous outcomes. |
| `duration` | sampler (ms) | Handler time to return or timeout. |
| `initDuration` | sampler (ms) | Init (or Restore) time per cold start. |
| `concurrent` | gauge | Executions running now (cold-starting included). |
| `environments` | gauge | On-demand environments alive. |
| `provisioned` | gauge | Provisioned environments ready. |
| `asyncPending` | gauge | Asynchronous events not yet finished. |

Probe state: `concurrent`, `environments`, `provisioned`, `limit` (the most it may run now), `invocations`, `coldStarts`,
`throttles`, `timeouts`, `errors`, `asyncPending`, `asyncRetries`, `asyncSucceeded`, `asyncFailed`, `destinationFailures`
(running totals).

## Not yet simulated

In order of how much a design's behaviour depends on it:

1. **Partial batch response (`ReportBatchItemFailures`).** With it AWS re-delivers only the failed records and doesn't scale
   the mapping down on errors; without it one bad record fails the whole batch (modelled, via `batch.errors`). It needs the
   engine: `Call` can only succeed or fail, so there is no way for the function to say "3 of 10 failed" and for the SQS
   component to delete the other 7. It wants either a call outcome that carries the failed record count (or ids), or a
   `Message` convention the function can write the result into. Not hacked in here.
2. **Account-wide request-rate limit** (10 × the account quota across all functions) and the provisioned spillover at 10
   requests per second per environment. Needs a shared bucket per placement; doable inside this folder, left out to keep
   the first switch simple.
3. **Versions, aliases, weighted alias routing**: provisioned concurrency and SnapStart really belong to a version. There is
   one function per component.
4. **Response size and streaming**: 6 MB response limit (`Function.ResponseSizeTooLarge`), 200 MB streamed responses and
   their bandwidth cap. Messages carry no response size.
5. **Out of memory, `/tmp`, network bandwidth, Init failures**: no resource model inside the handler.
6. **Lambda Managed Instances** (many concurrent requests per environment, 90 min async timeout).
7. **Slower async queue reads under a long queue**, jittered backoff, duplicate deliveries.
8. **Cost** (GB-seconds, Init billing, provisioned and SnapStart charges).
9. **Event source mappings other than SQS**: Kinesis, DynamoDB streams, MSK, MQ, with their own retry, bisect and
   failure-destination behaviour.
10. **Recursive loop detection** (Lambda stops a function that invokes itself in a loop through SQS or SNS).

## Assumptions

| Number | Value | Why |
| --- | --- | --- |
| Handler duration | mean 100 ms, cv 0.5 | The simulator doesn't run code; a typical short function. |
| CPU-bound share | 0.5 | Half CPU, half waiting on I/O is a middling function. |
| Init duration | mean 300 ms, cv 0.5 | AWS: "under 100 ms to over 1 s". A lognormal in that band. |
| Idle lifetime | 10 minutes | AWS says "some time". Ten minutes is a commonly observed order of magnitude, not a published figure. |
| Maximum lifetime | off | AWS says "every few hours". Left off so the default stays as it was; a few hours is the range to try. |
| SnapStart restore | mean 200 ms, cv 0.5 | AWS says "as low as sub-second". |
| Provisioned allocation delay | 90 s | AWS: "a minute or two of preparation". The midpoint. |
| Request-rate bucket burst | one second | AWS says "per second" without a burst. |
| Throttle retry backoff | 1 s, doubling, cap 5 min | AWS gives the endpoints (1 s to 5 min) and "exponential"; doubling is the usual reading. No jitter. |

## References

- [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)
- [Understanding Lambda function scaling](https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html)
- [Lambda scaling behavior](https://docs.aws.amazon.com/lambda/latest/dg/scaling-behavior.html)
- [Configuring reserved concurrency](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html)
- [Configuring provisioned concurrency](https://docs.aws.amazon.com/lambda/latest/dg/provisioned-concurrency.html)
- [The execution environment lifecycle](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html)
- [SnapStart](https://docs.aws.amazon.com/lambda/latest/dg/snapstart.html)
- [Function memory](https://docs.aws.amazon.com/lambda/latest/dg/configuration-memory.html) and [timeout](https://docs.aws.amazon.com/lambda/latest/dg/configuration-timeout.html)
- [Asynchronous invocation: errors and retries](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-error-handling.html), [settings](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-configuring.html), [destinations and dead-letter queues](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-retain-records.html), [PutFunctionEventInvokeConfig](https://docs.aws.amazon.com/lambda/latest/api/API_PutFunctionEventInvokeConfig.html)
- [Invoke API](https://docs.aws.amazon.com/lambda/latest/api/API_Invoke.html) (error codes, throttle reasons)
- [Function URLs](https://docs.aws.amazon.com/lambda/latest/dg/urls-configuration.html) (throttling)
- [SQS event source: error handling and partial batch responses](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html)
- [Troubleshooting invocation issues](https://docs.aws.amazon.com/lambda/latest/dg/troubleshooting-invocation.html)
