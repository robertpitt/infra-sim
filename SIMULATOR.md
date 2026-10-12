# The simulator

(See the [README](README.md) for running it.)

A pure-Effect engine that simulates cloud architectures (clients, API Gateway, Lambda, queues, topics, tables, buckets) under traffic and faults, so you can see where a design scales, where it applies backpressure, and where it falls over (retry storms, redelivery loops, throttling cascades).

It lives in `src/simulator` and has no DOM and no React. `tsconfig.simulator.json` type-checks it without DOM libraries to keep it that way. The UI in `src/ui` is a client of the `Engine` service and nothing more.

## The idea in one paragraph

A **design** is a YAML or JSON file (see `examples/`). A Schema **codec** turns it into a **configured `Graph`** of components, with every setting validated and defaulted. A **`Simulation`** brings that graph to life inside a **virtual-time world**. You advance time, and at any moment you can **probe** a node for its internal state, **inspect** the whole system, **configure** a node live, **inject faults**, and watch **frames** of metrics. An **`Engine`** wraps all of that in a command/event protocol that a UI, worker or server can speak.

```
 JSON ──Design.codec──▶ Design (Graph) ──Simulation.make──▶ Simulation ──Engine──▶ UI
         (Schema)        configured         virtual-time       probe / inspect      commands in
                         components         world              configure / faults   events out
```

## Principles

- **Effect first.** Services are `Context.Service`s, wiring is `Layer`, live config is `SubscriptionRef`, randomness is Effect's own `Random` service, retries are a real `Schedule`, frames are a `Stream`, concurrency limits are `Semaphore`, queues use `Queue`/`FiberMap`/`PubSub`. Where something is mutable (a queue's message map, metric buckets) it is private to one component and documented as such.
- **Schema is the single source of truth.** One schema per component gives validation, defaults, the JSON codec, and the UI form. There is no second declaration to keep in sync.
- **Deterministic.** The same design and seed give bit-identical results. Each node and edge has its own seeded random stream, so editing one part of a design never reshuffles the randomness elsewhere. That makes A/B comparisons of designs meaningful.
- **Everything is inspectable.** A running component can say what it is holding.
- **Faithful over flattering.** Components model real behaviour (SQS visibility timeouts, redelivery and dead-lettering; callers that time out while the callee keeps working; DynamoDB-style provisioned throughput), not idealised queues.

## Layers

