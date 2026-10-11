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
| `Edge` | Edge policy: latency, timeout, retry/backoff, weight. |
| `Component`, `Registry` | The component definition API and the set of components a design may use. |
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
    return {
      call:  (msg) => /* handle an inbound call: Effect<void, CallFailure> */,
      probe: /* Effect<State> */
    }
  })
})
```

The framework supplies everything around it: edge policy, faults, metrics, per-node seeded `Random`, virtual time. Every node is wrapped so it automatically records `in`, `ok`, `fail`, `fail.<Tag>`, `latency`, message `age` and an `inflight` gauge, applies faults, and contains defects (a throwing component fails the call with `Failed` and is logged, instead of killing the run).

All interaction is call semantics: `Effect<void, CallFailure>`. Async decoupling comes from components that buffer (queue, topic).

### Providers, regions and placement

Components are organised around **providers**. `common.*` components run on the pseudo-provider `internet` (end users, third-party HTTP services); `aws.*` run on AWS. A provider declares its regions (with coordinates), a default region and an **account schema**: the quotas that belong to an account in a region rather than to any one component (Lambda's regional concurrency, API Gateway's regional throttle, SNS publish rates, DynamoDB account throughput). Adding Cloudflare or Azure later means registering another `Provider` and its components; nothing in the core is AWS-specific.

Every node has a **placement** (`aws:eu-west-1`). Placement decides:

- **network latency**: an edge's default latency comes from the distance between its two placements (great circle at 200 km/ms with a 1.35 route factor, 1 ms inside a region, +3 ms across providers, +10 ms touching the internet). Setting an edge's latency overrides it;
- **shared quotas**: every node in a placement sees the same live account settings, and `node.shared(key, build)` hands out one resource per placement (the Lambda regional pool, the API Gateway account bucket, the DynamoDB account ledger);
- **regional faults**: `Outage`, `Errors` and `Slow` can target a placement such as `aws:us-east-1` and hit everything in it, and nothing outside it.

### Limits: hard, quota, assumed

Published limits are modelled in three ways, and `docs/AWS-LIMITS.md` records every number with its source URL:

- **hard**: the service enforces it and nobody can change it (DynamoDB's 1,000 writes/s per partition, Lambda's 6 MB sync payload). It is the min/max of the setting, or a read-only entry in the component's `limits`, and the UI marks it `hard`;
- **quota**: an adjustable default (Lambda's 1,000 concurrent executions, API Gateway's 10,000 rps). It is an **editable setting** whose default is AWS's published number, and the UI marks it `quota` with a link to the docs. Account-level quotas live in the document's `accounts` map and are edited per placement;
- **assumed**: a number AWS doesn't publish (Lambda's idle environment lifetime, S3's first-byte latency) is a setting too, and says so in its help text.

A provider can also `audit` a design against its account's quotas: reservations that add up to more than Lambda allows, provisioned DynamoDB capacity over the account total. Findings are diagnostics.

### Containers

A component can be a **container**: it draws a boundary round other nodes instead of handling traffic. A node names its container as `parent`. `aws.region` decides the region of everything inside it (so dragging a Lambda into the Frankfurt box is how you put it in Frankfurt), and its settings are the region's account quotas; `aws.vpc` sits inside a region and holds the functions attached to it. `Design.resolve` checks that a node is accepted by its container, that a component that must sit inside another (`within`) does, and that nothing is inside itself, and reports `region-mismatch` if a node's own region disagrees with its box. Containers have a `size` in canvas units and take no part in the traffic graph (they are never sources, never "unreachable", and `Layout` skips them).

### The standard components

**Common**

- `common.client`: a traffic source (nothing connects into it). Poisson or constant arrivals, optional spike, payload size, hot keys and message groups (to exercise partitions and FIFO), sync or async invocation. Splits by edge weight. Records `sent`, `ok`, `fail` and end-to-end `latency`.
- `common.http-endpoint`: something outside your system: a payment provider, a partner webhook. Latency distribution, error rate, rate limit (429), concurrency limit (503), maximum payload.

**AWS** (each with its published limits; see `docs/AWS-LIMITS.md`)

- `aws.apigateway`: REST or HTTP API. Account and stage token buckets (429), integration timeout (504, with the backend left running), payload limit (413), 502 on backend failure.
- `aws.lambda`: execution environments in a `Pool` with a TTL (cold starts, idle expiry), regional concurrency shared by every function in the account, reserved and provisioned concurrency, the scale-up rate (1,000 environments per 10 s), memory-proportional CPU, timeouts, payload limits, asynchronous invocation with retries, maximum event age and an on-failure destination, and batch handling for SQS.
- `aws.sqs`: standard and FIFO queues. Visibility timeouts, retention, delay, in-flight limits, a DLQ port, FIFO group ordering and throughput limits (with the regional high-throughput quota), and an event-source-mapping poller that ramps 5 → +300/min → 1,250 concurrent batches as the backlog grows.
- `aws.sns`: regional publish quotas, FIFO per-group limits, subscriptions delivered asynchronously with AWS's delivery-retry policy.
- `aws.dynamodb`: provisioned and on-demand capacity units by item size and consistency, partitions with the hard 3,000-read / 1,000-write per-second ceiling (hot keys), burst capacity, on-demand scaling to double the previous peak, per-table and per-account quotas, the 400 KB item limit.
- `aws.s3`: per-prefix request rates (3,500 writes/s, 5,500 reads/s) with 503 Slow Down, first-byte latency plus transfer time, and event notifications on an `events` port.
- `aws.region` and `aws.vpc`: containers, above.

## Edges: the policy layer

Every edge, whatever it connects, has the same settings (`Edge.Config`), plus any extra the source port declares:

- `weight`: share of traffic when the source routes by weight.
- `latency`: one-way network latency, paid both ways.
- `timeout` and `cancelOnTimeout`: by default the callee **keeps working** after the caller gives up (wasted work, like most real clients); turn the option on to cancel it instead.
- `retry`: max attempts, initial backoff, factor, cap and jitter: exponential, capped, optionally fully jittered, with the draw taken from the edge's own seeded random stream.

Retries and orphaned work are what make retry storms and metastable failures emerge. The **Retry storm** example shows a dependency that never recovers after its trigger has gone.

## Faults

Faults are universal: the framework applies them around every node and edge, so no component has to support them. Each kind is a tagged Schema, so it can be validated, sent over a wire and described to a UI.

| Fault | Targets | Effect |
| --- | --- | --- |
| `Outage` | node, edge, region | Rejects every call at once. On a region (`aws:us-east-1`), everything in it. |
| `Errors { rate }` | node, region | A fraction of calls fail after being processed. |
| `Slow { extra }` | node, edge, region | Adds fixed latency. |
| `Blackhole` | edge | Calls vanish; callers wait out their timeout. |
| `Loss { rate }` | edge | A fraction of calls vanish. |

Faults can carry a duration and lift themselves. `Faults.changes` is a `Stream` of the active set.

## Telemetry

Each node and edge has a meter. Once per frame (250 ms of virtual time by default) the simulation flushes them into a `Frame`: counters become per-second **rates**, samples become **percentiles** (`latency`, `age`), and gauges (a plain function, or any `Effect<number>`) are read. Counters and samplers are handles resolved once (`meter.counter("ok").n++`, `meter.sampler("latency").add(ms)`), and samples live in preallocated typed arrays. Frames are plain Schema-described data and arrive as `Simulation.frames` (a `Stream`) or from `advance`/`advanceTo`.

## Designs

```
Doc (JSON, string-keyed, settings = overrides)  ⇄  Design (Graph of configured components)
```

- **`Doc`** is what lives on disk. Nodes and edges are keyed by id so diffs are clean and an importer (CloudFormation, say) can re-run and merge by id; `origin` records where something came from. Settings hold only chosen overrides.
- **`Design.codec(registry)`** is a real `Schema` from `Doc` to `Design`. It validates every node's settings against its component schema and every edge's against the edge policy plus its port's settings, checks the wiring, and **reports every problem in one pass, each located by id** (`nodes.worker.settings.concurrency`). It composes: `Schema.fromJsonString(Design.codec(registry))` goes straight from file text to a design. `Design.encode` writes a design back in full.
- **`Design`** is a `Graph.DirectedGraph<Node, Edge>` plus id↔index maps. Node `config` is decoded and fully defaulted.
- **`Topology`** answers graph questions: `downstream`/`upstream` (blast radius), `sources`, `reachable`, `feedbackLoops` (strongly connected components, where retries can amplify), `toMermaid`.
- **`Diagnostics.diagnose`** combines decode errors with graph warnings (feedback loops, unreachable nodes, unconnected clients).
- **`Layout.autoLayout`** places nodes with no position (imports have none): columns by distance from a source, cycles tolerated, barycentre ordering.
- **`Builder`** builds a `Doc` in code, which is also the shape an importer wants.

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

- **Commands:** `load`, `play`, `pause`, `reset`, `setSpeed`, `step`, `updateNode`, `updateEdge`, `inject`, `clearFault`, `clearFaults`.
- **Events:** `status` (phase, virtual time, speed, achieved speed, seed), `frames`, `faults`, `diagnostics`, `reset`, `rejected` (a refused command, with the reasons).
- **Catalog:** component manifests (with derived forms), the universal edge form, and the fault kinds.
- **Pacing:** a loop on the *real* clock sleeps about 16 ms, then advances virtual time by `elapsed × speed` within a wall-time budget, reporting the speed actually achieved when it can't keep up. A long stall (a hidden tab) is clamped rather than simulated in one burst.

## Performance

A busy design makes hundreds of thousands of calls per simulated minute, so the cost of one call is the whole story. Measured on the POS Hub example (130 nodes) at ten times its traffic, a run went from about 3.8× real time to about 26×, and the minimal client → endpoint path from roughly 20 µs a request to under 3. What changed, and the rules that keep it that way:

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
- queueing sanity (latency ≈ service time + network, Little's law for busy workers, throttling at capacity);
- SQS semantics (backlog, visibility-timeout redelivery, dead-lettering, duplicate processing, live scale-up);
- retry multiplication and orphaned work, weights, token-bucket throttling, topic fan-out;
- fault injection and expiry; the codec (defaults, durations, round-trip, `fromJsonString`, all errors at once with id paths); probing, inspection, live configuration and frame streaming;
- the engine over a controllable `TestClock`.

## The UI

One sidebar. With nothing selected it is a condensed component picker (grouped by provider, searchable, with examples); select a node, a container or a connection and it becomes that thing's settings. Forms are derived from the schema: every bounded number is a slider (logarithmic when the range spans three orders of magnitude), durations are typed with units (`250`, `1.5s`, `10m`), limits show as `hard` or `quota` pills linking to their source, and groups with an `enabled` switch collapse until it is on. A node's region is a selector, locked when a Region box decides it; a Region box shows its account quotas and takes regional faults. Containers are drawn as boxes behind their contents: drag one and its contents move, drop a node inside to adopt it, drag it out to release it.

## Known gaps and next steps

- Tests for SNS, DynamoDB, API Gateway, S3, the HTTP endpoint and regional behaviour are not written yet, and `Design.test.ts`, `Probe.test.ts` and `Engine.test.ts` still use the old generic component types and need porting.
- `aws.vpc` only groups and bounds addresses; NAT, endpoints and ENI limits are not modelled.
- S3 multipart upload, storage classes, lifecycle and replication; EventBridge, Kinesis, ALB/ECS; partial batch responses for SQS → Lambda.
- Cloudflare and Azure providers, cross-region and cross-provider partitions.
- The engine runs at roughly 40–55× real time; profiling the node guard and edge hot paths should win some of the cost back.
- Circuit breakers and bulkheads, hedged requests; policy as an ordered list of tagged Schema members (timeout, retry, breaker…), so order is expressible.
- An importer (CloudFormation → `Doc`) using `Builder`, `origin` and `Layout`: the container model maps naturally onto `AWS::EC2::VPC` and the stack's region.
