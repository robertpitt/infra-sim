# AWS services

Each AWS service the simulator models lives in its own folder here. This file is how a service is laid out, written and
documented, and it is the brief for anyone (human or agent) working on one.

| Service | Folder | Component(s) |
| --- | --- | --- |
| API Gateway | [`apigateway/`](apigateway) | `aws.apigateway` |
| CloudFront | [`cloudfront/`](cloudfront) | `aws.cloudfront` |
| DynamoDB | [`dynamodb/`](dynamodb) | `aws.dynamodb` |
| EC2 Auto Scaling (groups of instances, warm pools, Spot) | [`ec2/`](ec2) | `aws.ec2` |
| ECS (services on Fargate or EC2 capacity providers) and EKS (Deployments on node groups, Cluster Autoscaler, Karpenter) | [`ecs/`](ecs), [`eks/`](eks) | `aws.ecs`, `aws.eks` |
| ElastiCache (Valkey, Redis OSS, Memcached, serverless) | [`elasticache/`](elasticache) | `aws.elasticache` |
| Elastic Load Balancing (Application and Network Load Balancers) | [`elb/`](elb) | `aws.alb`, `aws.nlb` (and the `aws.alb.target-group`, `aws.alb.lambda-target`, `aws.alb.ip-target`, `aws.nlb.target-group`, `aws.nlb.ip-target` connectors) |
| EventBridge (event buses) and EventBridge Scheduler | [`eventbridge/`](eventbridge), [`scheduler/`](scheduler) | `aws.eventbridge`, `aws.scheduler` |
| Kinesis Data Streams and Data Firehose | [`kinesis/`](kinesis), [`firehose/`](firehose) | `aws.kinesis`, `aws.firehose` (and the `aws.kinesis.event-source-mapping`, `aws.firehose.kinesis-source` connectors) |
| Lambda | [`lambda/`](lambda) | `aws.lambda` |
| OpenSearch Service (managed domains) | [`opensearch/`](opensearch) | `aws.opensearch` |
| RDS and Aurora, RDS Proxy | [`rds/`](rds) | `aws.rds`, `aws.rds-proxy` (and the `aws.rds.client`, `aws.rds-proxy.client`, `aws.rds-proxy.target` connectors) |
| Route 53 | [`route53/`](route53) | `aws.route53` (and the `aws.route53.connection` connector) |
| S3 | [`s3/`](s3) | `aws.s3` |
| SES | [`ses/`](ses) | `aws.ses` |
| SNS | [`sns/`](sns) | `aws.sns` |
| SQS | [`sqs/`](sqs) | `aws.sqs` |
| Step Functions (Standard and Express) | [`stepfunctions/`](stepfunctions) | `aws.stepfunctions` (and the `aws.stepfunctions.task` connector) |
| WAF | [`waf/`](waf) | `aws.waf` |
| Region and VPC (boundaries) | [`region/`](region), [`vpc/`](vpc) | `aws.region`, `aws.vpc` |

## What a service folder contains

```
<service>/
  README.md        what is simulated, what is not yet, every limit with its source, settings, metrics (template below)
  index.ts         exports the component(s): `export { Foo } from "./Foo.ts"`
  Foo.ts           the component: settings schema, ports, state schema, behaviour, reading top to bottom
  Quotas.ts        the account-level quotas this service contributes (see below)
  Audit.ts         checks of a design against those quotas (see below)
  tests/           behaviour tests (`tests/Foo.test.ts`)
  internal/        the implementation the component is built from: config, state, one module per mechanism,
                   the dashboard. Lower-case names; nothing outside this folder imports them
```