| Module | Role |
| --- | --- |
| `VirtualTime` | A `World`: its own `Clock` and synchronous `Scheduler`. `Effect.sleep` never waits on the wall clock; the world jumps timer to timer when asked to `advanceTo`. |
| `SeededRandom` | A deterministic implementation of Effect's `Random` service, forkable by label. |
| `Setting`, `Describe` | Schema constructors for config (`int`, `ratio`, `duration`, `choice`, `latency`, `group`…) and the derivation of a UI form from a schema. |
| `Message`, `Distribution` | The unit of work (`Message`), typed call failures, and sampling (lognormal latency, exponential gaps, weighted choice). |
| `Telemetry`, `Fault` | Windowed metrics published as a `Stream` of frames; fault kinds as a Schema union plus the service that tracks them. |
| `Protocol` | How work crosses a port: `invoke` (push a call), `pull` (the owner holds work, a taker takes leases) or `fleet` (the target offers its units, and the edge picks one per call). |
| `Edge` | Transport (latency and edge faults, one try per call, the edge's metrics) and call policy (timeout, retry/backoff). |
| `Connector`, `connectors/*` | What sits on an edge: the definition API, the inference rule, and the core ones (`core.link`, `core.poller`, `core.target-group`). |
| `fleet/` | Fleets of units (instances, tasks, pods) one by one: their life, zones, desired capacity, draining, replacement, interruptions; and a load balancer's target group. See `src/simulator/fleet/README.md`. |
| `Controller`, `controllers/*` | Loops that watch a node and change it while it runs: the definition API and the core ones (`core.target-tracking`). |
| `Family`, `kit/Slots` | A keyed family: instances by key, made on first use, evicted when idle, with cold starts counted; and slots with a line waiting for them. |
| `Component`, `Registry` | The component definition API, and the set of components and connectors a design may use. |
| `Design`, `Topology`, `Diagnostics`, `Layout`, `Builder` | The document, its codec to a `Graph`, graph analysis, validation, auto-layout, and a code-level builder. |
| `Simulation` | The running instance: advance, probe, inspect, configure, faults, frames. |
| `Engine` | The UI-facing actor: Schema'd commands in, events out, and pacing. |
| `components/*` | The standard library: `client`, `service`, `queue`, `topic`, `store`. |

## Virtual time

A `World` is a tiny Effect runtime that owns time. Inside it everything is ordinary Effect code (`Effect.sleep`, `Schedule`, `Effect.timeout`), but sleeping arms a timer in a queue ordered by (time, insertion order) and the world advances by popping timers. There is no real waiting, so a run is as fast as the CPU allows and repeatable. The timer queue knows where each timer sits, so cancelling one (almost every call arms a timeout and cancels it) removes it instead of leaving a tombstone. See **Performance** below.

`VirtualTime` is a `Context.Service`; `Simulation.make` requires it, so each simulation gets a fresh world from `VirtualTime.layer`. Methods on `Simulation` are normal Effects for the caller, but they run their work *inside* the world (`inWorld`) so state is only ever touched on the world's own clock and scheduler.

## Configuration: Schema all the way down

A component's settings are a `Schema.Struct` built from `Setting` constructors:

```ts
Schema.Struct({
  concurrency: Setting.int({ default: 10, min: 1, max: 100_000, unit: "workers" }),
  timeout:     Setting.duration({ default: "30 seconds", min: "1 millis" }),
  routing:     Setting.choice(["all", "weighted"], { default: "all" }),
  latency:     Setting.latency({ mean: "50 millis", cv: 0.5 })   // nested group
})
```

That one declaration gives:

- **Validation** with readable errors (`Expected a value between 1 and 100000`).
- **Defaults**: omit a field in JSON and it is filled in, so saved designs survive a component gaining a setting. Unknown keys are ignored, so they survive losing one.
- **A codec**: durations are `Duration` in memory and either milliseconds (`30000`) or strings (`"30 seconds"`) on disk; they encode back to milliseconds.
- **A form**: `Describe.fields(schema)` walks the schema AST and returns a plain `FieldSpec[]` (kind, label, help, unit, min/max/step, default, choice options, nested groups; durations in ms). A UI renders it with no knowledge of Effect.

## Components

A component is data plus one effect:

```ts
export const Echo = Component.make({
  type: "echo",
  title: "Echo",
  category: "compute",
  config: Schema.Struct({ delay: Setting.duration({ default: "10 millis" }) }),
  ports:  { out: Component.port.many("Next") },          // optional; default is one "out" port
  state:  Schema.Struct({ calls: Schema.Number }),        // what probe reports
  make: (node) => Effect.gen(function*() {
    // node.config   SubscriptionRef of live settings
    // node.out(p)   the edges wired to port p
    // node.meter    counters / samples / gauges
    // node.mint     create a Message (sources)
    // node.spawn    run a background loop, defects reported not lost
    // node.faults   what faults reach it now, and a hook to hear them change
    // node.zones    the zones of its region, and their faults
    return {
      call:  (msg) => /* handle an inbound call: Effect<void, CallFailure> */,
      probe: /* Effect<State> */,
      // offer: anything the connectors on edges into it, and its callers, may reach (`ctx.offer()`, `link.offer()`)
    }
  })
})
```

The framework supplies everything around it: edge policy, faults, metrics, per-node seeded `Random`, virtual time. Every node is wrapped so it automatically records `in`, `ok`, `partial`, `fail`, `fail.<Tag>`, `latency`, message `age` and an `inflight` gauge, applies faults, and contains defects (a throwing component fails the call with `Failed` and is logged, instead of killing the run).

A handler answers with a `Reply`: nothing (it all worked), or `ItemFailures`, a success that names by position the records of its batch that failed (how a Lambda function returns `batchItemFailures`). It travels back across the edge to whoever called, which decides what to do about those records; `partial` counts such replies.

A port speaks a protocol. Most are `invoke`: the component calls through `node.out(port)`, and each call is an
`Effect<void, CallFailure>` (or `link.send(message, done)`). A `pull` port (`port.pull`) is the other way round: the
component holds the work and offers it (`Instance.pull`, a `Protocol.Pull` with `take` returning leases), and whatever sits
on each edge takes from it. That is how a queue and its consumers work: the queue keeps visibility timeouts and redelivery,
and Lambda's event source mapping, a connector, does the polling (see **Edges** below). The third protocol is offered by an
edge's *target*: a component declared a `fleet` (`fleet: true`) offers its units (`Instance.fleet`), and a connector that
speaks `fleet` (a load balancer's target group) picks one for each call (see **Fleets and load balancers** below).

### Providers, regions and placement

Components are organised around **providers**. `common.*` components run on the pseudo-provider `internet` (end users, third-party HTTP services); `aws.*` run on AWS. A provider declares its regions (with coordinates), a default region and an **account schema**: the quotas that belong to an account in a region rather than to any one component (Lambda's regional concurrency, API Gateway's regional throttle, SNS publish rates, DynamoDB account throughput). Adding Cloudflare or Azure later means registering another `Provider` and its components; nothing in the core is AWS-specific.

Every node has a **placement** (`aws:eu-west-1`). Placement decides:

- **network latency**: an edge's default latency comes from the distance between its two placements (great circle at 200 km/ms with a 1.35 route factor, 1 ms inside a region, +3 ms across providers, +10 ms touching the internet). Setting an edge's latency overrides it;
- **shared quotas**: every node in a placement sees the same live account settings, and `node.shared(key, build)` hands out one resource per placement (the Lambda regional pool, the API Gateway account bucket, the DynamoDB account ledger);
- **regional faults**: `Outage`, `Errors` and `Slow` can target a placement such as `aws:us-east-1` and hit everything in it, and nothing outside it.

A **global** component (`global: true`: CloudFront, Route 53) runs at the provider's edge everywhere rather than in the region
it is placed in. Its placement still keys its quotas and its latency, but no region's or zone's fault reaches it, only its
own: losing us-east-1 takes a distribution's origins there down, not the distribution.

### Availability zones

Every region lists its **zones** (`Region.zones`): AWS's are named as AWS names them, the region's code and a letter
(`us-east-1a`...), as many as AWS's Regions page lists for it (`aws/region/catalog.ts`); a place outside any cloud has three by
assumption (`eu-west-a`...), so a self-hosted cluster can lose one too. A zone is a placement detail, not an account: quotas and
shared resources stay regional (`keyOf` ignores the zone).

- **A node can live in one zone**, written as a field beside `region` (`zone: us-east-1a`), for a single-zone resource: a
  database primary, a NAT gateway. It is part of its `Placement`. The design checks it is a zone of the node's region
  (`unknown-zone`); absent, the node is regional, as every existing design's nodes are. A field rather than a setting because
  placement is the engine's business, not each component's: faults and latency apply to any node without its component
  knowing, and one form field (the Zone selector under Region) serves every component.
- **A fleet spreads its units** over several zones by a setting of its own (`common.service`'s `zones`): see **Fleets** below.
- **Zone faults**: `Outage`, `Errors` and `Slow` can target one zone of a placement, `zone:<placement>:<zone>`
  (`zone:aws:us-east-1:us-east-1a`). They reach every node placed in that zone (the node guard adds them to its own and its
  region's) and every unit a fleet runs there. A region fault still reaches everything in the region, zoned or not.
  Components ask cheaply (`node.zones.effect(zone)`, `node.zones.down(zone)`: one check and a shared constant when nothing is
  injected anywhere) and hear about changes without a fiber (`node.zones.watch`, called synchronously after the fault set changes).
- **Latency**: two nodes in the same region that both live in zones, in different ones, are `CROSS_ZONE_MS` (0.5 ms, assumed:
  AWS says zones are up to ~100 km apart with single-digit millisecond latency) further apart than the 1 ms inside a region.
  Otherwise the edge latency model is as it was. A target group adds the same when it sends a request across zones.
- **Where you inject them**: scenarios (`inject: { target: "zone:aws:us-east-1:us-east-1a", fault: Outage }`), the CLI
  (`--fault "zone:aws:us-east-1:us-east-1a Outage at=2m"`, `docs faults`), and in the app a Region box's Faults panel ("Where":
  the whole region or one zone). A box with a zone down says so in its title; a node in that zone shows as faulted.

### Limits: hard, quota, assumed

Published limits are modelled in three ways. Each service's README lists its numbers with their source URLs, and `docs/AWS-LIMITS.md` indexes them:

- **hard**: the service enforces it and nobody can change it (DynamoDB's 1,000 writes/s per partition, Lambda's 6 MB sync payload). It is the min/max of the setting, or a read-only entry in the component's `limits`, and the UI marks it `hard`;
- **quota**: an adjustable default (Lambda's 1,000 concurrent executions, API Gateway's 10,000 rps). It is an **editable setting** whose default is AWS's published number, and the UI marks it `quota` with a link to the docs. Account-level quotas live in the document's `accounts` map and are edited per placement (each service contributes its own fields: `aws/<service>/quotas.ts`, merged by `aws/account.ts`);
- **assumed**: a number AWS doesn't publish (Lambda's idle environment lifetime, S3's first-byte latency) is a setting too, and says so in its help text.

A provider can also `audit` a design against its account's quotas: reservations that add up to more than Lambda allows, provisioned DynamoDB capacity over the account total. Findings are diagnostics.

### Containers

A component can be a **container**: it draws a boundary round other nodes instead of handling traffic. A node names its container as `parent`. `aws.region` decides the region of everything inside it (so dragging a Lambda into the Frankfurt box is how you put it in Frankfurt), and its settings are the region's account quotas; `aws.vpc` sits inside a region and holds the functions attached to it. `Design.resolve` checks that a node is accepted by its container, that a component that must sit inside another (`within`) does, and that nothing is inside itself, and reports `region-mismatch` if a node's own region disagrees with its box. Containers have a `size` in canvas units and take no part in the traffic graph (they are never sources, never "unreachable", and `Layout` skips them).

### The standard components

Each AWS service lives in its own folder, `src/simulator/aws/<service>/`, with its component(s), its slice of the account-level
quotas (`quotas.ts`), its design checks (`audit.ts`), tests, and a README that says what is simulated (a ✅/🟡/❌ coverage
table), what isn't yet, every limit with its source, the settings, the metrics and the assumptions. `src/simulator/aws/README.md`
is the guide to writing one. The READMEs are the reference; this is the overview.

**Common** (`common/`): nothing in these belongs to a provider, so they model systems with no cloud in them too.

- `common.client`: a traffic source. Poisson or constant arrivals, payload size, records per request (a batch API call), hot keys, message groups, sync or async. A chain of timers, no fiber per request. Its rate is steady: a surge, a lull or a spike is a scenario's timeline setting the rate and setting it back.
- `common.http-endpoint`: something outside your system. Latency, error rate, rate limit (429), concurrency limit (503), payload limit.
- `common.service`: identical replicas behind a load balancer (a Kubernetes Deployment, an ECS service, a team taking tickets): `replicas × concurrency` workers, a queue with a limit (503 past it), a service time, downstream calls, and a start-up time for added replicas. Gauges `ready`, `starting`, `busy`, `queued`, `utilization` (and `draining`, `ready.<zone>`); an autoscaler tracks `busy` per replica. It is built on the fleet core: optionally it spreads over `zones` (losing a zone's replicas and replacing them elsewhere, after `replaceAfter`), drains replicas it lets go (`drain`), and can be reached replica by replica through a target group.
- `common.actor`: a family of single-threaded objects addressed by key (Durable Objects, actors, per-user sessions), made on first use (a cold start) and evicted when idle. Different keys run side by side; one key runs one request at a time, so a hot key is capped at one object's pace and only its queue grows (503 past a per-object limit). It can be held busy while it calls its store downstream, as a Durable Object's input gate holds it.

The **Autoscaled cluster** example is built from these alone, with two autoscaling controllers tracking different metrics.

**AWS** (`aws/`)

| Service | What it models |
| --- | --- |
| [API Gateway](src/simulator/aws/apigateway/README.md) | REST and HTTP APIs: throttling in AWS's order (usage plan, stage and route, account), Lambda/JWT/IAM authorizers with result caching, REST response cache, integration timeouts and the 429/502/503/504 mapping |
| [CloudFront](src/simulator/aws/cloudfront/README.md) | an edge cache whose hit ratio emerges from traffic, TTL and object count; request collapsing; regional cache and Origin Shield; origin failover; error caching; invalidation; edge functions |
| [DynamoDB](src/simulator/aws/dynamodb/README.md) | provisioned and on-demand capacity (the documented doubling), per-partition hard limits and hot keys, GSIs with back-pressure on the table, LSIs, Streams (a `stream` port), TTL, global-table replication, the account ledger |
| [Lambda](src/simulator/aws/lambda/README.md) | the regional concurrency pool, reserved and provisioned concurrency, scale-up rate, cold starts, Init limit, SnapStart, timeouts, async invocation with retries, event age and destinations, SQS batches |
| [S3](src/simulator/aws/s3/README.md) | per-prefix request rates with 503 Slow Down, request kinds, multipart, directory buckets, storage classes, event notifications, replication |
| [SES](src/simulator/aws/ses/README.md) | sandbox and production quotas, throttling, the fate of each accepted message (delivered, bounced, complained, delayed), event fan-out, and the reputation thresholds that put an account in review or pause it |
| [SNS](src/simulator/aws/sns/README.md) | standard and FIFO topics, regional publish quotas, deduplication, per-subscription delivery with retries, filters as rates, dead-letter queues, bounded memory for stuck subscribers |
| [SQS](src/simulator/aws/sqs/README.md) | standard and FIFO, visibility timeouts, delay, retention, deduplication, dead-letter queues and redrive, in-flight limits, and the Lambda event source mapping with its scaling |
| [ElastiCache](src/simulator/aws/elasticache/README.md) | Valkey, Redis OSS and Memcached in front of a database: a hit ratio that emerges from keys, memory, eviction and TTL; slots and shards (hot keys), replicas, failover, stampedes and the lock that stops them; Serverless scaling |
| [EventBridge](src/simulator/aws/eventbridge/README.md), [Scheduler](src/simulator/aws/scheduler/README.md) | event buses with regional PutEvents and invocation quotas, rules as match shares with up to five targets, retries for a day, dead-letter queues, API destinations; schedules (rate, cron, one-time) for thousands of tenants and the flexible time window that spreads them |
| [Kinesis](src/simulator/aws/kinesis/README.md), [Firehose](src/simulator/aws/firehose/README.md) | data streams with per-shard write and read limits, hot shards, on-demand splitting, enhanced fan-out and the Lambda event source mapping (parallelization, bisect, poison records, iterator age); Firehose buffers landing as objects, transformation, retries and backup |
| [OpenSearch](src/simulator/aws/opensearch/README.md) | data nodes whose write and search thread pools share the CPU, 429 rejections, indexing pressure, shards and replicas (the write cost of a replica, hot shards), refresh lag, node failure and red/yellow clusters |
| [RDS](src/simulator/aws/rds/README.md) | RDS and Aurora: `max_connections` from the parameter group, connection setup cost, CPU and IOPS queues, readers, Multi-AZ failover; RDS Proxy pooling, borrow timeouts and pinning |
| [Route 53](src/simulator/aws/route53/README.md) | DNS routing (simple, weighted, failover, latency, geolocation) with health checkers and resolver caches, so failover takes detection plus the TTL |
| [Step Functions](src/simulator/aws/stepfunctions/README.md) | Standard and Express workflows: tasks in order, Parallel, Inline and Distributed Map, Wait, retriers and catchers (sagas with compensation), StartExecution and state-transition quotas |
| [WAF](src/simulator/aws/waf/README.md) | web ACLs inline in front of CloudFront, ALB or API Gateway: rate-based rules per client IP with their detection lag, managed and custom rules as match shares, capacity units, body inspection limits |
| [Region](src/simulator/aws/region/README.md), [VPC](src/simulator/aws/vpc/README.md) | the boundary boxes: placement and regional quotas; VPC address plans and quotas, NAT gateways with their connection and bandwidth limits, VPC endpoints |

## Importers

An importer is a pure function from someone else's description of infrastructure to a design: `Importer.run(text, registry, options) -> { doc, report }` (`src/simulator/importers`). It is portable like the rest of the engine, so a CLI can use it. `detect(text)` recognises text an importer can read, which is how File ▸ Open routes a CloudFormation file to the importer without being told. New importers (Terraform plan output, say) are added to `importers` in `importers/index.ts`.

The `report` is the other half of the contract: nothing is dropped silently. It lists what became components (with the source's own ids, and each node keeps `origin: {source, ref, type}` so a re-import can find and merge it), what was added that the source doesn't say (a region box, traffic sources), settings that were brought into range or couldn't be resolved, connections (stated versus inferred), and everything left out with a reason, split into things that don't change behaviour under load and things with no component yet.

**CloudFormation** (`CloudFormation.ts`, with `Intrinsics.ts` and one module per service in `importers/cloudformation/`) reads CloudFormation, SAM and `cdk synth` output as YAML or JSON. `Intrinsics.ts` parses the short forms (`!Ref`, `!GetAtt`, `!Sub`, `!If`...) and evaluates them against parameter defaults, mappings and conditions; what can't be known from the template (`Fn::ImportValue`, a parameter with no default) comes back `Unresolved`, so the component keeps its default and the report says so. The import then runs in phases:

1. **Components**: Lambda and SAM functions, SQS, SNS, DynamoDB (tables, global tables, SimpleTable), S3 and directory buckets, API Gateway REST and HTTP, CloudFront distributions, SES configuration sets, VPCs, NAT gateways and VPC endpoints, and EventBridge and Scheduler schedules (as traffic sources). Versions, aliases and function URLs are read next, so anything may name them.
2. **The wiring the template states**: event source mappings (SQS, DynamoDB streams), subscriptions, S3 notifications and replication (and CDK's `Custom::S3BucketNotifications`), integrations, authorizers, CloudFront origins, SES event destinations, SAM events, redrive and failure destinations, success destinations, aliases and async invoke config.
3. **What needs everything read first**: the number of routes of an API, an authorizer, MOCK integrations, a VPC's subnet plan, the VPC a function is in.
4. **The wiring it implies**: environment variables and permissions that name a resource (a role shared by several functions is not read as any one's behaviour; a resource that already triggers a function is not drawn back as a loop), and `ses:SendEmail` or SAM's `SES*Policy`, which connect a function to the SES node.
5. **Traffic**: a source wherever something is called from outside; the one in front of a CloudFront distribution reads, since the engine's edge default is a write that nothing would cache.

What each service takes from a template, and what it can't:

| Service | Mapped | Reported, not simulated |
| --- | --- | --- |
| DynamoDB | `BillingMode`, capacity, `OnDemandThroughput` (-1 is none), `WarmThroughput`, global indexes (count, the widest index's capacity, keys-only entry size), local indexes, `StreamSpecification`, every event source mapping or SAM `DynamoDB` event on the stream (batching, parallelization, record age, retries, bisect) with its on-failure destination on the `discarded` port, `GlobalTable` replicas (a table per region box, `replicas` edges between them) | TTL (no rate), `FilterCriteria`, `ReportBatchItemFailures`, tumbling windows, indexes that differ (modelled alike), autoscaling (its ceiling is used), `INCLUDE` projections |
| SQS | the existing settings, content-based deduplication, provisioned pollers | `ReportBatchItemFailures`, `FilterCriteria` |
| SNS | FIFO throughput scope, deduplication, maximum size, raw delivery (AWS's default off), dead-letter redrive, HTTP/S delivery policy (and AWS's default of 3 retries 20 s apart) | `FilterPolicy`, delivery policies on other protocols, a second dead-letter queue (one port) |
| Lambda | `SnapStart`, `OnSuccess` and `OnFailure` destinations (also SAM's inline form), versions and aliases' provisioned concurrency, `VpcConfig` | destinations that aren't in the template (an EventBridge bus) |
| API Gateway | endpoint type, `MOCK`, stage cache (`CacheClusterEnabled`, `CacheClusterSize`, `MethodSettings`), usage plans and keys, authorizers (`TOKEN`, `REQUEST`, `JWT`, Cognito, IAM, SAM `Auth`), routes (a CORS `OPTIONS` isn't one) | an authorizer on only some routes, mixed authorizers, partly MOCK APIs (the component has one of each per API) |
| S3 | versioning, directory buckets, event types and key filters on notifications, replication and RTC | the share a key filter lets through is assumed (half for one rule, a quarter for two) and listed; other event types (restore, tagging), EventBridge notifications; lifecycle, encryption, CORS, tags and policies are left out quietly |
| CloudFront | origins (S3 or custom, groups, shield, timeouts), cache policy TTLs (the template's or a known managed one), compression, methods, price class, edge functions, error caching | extra `CacheBehaviors`, unknown managed policies, `Lambda@Edge` as a node |
| SES | configuration set suppression and delivery window, SNS event destinations and their event types, senders by permission | `RENDERING_FAILURE` and `SUBSCRIPTION` events, Firehose, EventBridge and CloudWatch destinations; identities, templates, contact lists, pools and receipt rules are listed as skipped |
| VPC | VPC prefix, subnets as the plan, public NAT gateways (zone, addresses), endpoints (type, zones), functions inside | private NAT and Gateway Load Balancer endpoints; routes aren't read, so nothing is drawn through a NAT gateway or endpoint |

Every setting is checked against the component's schema (nodes and edges alike) and clamped to its range before it is written, and what was changed is in the report. A step that can't read a property of an unexpected shape costs that one thing, with a warning, not the import. The result is laid out with `Layout.autoLayout`, then made to respect boxes: each region's nodes in a band of their own, nodes that aren't in a VPC kept out of its box, unwired VPC members placed under the connected ones, and `fitContainers` last.

## Scenarios and the command line

A **scenario** (`Scenario.ts`) is what happens to a design, in the pure engine so any host can run one. Its shape
(`ScenarioSpec.ts`) is written in two places with the same fields: inside the design, under `scenarios.<id>` (a design
carries the scenarios written for it, since they name its nodes), and as a file of its own that adds `version` and the
`design` it is for. A scenario has a duration,
a warm-up, a traffic scale, starting overrides (by node id, edge id and placement), a **timeline** (inject a fault at a
time for a time, clear it, change a node's or edge's settings live, change account quotas), and **assertions**. `Scenario.run`
checks everything first and reports every problem at once (unknown ids, unreadable times and assertions), then runs on a
fresh virtual-time world, stopping at each timeline event to apply it, and returns a plain-data `Result`: a summary per node
and edge over the measured window (rates per second, gauges as mean/max/last, latency percentiles, totals, error ratio), the
faults that happened, each assertion with its measured value, and the alerts the run raised. Assertions are small expressions
(`<subject>.<metric>[:<aggregate>] <op> <value> [@ from..to]`; `Check.ASSERTION_SYNTAX` documents them). The language lives in
`Check.ts` (parsing, measuring frames, comparing), shared by scenarios and alarms. Percentiles over a window are a
sample-weighted estimate from per-frame summaries; maxima are exact.

A scenario is played through a `Scenario.Playback`: whoever drives time asks it where to stop next (the next event, or the
end), advances there, records the frames and applies what is due, so an event lands at exactly its time however fast the run.
`run` drives it as fast as it can; the engine drives it against the clock, so a scenario also plays live in the UI. Its
checks can be read at any moment (`progress`: each one `waiting`, `holding` or `breaking` so far, then `passed` or `failed`
when its window closes), and only what they read is kept, so a long live run doesn't hold every frame.

**Alarms** (`Alarm.ts`) are what a monitoring system would page someone about: a standard set of rules written in the check
language (errors, throttling, timeouts, expired and dead-lettered messages, an old backlog, saturation) applied to every node.
The monitor works like CloudWatch alarms: telemetry is cut into 10-second periods, a rule must breach for some consecutive
periods to fire and stay calm for three to resolve. Errors that the clients see are critical (they are what users see); errors
inside are warnings, since retries may absorb them. A component can leave out rules that don't fit it (`quietAlarms`): a
firewall's 403s are its job, so WAF has no errors alarm, and what it passes on still alarms where it lands. It is plain code
over frames, so the CLI and the engine raise the same alerts.

`src/cli` is a thin Node layer over it (an `effect/cli` command tree, file loading, rendering): `run`, `check`, `import`, `convert`,
`components`, `describe`, `examples`, `docs`. It loads designs, scenarios (resolving the design they name, which may itself
be a template an importer reads) and templates, and exits 0/1/2/3 (held / assertion failed or component crashed / bad input /
internal). `main(argv, io)` takes an `IO` object (framework output included), so the commands are tested in-process. The guide is `docs/CLI.md`.

## Edges: connectors and transport

([PRIMITIVES.md](PRIMITIVES.md) is the design this follows.)

An edge is a **connector** running over **transport**.

**Transport** (`Edge.Wire`) is what every hop costs, whatever the connector: `latency` (one-way, paid both ways, estimated
from the two placements unless set) and the edge's faults (outage, black hole, loss, added latency). A connector asks its wire
for calls and never sees latency; the wire records the edge's metrics (`calls`, `ok`, `fail`, `fail.<Tag>`, `retries`,
`latency`, `inflight`).

**A connector** (`Connector.make`) is what sits between two ports, with its own settings, probe state and behaviour. The
registry picks one for each edge: the one the document names (`connector:` on the edge), or else the most specific that fits
the two ends (one naming the source component and port beats one naming the component, which beats one naming only the
protocols). Providers bring their own (`Provider.connectors`). The ones there are:

| Connector | Fits | What it does |
| --- | --- | --- |
| `core.link` | `invoke` → `invoke` | The plain call: `weight` (share of traffic when the source routes by weight), `request` (what the call does and carries), `timeout` and `cancelOnTimeout` (by default the callee **keeps working** after the caller gives up, like most real clients), `retry` (max attempts, backoff, factor, cap and jitter, drawn from the edge's own seeded stream). |
| `core.poller` | `pull` → `invoke` | A fixed pool of `workers` that take batches, call with each and acknowledge on success; a failed batch is left to the source's lease. |
| `aws.sqs.event-source-mapping` | `aws.sqs:deliver` → `invoke` | Lambda's poller between a queue and its consumer: batching, scaling with the backlog, throttle back-off; it waits for the function rather than timing out. |
| `core.target-group` | `invoke` → `fleet` | A load balancer's target group: registers a fleet's units, checks their health across the edge, picks one per call (round robin, least outstanding requests, random, flow hash), with slow start, cross-zone balancing, fail open and a deregistration delay. Named on an edge (`connector: core.target-group`); a plain link stays the default into a fleet. |

**Reaching the far end.** A connector sometimes needs more of its target node than calls: a database's connectors register
their client's connection policy with it, a target group needs a fleet's units. A node offers what it wants to share as
`Instance.offer` (any shape, agreed between the component and its partners, who narrow it with a guard): connectors on
edges into it read it as `ctx.offer()`, and components calling it as `link.offer()` (a proxy finding the database behind it).
A fleet's units have their own typed offer (`Instance.fleet`, `ctx.target`). A connector can also share a resource with the
nodes of its target's placement: `ctx.shared(key, build)` is `node.shared(key, build)` there.

An edge's settings are flat: the source port's own fields (an SNS subscription's filter, a CloudFront origin's timeouts),
then the connector's, then transport's (`Connector.edgeSchema`). `Simulation.probeEdge(id)` returns the connector's state, and
`inspect` lists each edge's connector. In the editor a connector that isn't a plain link is drawn as a badge on the line.

Retries and orphaned work are what make retry storms and metastable failures emerge. The **Retry storm** example shows retries at every layer multiplying a slow provider's load many times over, and nested timeouts with fewer, jittered retries keeping it to a few times.

## Fleets and load balancers

A **fleet** is a component whose capacity is a number of identical units (EC2 instances, ECS tasks, pods, replicas), each
with a zone, a life and workers of its own: requested → starting (phases the service gives: launch, boot, image pull, start)
→ grace → in service → draining → terminated. `fleet/Fleet.ts` is the provider-neutral core; a component builds one in `make`,
passes it the numbers it reads from its settings (desired count, min and max, zones, phases, grace, workers, line and
backlog limits, drain time, detection time, an account-capacity hook, interruptions) and hands it its calls. The fleet keeps
the number of units at the desired count (a setting, so `core.target-tracking` drives it), spreads launches evenly over its
zones, loses a zone's units when it goes down and replaces them in the others once it notices, rebalances (new before old)
when the zone returns, drains what it lets go (no new calls, in-flight ones finish, cut off when the drain time runs out),
takes interruptions with a notice (Spot), and refuses launches past an account quota. `src/simulator/fleet/README.md` is the
guide for building EC2, ECS and EKS on it.

A fleet is reached two ways:

- **A plain edge** (a client calling a service directly) is a call into the node: it waits in the fleet's one line and runs
  on the first unit with a free worker, an idealised balancer that knows at once which units are dead. `common.service` built
  this way plays every scenario of the cluster and retry-storm examples bit for bit as it did before.
- **A load balancer** puts a **target group** on the edge (`core.target-group`, or its own connector over
  `fleet/TargetGroup.ts`). That edge's connector speaks a third protocol, `fleet`: the target node offers its units
  (`Instance.fleet`: each unit that is up, a watch for units coming up, draining and going, a health answer per unit, `serve`
  a call on a unit, health reports back, a hold on draining units), and the connector picks a unit for every call and sends it
  through the edge's transport addressed to that unit (`Wire.call(message, policy, done, unit, extraMs)`). Health checks
  cross the same transport with `Wire.ping` (latency, the edge's faults, a timeout) without counting as requests, so a dead
  unit keeps getting requests (which fail) until its checks catch it, and a black-holed edge fails its checks too.

Why this design. The choosing and the health checking belong to neither end: a fleet doesn't know how its balancer picks,
and a load balancer's listener doesn't care which unit answers, only how to turn failures into 502, 503 and 504. That is
exactly what a connector is for (as Lambda's event source mapping sits between a queue and its consumer), and a target
group in AWS is a resource of its own between the two. Making the *target end* offer its units, symmetrical to a `pull`
source offering work at the source end, needed no new port kind on the balancer: its port stays an ordinary `invoke` port,
so the same balancer can target a Lambda function (a plain link) or a fleet (a target group), and a plain client still gets
today's service. Calls keep going through the edge's transport and the target node's guard, so latency, edge faults, the
node's own and its region's faults, and both ends' metrics are what they are for any call; the fleet adds its zones'
faults for the unit that runs it. The alternatives were worse: a balancer reaching into the fleet from its own component
would bypass the edge (no latency, faults or edge metrics), and per-unit nodes in the design would make a 500-unit fleet
500 nodes and an autoscaler an editor of the graph.

## Controllers

A **controller** (`Controller.make`) is a loop attached to a node that watches it, decides and acts on the virtual clock:
an autoscaler, an operator's runbook, a chaos schedule. It observes only what anyone can see (the node's metrics each frame,
its settings) and acts only through the channels a person editing the live design has: changing one of the node's settings,
validated exactly as an edit is, and starting or ending a fault on it. So its decisions are deterministic and visible: its
own metrics arrive in frames under `controllers`, `Simulation.probeController(id)` returns its state and what it said it
decided, and `configureController` edits it live.

A document attaches controllers by id:

```yaml
controllers:
  worker-autoscaler:
    type: core.target-tracking
    target: worker
    settings: {metric: concurrent, targetValue: 0.7, setting: provisioned, min: 1, max: 100}
```

The design checks each attachment: the type exists, the target exists and is something it can control, and its settings
make sense on that target (`check`: a target-tracking controller naming a setting the target doesn't have, or one that isn't
a number, is an error; one not told what to change yet is a warning, and does nothing). Removing a node removes its controllers.

| Controller | What it does |
| --- | --- |
| `core.target-tracking` | Keeps a metric (a gauge, a rate, or a percentile like `latency.p95`) near a target by scaling one numeric setting, the way Kubernetes' horizontal autoscaler and Application Auto Scaling do: averaged over a window, decided every period, within a minimum and maximum, a tolerance band, and separate scale-out and scale-in cooldowns. Per unit (`ceil(total / target)`) or in total (in proportion). The metric may be another node's (`source`): a queue's backlog per worker instance. |

In the editor a node's panel lists its controllers with their settings and live metrics, and offers the ones that fit; a
controlled node carries a badge on the canvas. Live edits are checked again as they are made (the engine keeps its copy of
the document in step), so a controller pointed at a setting the node lacks is flagged at once.

## Faults

Faults are universal: the framework applies them around every node and edge, so no component has to support them. Each kind is a tagged Schema, so it can be validated, sent over a wire and described to a UI.

| Fault | Targets | Effect |
| --- | --- | --- |
| `Outage` | node, edge, region, zone | Rejects every call at once. On a region (`aws:us-east-1`), everything in it; on a zone (`aws:us-east-1:us-east-1a`), the nodes placed in it and the fleet units running there. |
| `Errors { rate }` | node, region, zone | A fraction of calls fail after being processed. |
| `Slow { extra }` | node, edge, region, zone | Adds fixed latency. |
| `Blackhole` | edge | Calls vanish; callers wait out their timeout. |
| `Loss { rate }` | edge | A fraction of calls vanish. |
| `Crash { units, on }` | node (fleets) | That many of a fleet's units crash at once (or hosts, for ECS on EC2 and EKS): calls on them fail, a balancer sends them traffic until its checks catch them, and the fleet replaces them when it notices. An instant, not a span. |

Faults can carry a duration and lift themselves. `Faults.changes` is a `Stream` of the active set.

**What a component can see of them.** The engine refuses a call to a node with an `Outage` before its handler runs, so most
components never think about faults. One that reacts to them reads `node.faults`, synchronously and cheaply (one check and a
shared constant while nothing is injected anywhere):

| | |
| --- | --- |
| `node.faults.own()` | The node's own faults and its region's, added up (`outage`, `extraMs`, `errorRate`): what the engine applies to its calls. |
| `node.faults.zone()` | The faults on the zone it is placed in (its `zone`); nothing for a node in no zone. |
| `node.faults.active()` | Every active fault that reaches it (on it, its region, its zone), as data: kind, target, start, end. |
| `node.faults.watch(fn)` | Hear, synchronously and after the fact, when the set of faults changes; read again then. Returns an unsubscribe. |
| `node.zones` | The region's zones (`all`), any zone's faults (`effect(zone)`, `down(zone)`) and the same `watch`: for a component that places parts of itself in zones (a fleet, a standby). |

So a database sees an outage on itself begin (its primary failing: start a failover) and end, without inferring it from
its clients' failures. And a **Multi-AZ resource** keeps serving through its zone's outage: a component declared
`handlesZoneFaults: true` is not refused by the engine when the zone its node is placed in fails (its own and its region's
faults still are); it reads `node.faults.zone()`, fails over to a standby in another zone (refusing calls itself for the
failover time), and serves from there. A component that spreads over zones without a node zone of its own (a fleet) reads
`node.zones.effect(zone)` for each of its parts instead.

## Telemetry

Each node and edge has a meter. Once per frame (250 ms of virtual time by default) the simulation flushes them into a `Frame`: counters become per-second **rates**, samples become **percentiles** (`latency`, `age`), and gauges (a plain function, or any `Effect<number>`) are read. Counters and samplers are handles resolved once (`meter.counter("ok").n++`, `meter.sampler("latency").add(ms)`), and samples live in preallocated typed arrays. Frames are plain Schema-described data and arrive as `Simulation.frames` (a `Stream`) or from `advance`/`advanceTo`.

**Dashboards** (`Dashboard.ts`) say what a component's or a connector's metrics look like on screen: key figures and
charts, each line a metric (a rate, a gauge, a statistic of a distribution, or a ratio or sum of them, so an average item
size is bytes over items), mirroring the service's CloudWatch metrics. They are data in the manifest; the UI evaluates them
against frames (`Dashboard.valueOver`), averaging each point over a stretch of time aligned to the clock so a chart never
re-draws what it has already drawn. A component without one gets `Dashboard.generic`; every edge shows `Dashboard.transport`
and then its connector's. A panel that doesn't apply to a node's configuration (it reads only gauges the node never
registered, or `requires` one it didn't) is hidden (`Dashboard.applies`).

## Designs

```
Doc (JSON, string-keyed, settings = overrides)  ⇄  Design (Graph of configured components)
```

- **`Doc`** is what lives on disk. Nodes and edges are keyed by id so diffs are clean and an importer (CloudFormation, say) can re-run and merge by id; `origin` records where something came from. Settings hold only chosen overrides.
- A `Doc` also carries its **scenarios** (`scenarios.<id>`, see below): they name its nodes and edges, so they travel and are versioned with it. The codec ignores them; `Scenario.check` and `infra-sim check` test them against the design.
- **`Design.codec(registry)`** is a real `Schema` from `Doc` to `Design`. It validates every node's settings against its component schema and every edge's against the edge policy plus its port's settings, checks the wiring, and **reports every problem in one pass, each located by id** (`nodes.worker.settings.concurrency`). It composes: `Schema.fromJsonString(Design.codec(registry))` goes straight from file text to a design. `Design.encode` writes a design back in full.
- **`Design`** is a `Graph.DirectedGraph<Node, Edge>` plus id↔index maps. Node `config` is decoded and fully defaulted.
- **`Topology`** answers graph questions: `downstream`/`upstream` (blast radius), `sources`, `reachable`, `feedbackLoops` (strongly connected components, where retries can amplify), `toMermaid`.
- **`Diagnostics.diagnose`** combines decode errors with graph warnings (feedback loops, unreachable nodes, unconnected clients).
- **`Layout.autoLayout`** places nodes with no position (imports have none): columns by distance from a source, cycles tolerated, barycentre ordering.
- **`Builder`** builds a `Doc` in code, which is also the shape an importer wants.
- **`DesignSchema`** generates the JSON Schemas of design and scenario files from the registry (the same `Describe` fields the forms use): a node's settings are checked by its `type` (`if`/`then`), an edge's against everything that can sit on an edge, durations accept milliseconds or text. Draft-07, for every editor. Committed in `schema/` (`npm run schema`; a test keeps them current) and published with the site; designs point at them with a `# yaml-language-server: $schema=...` line.

## The running simulation

```ts
const program = Effect.gen(function*() {
  const sim = yield* Simulation
  yield* sim.advance("2 minutes")
  const queue = yield* sim.probe("orders-queue")   // { inflight, totals, state: { ready, hidden, oldestAge, sample… } }
  const all   = yield* sim.inspect                  // time, every node's live config + state, edges, active faults
  yield* sim.configureNode("worker", { concurrency: 40 })   // live, validated, typed errors
  yield* sim.faults.inject({ kind: "node", id: "table" }, { _tag: "Outage" }, "30 seconds")
}).pipe(Effect.provide(Simulation.layer(design)))
```

`probe` and `inspect` return JSON-safe data described by Schemas (`NodeProbe`, `Inspection`); each component's `state` schema encodes its probe output, and configuration comes back encoded (durations in ms). Errors are typed (`NoSuchNode`, `NoSuchEdge`, `InvalidConfig` with issues, `NoSuchTarget`, `ComponentCrashed`).

## The engine

`Engine` is an actor for hosts. `send(command)` queues a command; handled strictly in order. `events` is a `Stream`. Both are Schemas, and commands are accepted in encoded JSON form and decoded at the door, so the same protocol works over a function call, `postMessage` or a socket.

- **Commands:** `load`, `play`, `pause`, `reset`, `setSpeed`, `step`, `updateNode`, `updateEdge`, `updateAccount`, `updateController`, `inject`, `clearFault`, `clearFaults`, `scenario`, `clearScenario`. A live edit is also applied to the engine's copy of the document and the design is checked again; `diagnostics` is sent when what the checks find changes. A `scenario` is checked before anything is torn down, then plays from t = 0: its overrides stay on top of live edits, `load` and `reset` start it again (or drop it, with the reasons, if the design no longer has what it names), and the run pauses at its end.
- **Events:** `status` (phase, virtual time, speed, achieved speed, seed), `frames`, `faults`, `diagnostics`, `alerts` (when an alarm fires, resolves or moves), `scenario` (a scenario's progress, about ten times a second while it plays), `reset`, `rejected` (a refused command, with the reasons).
- **Catalog:** component manifests (with derived forms, and each port's protocol), connector manifests, transport's form, and the fault kinds.
- **Pacing:** a loop on the *real* clock sleeps about 16 ms, then advances virtual time by `elapsed × speed` within a wall-time budget, reporting the speed actually achieved when it can't keep up. A long stall (a hidden tab) is clamped rather than simulated in one burst.

## Performance

A busy design makes hundreds of thousands of calls per simulated minute, so the cost of one call is the whole story. Measured on a large design (some eighty components) at ten times its traffic, a run went from about 3.8× real time to about 26×, and the minimal client → endpoint path from roughly 20 µs a request to under 3. What changed, and the rules that keep it that way:

- **An edge call is a state machine, not a pipeline of effects.** `Edge.Link.send(message, done)` runs latency, timeout, retries with backoff and faults as a handful of world timers in plain JS, and forks one fiber only for the callee. `invoke` is a thin `Effect.callback` over it. (The previous `raceFirst` + `forkDetach` + `Effect.retry` cost dozens of effects and several fibers per call.)
- **The node guard watches from outside.** Each call to a node starts its handler in a fiber with a ready-made context (`world.spawn(effect, context)`), and counts the outcome from the fiber's exit observer. Nothing wraps the handler's effect.
- **Handlers decide synchronously and only wait with an effect.** `node.fast` gives settings, time, the node's random stream, `after` timers, `mint` and the account quotas as plain calls, and `Flow` gives the waits: `Flow.delayed` and `Flow.wait` are one timer-backed callback, and `Flow.fanOut`/`sequence`/`parallel`/`forEach`/`Lanes` call several things with callbacks. A handler that is mostly decisions (DynamoDB, S3, API Gateway) is a plain function returning one of these, instead of a generator with a dozen `yield*`s. Lambda and SQS are explicit state machines on top of `WarmPool` (a stack of idle timestamps with lazy expiry) and small poller objects.
- **Shared primitives instead of per-component machinery.** `Limiter` is a sync token bucket over the virtual clock (`takeUnsafe`); `Distribution.latencyMs` samples a lognormal from a seeded source with its shape cached per setting; `Faults.forNodeUnsafe` returns a shared constant when nothing is injected. Derived values that many calls need (a table's capacity, a function's standing against the regional pool) are memoised against the identity of the settings, quotas and shared claims they come from.
- **Clients are timer chains.** A traffic source never forks per request: it arms a timer for the next arrival and calls `link.send`.
- **Metrics are handles.** No string-keyed lookup on the hot path.
- **The engine runs in a Web Worker in the browser** (`src/ui/state/engine.worker.ts`), batching events every 50 ms, and the page redraws on a fixed 250 ms cadence however fast frames arrive, so a fast simulation can use a whole core without costing the UI a frame.

Still Effect-native where it is not hot: setup, `Component.make`, `Simulation`/`Engine` services, the schemas, probes and inspection.

To profile: `scratchpad/bench.ts` (a design for N virtual seconds at a traffic multiplier, CPU time), `scratchpad/bench-components.ts` (each component alone behind a client), and `scratchpad/prof.sh` (bundles with sourcemaps, runs under `--cpu-prof`, attributes time to source lines). Compare on CPU time and repeat: wall time moves with whatever else the machine is doing.

## Testing

`src/simulator/**/*.test.ts` (run with `npm test`). The suite checks behaviour, not just plumbing:

- determinism, and independence of unrelated nodes' randomness;
- zones (names, placement, faults, latency) and fleets (spreading, losing and replacing a zone, rebalancing, draining, quotas,
  interruptions, grace) and target groups (a dead unit served until its checks catch it, fail open, slow start, least
  outstanding requests against round robin with a slow unit, cross-zone off, flow hash, deregistration with no lost request);
- queueing sanity (latency ≈ service time + network, Little's law for busy workers, throttling at capacity);
- SQS semantics (backlog, visibility-timeout redelivery, dead-lettering, duplicate processing, live scale-up);
- retry multiplication and orphaned work, weights, token-bucket throttling, topic fan-out;
- fault injection and expiry; the codec (defaults, durations, round-trip, `fromJsonString`, all errors at once with id paths); probing, inspection, live configuration and frame streaming;
- the engine over a controllable `TestClock`.

## The UI

The canvas gets the room: a 40 px header holds the transport (a draggable, log-scale speed bar), the whole design's numbers as its clients see them (requests, errors, p95 latency, with a minute of sparkline) and the count of alerts firing. Selecting a node or connection lights up the path it is on and dims the rest. Under the canvas a dock, folded by default, has three tabs: charts for the selection, alerts (firing, then a history with the faults beside them; click one to see its node), and scenarios (the open design's own: pick one, then watch its track, timeline and checks until it stops with a verdict; a scenario file can be added to the design if everything it names is there).

Two tabs at the top left of the stage switch between the canvas (**Visual**) and the design as YAML (**Editor**): Monaco with monaco-yaml, the YAML language server VS Code uses, given the design schema, so completion, hover and validation are the ones a design file gets in VS Code. The simulator's own checks (`Diagnostics.diagnose`) are added as markers at the node or edge they name. What is typed is a draft (`state/editor.ts`) until ⌘S or going back to Visual applies it as one undoable edit; a draft that isn't a design says why and isn't applied. Monaco loads only when the tab is first opened. Two adaptations, both in `src/ui/editor/monaco.ts` and `vite.config.ts`: since Monaco 0.56 `createWebWorker` takes a ready worker, so monaco-yaml gets Monaco's internal adapter that finds a worker by label; and its worker imports `monaco-editor/esm/vs/...`, which Monaco 0.57's exports map closes, so Vite aliases that path.

What is selected is configured in a **settings dialog** over the canvas (`ui/SettingsDialog.tsx`, the panels in `ui/Inspector.tsx`): a gear appears on a selected node, box or connection, and a double-click opens it too. It doesn't block the canvas, follows the selection, can be dragged by its title bar, and closes with Escape (a second Escape deselects). The sidebar is the component picker only.

The canvas is [React Flow](https://reactflow.dev) (`@xyflow/react`), driven by the document: nodes and edges are derived from it (reusing objects whose inputs didn't change, so dragging one node redraws one node), and what React Flow reports becomes an edit (a drag through `beginMove`, which carries a box's contents; a wire through `connect`, which can be dropped anywhere on its target). React Flow owns pan and zoom; `canvas/viewport.ts` mirrors it for the rest of the app. Boxes draw behind wires and wires behind components (explicit z-indexes), and box resize corners live in React Flow's viewport portal above everything, where a node inside a box can't cover them. A card's live numbers are a component of their own, so the card and its React Flow handles re-render only when its health, faults or alerts change.

One sidebar: a condensed component picker (grouped by provider, searchable, with examples). Settings live in the settings dialog. Forms are derived from the schema: every bounded number is a slider (logarithmic when the range spans three orders of magnitude), durations are typed with units (`250`, `1.5s`, `10m`), limits show as `hard` or `quota` pills linking to their source, and groups with an `enabled` switch collapse until it is on. A node's region is a selector, locked when a Region box decides it; a Region box shows its account quotas and takes regional faults. Containers are drawn as boxes behind their contents: drag one and its contents move, drop a node inside to adopt it, drag it out to release it.

## Known gaps and next steps

What each service doesn't simulate yet is in its README ("Not yet simulated"). The items below are the ones that need a change
to the engine itself, and several services asked for the same thing, so they are the most useful to do next.

**The call and the message**

- **Partial results.** A success can now name the records of its batch that failed (`ItemFailures`), and SQS → Lambda uses it
  for `ReportBatchItemFailures`. Still to use it: DynamoDB Streams → Lambda (its polling isn't a connector yet), DynamoDB
  `UnprocessedItems`, and S3/SES per-recipient outcomes.
- **What a message says.** `Message` has `operation: read | write` and nothing about the item or the event. Services want: a request
  kind (S3's get/head/list/put/copy/delete, today four bucket-wide share settings), an event kind (SES bounce vs delivery),
  an item identity (DynamoDB transaction conflicts, per-key stream ordering), a deduplication id and a per-message delay (SQS).
- **Who calls with what.** An edge stamps its `request.operation` on the call (default `write`), so a client wired to
  CloudFront or S3 writes unless the edge is set to read. A hop that only passes calls on (WAF, a load balancer, a cache)
  sets `caller` on its out edge to keep what it was asked. A client still sends one operation per edge: a mixed read/write
  share on one edge would need a client setting.
- **Batches of keys.** A message has one `key`, so a batch of records (`count` > 1: a client's `records`, a stream
  consumer's batch) lands on one partition downstream, as if every record had the same key. A batch should carry how its
  keys are spread, and stores should spread its units over their partitions accordingly.
- **Control actions.** Start or cancel a SQS redrive, `ChangeMessageVisibility`: a channel from a caller to a component besides the call.

**The design and its checks**

- **Audits see nodes, not edges or containers.** Checks like "FIFO subscribers must be SQS", more than 100 subscriptions on a
  topic, quotas counted per VPC, or a Lambda in a VPC with no NAT calling the internet need edges and parents in `Provider.audit`'s input.
- **Zones, next.** EC2 Auto Scaling, the load balancers, RDS, ElastiCache and OpenSearch place what they run in zones and
  fail over when one goes down. Still to do: the NAT gateway has its own `zone` setting (a letter) rather than the node's
  zone, VPC subnets aren't per zone, a zone's Slow and Errors faults don't reach ElastiCache's or OpenSearch's nodes, and a
  zone that is slow or lossy *between* zones (a partition) isn't a fault yet.
- **Routing through a container.** A call that leaves a VPC without a NAT or endpoint should fail like it does in AWS; that needs a routing hook on `Container`.

**Edges, retries and faults**

- **Retries.** `Edge.retryWith` caps at 100 attempts and has one backoff shape, where SNS delivers for 23 days on a phased schedule.
- **Faults.** There is no fault that fails *after* a timeout rather than at once, so an unreachable origin can't be told from a slow one
  (CloudFront's connection timeout); clients record latency only for successes, so time-to-failure can't be measured.
- `Setting.latency` caps a mean at 10 minutes, too short for SES retries and complaint delays (SES defines its own setting).

**Beyond AWS**

- Cloudflare and Azure providers; cross-region and cross-provider partitions.
- EventBridge, Kinesis, Step Functions, ALB/ECS, RDS/Aurora, ElastiCache, OpenSearch (the fleet core and the target group are
  there for EC2 Auto Scaling, ELB, ECS and EKS to build on).
- Circuit breakers and bulkheads, hedged requests; policy as an ordered list of tagged members, so order is expressible.
- The importer reading other sources (Terraform plan output, CDK constructs).