PascalCase modules are the folder's public surface; `internal/` is private to it (`npm run typecheck` checks this). When
another service needs something from here (ECS reads EC2's instance types), it is a PascalCase module, not an internal
one. See "Public modules and internal/" in [AGENTS.md](../../../AGENTS.md).

A folder owns everything about its service and touches nothing outside it. The only shared files are the composers, which
need no editing when a service changes: `internal/account.ts` merges every `Quotas.ts`, `internal/provider.ts` runs every `Audit.ts`, and
`index.ts` lists the components. Adding a second component to a service means adding it to `<service>/index.ts` and the
list in `index.ts` (one line).

## The model in one page

A component is data plus one effect (see `../Component.ts`): a `config` schema (becomes validation, defaults, the on-disk
codec and the UI form), `ports` (named exits that edges leave from), a `state` schema (what a probe reports), and `make`,
which builds the behaviour. The framework supplies what is around it: edge policy (latency, timeout, retry), faults,
metrics for `in`/`ok`/`fail`/`latency`, seeded randomness and virtual time.

**Write hot paths the fast way.** A busy design makes hundreds of thousands of calls per simulated minute, and a component's
handler is on every one. `SIMULATOR.md` ("Performance") explains why; the rules are:

- Decide synchronously, wait with one callback. Read settings with `node.fast.settings()`, time with `node.fast.now()`,
  randomness from `node.fast.random`, timers with `node.fast.after(ms, fn, arg)`, messages with `node.fast.mint()`. A
  handler is a plain function returning `Effect.fail(...)`, `Effect.void`, or one of the waits in `../../Flow.ts`
  (`Flow.delayed`, `Flow.wait`), or an `Effect.callback` over timers and `link.send(message, done)`. Do not write an
  `Effect.gen` handler with many `yield*`s, `Effect.sleep`, `raceFirst`, `Pool` or `Effect.retry` in a per-request path.
- Call downstream things with `link.send(message, done)` (or `Flow.fanOut`, `Flow.sequence`, `Flow.parallel`,
  `Flow.forEach`, `Flow.Lanes` for serial lanes). `done` hears the outcome once; the returned function cancels.
- Token buckets: `node.limiter.takeUnsafe(key, {rate, burst}, tokens)`. Latencies: `Distribution.latencyMs(latency, node.fast.random)`.
- Counters and samplers are handles resolved once: `const ok = node.meter.counter("ok")` then `ok.n++`;
  `node.meter.sampler("latency").add(ms)`; gauges with `node.meter.gaugeUnsafe(name, () => value)` (the Effect form
  `meter.gauge(...)` must be *run*; forgetting to is a silent bug).
- Work that is the same for every call but depends on settings, quotas or shared state (a table's capacity, a function's
  standing against the regional pool) is memoised against the identity of what it depends on, not recomputed per call.
- Setup (`make`, schemas, probes) may use ordinary Effect code. Keep it out of the per-request path.
- Never use `Math.random`, `Date.now`, `setTimeout` or wall-clock anything: everything runs on virtual time with seeded
  randomness so a design and a seed always play out identically.

**Failures** are the five tagged values in `../../Message.ts`: `Throttled` (429, capacity), `Unavailable` (503, down),
`Timeout` (the caller gave up), `Failed` (500, the handler failed), `Rejected` (4xx, retrying can't help). Use the one that
matches what the real service returns; retry policy keys off it.

**Shared resources** (an account-level pool, a regional bucket) go through `node.shared(key, build)`; the account's quota
settings are `node.fast.account()`, live.

## Limits: hard, quota, assumed

Every number AWS publishes is either:

- **hard**: the service enforces it and nobody can change it. It is the `min`/`max` of the setting that exposes it
  (`Setting.hard(url, note)`), or a read-only entry in the component's `limits` list. Shown as a `hard` pill in the UI.
- **quota**: an adjustable default (AWS raises it on request). It is an **editable setting** whose default is AWS's
  published number (`Setting.quota(url, note)`). When it is shared by everything in an account and region it belongs in
  `Quotas.ts` (account-level), otherwise on the component's own settings. Regional defaults must be AWS's regional numbers.
- **assumed**: AWS doesn't publish it (a latency distribution, an idle timeout, a retry cadence). It is still a setting,
  and its `help` says in so many words that it is an assumption.

**Do not invent AWS numbers.** Verify every limit against the current AWS documentation (fetch the page; docs change and
older pages go stale: when two pages disagree, say so and use the newer one). Cite the URL in the README table and in the
setting's `limit` or the component's `limits`. If you cannot confirm a number, it is an assumption and is labelled as one.

## Account-level quotas and audits

Some limits belong to the account in a region and are shared by everything of the service there (Lambda's regional
concurrency, API Gateway's regional throttle). `Quotas.ts` exports `quotas(region)` returning `Setting` fields with
AWS's published defaults *for that region*; field names must be unique across services (prefix them with the service:
`sesSendingRate`). They appear in the Account quotas panel of a Region box and can be overridden per design. Components
read them live with `node.fast.account() as Aws.Account`.

`Audit.ts` exports `audit(region, members, quotas)`: a static check of what a design asks of the account, against the
account's quotas (reservations that add up to more than the account has, provisioned capacity over the total). It returns
`Diagnostic`s (see `internal/service.ts`). Keep it pure and cheap.

## Documentation standard

Code: every exported thing and every non-obvious decision has a comment saying *why* (what AWS behaviour it models, which
page says so), not what the line does. Name things after the AWS concept. No dead code, no commented-out code, no
unexplained magic numbers (constants carry a name and a source). Files stay readable: the component module reads as the component (settings, ports, behaviour), and
the plain functions and state machines it is built from live in `internal/` (`internal/config.ts`, `internal/state.ts`, one file
per mechanism).

Each service's `README.md` follows this template (keep the headings; add sections where the service needs them):

```markdown
# <Service> (`aws.<type>`)

One paragraph: what the real service is for, and what the simulator lets you learn from this component.

## Coverage
A table: Feature | Status | Notes. Status is ✅ simulated, 🟡 partly (say what is missing), ❌ not yet. Group rows (Requests,
Throttling, Scaling, Durability, Failure modes, Events...). This table is the honest answer to "does it do X?".

## Settings
A table of every setting: path, default, range, hard/quota/assumed, what it models.

## Limits
A table: Limit | Value | Kind (hard / quota / assumed) | Source URL. Regional differences included.

## Behaviour
How the main mechanisms are modelled, in prose a user can reason with: what happens on throttle, on timeout, under load.
Include the formulas where there are formulas, and where the model departs from AWS and why.

## Connections
Ports (what they are, what they carry), how this component is called and what it calls, and what the edge settings on each
port mean. What a CloudFormation import maps onto it, if the importer supports it.

## Metrics and state
Counters, rates, gauges and distributions this component records (names and meaning, and the CloudWatch metric each
stands for), and the probe state.

## Not yet simulated
A prioritised backlog: what is missing, why it matters, and what it would take. Be specific.

## Assumptions
Every number that is not from AWS, and why that value.

## References
The AWS documentation pages used.
```

## Dashboard

A component (and a connector that records metrics on its edge) declares a `dashboard` (`../Dashboard.ts`): a few key
figures and the charts an operator would put on a dashboard for the service, mirroring what AWS publishes for it in
CloudWatch and names the way AWS does (`ConsumedWriteCapacityUnits`, `ApproximateAgeOfOldestMessage`), with the CloudWatch
names listed on each panel. It is plain data in the service's folder (`internal/dashboard.ts`); the UI draws it when the node or
edge is selected. Record what a CloudWatch metric needs (requests by operation, bytes, throttles by direction) where it
happens, in the fast style. `src/simulator/aws/dynamodb/internal/dashboard.ts` is the reference; `npx tsx
tools/dashboard-check.ts 60 <type>` lists dashboard metrics that no example records (a typo, or a metric never registered).

A dashboard is the same for every node of a type, so a panel that only some configurations have (a table's stream, an
ECS cluster's container instances) is hidden for the others: a panel of nothing but gauges is hidden when the node
registers none of them, and any panel can name the gauge it `requires`. Register such gauges when the node is built, not
on first use, so a panel doesn't appear halfway through a run. A threshold to read a line against (Route 53's 18%, SES's
review rate) is a `constant`, not a gauge.

## Tests

Tests live in the service's `tests/` folder (`tests/Foo.test.ts`) and use the helpers in `src/simulator/testing.ts` (`frames`, `mean`, `sim`,
`dist`) and `Builder` to compose a small design. Each behaviour listed under Coverage as ✅ or 🟡 has a test that would
fail if the behaviour broke; tests assert the real quantitative behaviour (rates within tolerance, limits enforced at the
published number, quotas honoured when changed), not just that something ran. Run one folder with
`npx vitest run src/simulator/aws/<service>`; typecheck the engine with `npx tsc -p tsconfig.simulator.json`.

## Hardening checklist

- Inputs: zero or odd message `count`/`bytes`, a missing key or group, settings at their min and max, an unwired port, a
  node with no consumers, a target that is down. None may throw or leave counters wrong.
- Cleanup: an interrupted or abandoned call gives back everything it held (counters, in-flight slots, timers). Timers are
  cancelled when the thing they guard is done. Nothing grows without bound (maps keyed by group/key, queues, histories).
- Determinism: same design, same seed, same result. No iteration over unordered state that affects outcomes.
- Live edits: changing a setting or a quota while running takes effect on the next call and never corrupts state.
- State and metrics: the probe `state` schema matches what is returned; counters and gauges are named, documented in the
  README, and registered (a gauge that was never registered shows nothing).
- Failure taxonomy: the right tagged failure for the real service's behaviour; retries behave as AWS clients do.
- Hot paths stay in the fast style described above (no `Effect.gen` handlers, `Effect.sleep`, `Pool` or `Effect.retry` per request). No benchmarking or profiling is needed as part of this work.

## Definition of done for a service

README complete and honest · limits verified and sourced · behaviour tested against the published numbers · hot path in the
fast style · a dashboard mirroring CloudWatch · hardening checklist walked through · `npx tsc -p tsconfig.simulator.json` clean · `npx vitest run
src/simulator/aws/<service>` green · no edits outside the folder (anything needed elsewhere is reported, not made).
