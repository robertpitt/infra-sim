# The primitives

(See [SIMULATOR.md](SIMULATOR.md) for how the engine works today.)

The engine started as an AWS simulator. The goal is wider: one small core that can run any system made of parts that hold
work, use up capacity and talk to each other: every cloud provider (AWS first, Cloudflare and its Durable Objects next),
Kubernetes, and things that aren't software at all. This document fixes the vocabulary of that core, says what each piece
is for, and tracks how far the code has moved to it.

The test for whether something belongs in the core: **could a system with no cloud in it need it?** A queue of customers
in a coffee shop needs capacity, waiting, time and a path between two places. It doesn't need a region, an account, or a
"read vs write" operation. Those belong to a provider package.

## The primitives

| Primitive | What it is | Today |
| --- | --- | --- |
| **Time** | The virtual-time world: a timer heap with its own `Clock` and `Scheduler`. The only source of time. | `VirtualTime` |
| **Node** | Something that holds state and capacity and handles work: a queue, a function, a table, a barista. | `Component` |
| **Port** | A named place on a node where connections attach, speaking one **protocol**. | `PortDef` with `protocol` |
| **Protocol** | How two things exchange work across a port. `invoke` (push, request and response) and `pull` (the owner holds work, someone takes it). | `Protocol.ts` |
| **Connector** | A first-class, typed, possibly active thing between two ports, with its own settings, state and behaviour. The default is a plain link. | `Connector.ts` |
| **Transport** | What every hop between two nodes costs: latency, loss, faults. Every connector's calls go through it; connectors never see latency. | `Wire` in `Edge.ts` |
| **Message** | A unit of work. Batches are first class: a message carries a count of records, which are named by position, and says when it is a batch a taker handed over. | `Message` (`count`, `batched`) |
| **Outcome** | How a call ended: success, a typed failure, or a success that names the records of its batch that failed. | `CallFailure`, `Reply`, `ItemFailures` |
| **Resource** | Something finite that work waits for or is refused by: a rate (token bucket), a pool of slots, a capacity. | `Limiter`, `WarmPool`, `kit/Slots` |
| **Scope** | A region of the design that shares resources, defaults and a latency model, arranged as a tree. A cloud region is a scope a provider defines. | `Placement` (to generalise) |
| **Condition** | Something that changes how a node, connector or scope behaves over a stretch of time: an outage, added latency, an error rate. | `Fault` |
| **Controller** | A loop that observes probes and metrics on the virtual clock, decides, and acts only through configuration and conditions. | `Controller.ts` |
| **Keyed family** | One logical node that is really many instances addressed by key, created on demand: Durable Objects, DynamoDB partitions, FIFO groups, Kafka partitions. | `Family`, used by `common.actor` |

What is deliberately **not** a primitive:

- **Durable state.** A Durable Object's storage, a database, a bucket: each is a separate node connected to the thing
  that uses it. The core doesn't need to know what survives an eviction; the design shows it.
- **Provider vocabulary.** Regions, accounts, quotas, `invocation: sync | async`, `operation: read | write`. A provider
  package defines them on top of scopes, resources and message metadata.

## Ports and protocols

A port declares a protocol. A connector declares which protocols it bridges. That is what makes a wire from one port to
another meaningful, and what lets the editor offer only connections that can work.

```ts
// A queue offers work to be pulled; a function accepts invocations.
Sqs.ports    = { deliver: port.pull("Consumers"), dlq: port.one("Dead letter") }
Lambda.input = invoke

// The connectors that can sit between them.
core.link                     invoke -> invoke   latency, timeout, retry (the default for every push)
core.poller                   pull   -> invoke   a fixed set of workers that take, call and acknowledge
aws.sqs.event-source-mapping  aws.sqs:deliver -> invoke
                                                 Lambda's poller: batching, scaling, throttle back-off,
                                                 partial batch responses
```

### `invoke`

The sender pushes a message and hears the outcome once. Everything a component calls through `node.out(port)` is an
invoke port; `Link.send(message, done)` is the protocol.

### `pull`

The owner of the work holds it; a connector takes it. The owner keeps everything only it can know: visibility timeouts,
redelivery, receive counts, dead-lettering, ordering. A taker only takes, and acknowledges.

```ts
interface Pull {
  take(max, bytes): Lease | undefined   // nothing receivable now -> undefined
  available(): boolean                  // whether a take may succeed now (optimistic)
  backlog(): number                     // work waiting, for scaling decisions
  ready(listener): () => void           // hear when a take may succeed again
  idle(receives): void                  // takers waited on an empty source (the owner's metric)
  traits: { ordered: boolean; maxTake?: number }
}
interface Lease {
  count, bytes                          // as taken
  each(visit)                           // the records this lease still owns
  ack(keep?)                            // delete them, except the ones kept to come back
}
```

A message in flight is a lease with an expiry. If the taker is slower than the lease, the work comes back under a new
lease and the slow taker's acknowledgement no longer counts. That is the whole at-least-once story, in the owner.

Candidates for later protocols, not built yet: **log** (ordered, the reader owns its position: Kinesis, DynamoDB Streams,
Kafka) and **stream** (a long-lived connection carrying many messages: WebSockets, gRPC streams).

## Connectors

An edge in a design is a connector. Most are plain links, and nothing about them changes. The ones that aren't are the
"function in between": Lambda's event source mapping between a queue and a function, a subscription between a topic and
its subscriber, an integration between an API and its backend.

```ts
Connector.make({
  type: "aws.sqs.event-source-mapping",
  title: "Event source mapping",
  from: { protocol: "pull", component: "aws.sqs", port: "deliver" },
  to:   { protocol: "invoke" },
  config: Consumer,            // batching, concurrency, scaling
  state:  MappingState,        // what a probe of the edge reports
  make: (ctx) => ...           // ctx.source is the queue's Pull, ctx.sink the function through transport
})
```

**Inference.** A wire doesn't have to name its connector. The registry picks the most specific connector that fits the
two ends: one that names the source component and port beats one that names the component, which beats one that only
names the protocols. A document can name one explicitly (`connector: core.poller`) when several fit.

**In the editor**, a connector that isn't a plain link is drawn as an icon on the edge line: there is something between
these two nodes, inferred and configurable. Selecting the edge shows its settings and its live state.

**Settings.** An edge's settings are one flat set, as they always were: the source port's own fields, then the
connector's, then transport. A port can still declare per-edge settings the source component reads (an SNS
subscription's filter, a CloudFront origin's timeouts). Over time those become connectors of their own.

## Transport

Every hop between two nodes goes through the same machine: latency there, the far end's handler, latency back, with the
edge's faults (outage, black hole, loss, added latency) applied on the way. A connector asks transport for **one try**
and adds its own policy on top: the plain link adds a timeout and retries with backoff; the event source mapping adds
none, because Lambda's own timeout ends a slow invocation.

## Messages and batches

A message is a unit of work with an identity, a birth time, a size and metadata. A batch is one message with a `count` of
records, and records are named **by position** (0 to `count - 1`, in the order the batch was sent). A batch a taker
handed over (a poller's batch from a queue) is marked `batched`, even a batch of one, so a handler knows its records can
fail on their own.

Most traffic is interchangeable, and allocating an object per record would throw away the engine's speed, so the common
case allocates nothing per record. The taker that needs to match positions back to records (the event source mapping, to
acknowledge all but the failed ones) collects them for that batch only (`batchOf(leases, maxBytes, order)`).

A call's outcome can then be a **partial success**:

```ts
type Reply = void | ItemFailures      // ItemFailures = { failed: positions, ascending }
type Call  = Effect<Reply, CallFailure>
type Done  = (failure: CallFailure | undefined, items?: ItemFailures) => void
```

It is a success, not a failure: a Lambda function returning `batchItemFailures` returned normally, as does a DynamoDB
`BatchWriteItem` with `UnprocessedItems`. It travels back across transport to the caller, which decides what to do: the
event source mapping keeps those records on their lease (they come back after the visibility timeout) when it is set to
`reportBatchItemFailures`, and otherwise ignores the reply and deletes them with the rest.

Records with identities of their own (a key, a group, an id per record) are the next step, for DynamoDB's per-item
outcomes and per-key stream ordering. They would be an optional `records` list beside `count`, built only when a
component asks for it.

## Controllers

A controller observes, decides and acts on a schedule of virtual time. It is attached to a node in the document
(`controllers: { id: { type, target, settings } }`) and gets:

```ts
Controller.Context = {
  watch(listener)         // the target's metrics, each frame
  settings()              // the target's settings now, as on disk
  set(path, value)        // change one of them: validated as an edit is, applied at once
  inject(fault, ms) / clear(id)   // start or end a condition on the target
  meter, log(decision)    // its own metrics (Frame.controllers) and what it decided (its probe)
}
```

It can only act through the channels a person editing a live design has, so its decisions are deterministic, replayable
and visible. A definition also `check`s an attachment against its target when the design is read (a setting the target
doesn't have is an error; nothing chosen yet is a warning). One primitive covers a Kubernetes horizontal autoscaler,
Application Auto Scaling, an operator's runbook and a chaos schedule; `core.target-tracking` is the first. Lambda's
scale-up, DynamoDB's on-demand doubling and an event source mapping's poller scaling are still written inside their
components: they are the services' own behaviour, and moving them would make their decisions visible the same way.

## Scopes

A scope is a part of the design that shares things: resources, defaults, a latency model. Scopes nest. A cloud region is
a scope, an availability zone a scope inside it, a VPC another; a Kubernetes cluster, a namespace and a node pool are
scopes too. A provider decides what its scopes are and what latency lies between them. Placement can be dynamic: a
Cloudflare Worker runs in whichever location is nearest its caller, so a node may resolve its scope per call
(`locate(callerScope)`).

Today `Placement { provider, region }` plays this role for regions only, with account quotas as the shared resource.

## Keyed families

A Durable Object class is not one node. It is an unbounded family of single-threaded instances, created on demand,
addressed by key, each with its own capacity and placement, evicted when idle. The same shape is everywhere: DynamoDB
partitions, SQS FIFO message groups, Kafka partitions, Kubernetes StatefulSet ordinals.

`Family` is that bookkeeping, and only that: `enter(key)` gives the key's instance (made, and reported `cold`, if it
didn't exist or had sat idle past its lifetime), `leave(key)` ends the work, and an instance with nothing in progress for
longer than `idleMs` is gone. Eviction is lazy (nothing wakes up to do it), and `size`, `created` and `evictions` are the
numbers a component reports. What an instance *is* stays the component's: `common.actor` makes each one a single thread
with a line of waiting requests (`kit/Slots`) and a cold start, which is all a hot key needs to throttle on its own.

A request's key is its partition key (`Message.key`, a hash in [0, 1)), mapped onto a number of keys by `Family.keyOf`, so
a client's hot keys are hot objects without either knowing about the other.

Still to come: DynamoDB partitions and FIFO groups on `Family`, instances placed in scopes of their own, and a Cloudflare
provider whose Durable Object is `common.actor` with Cloudflare's numbers and its storage as a connected node.

## A case for scopes, found on the way

`common.service`, `common.actor` and `common.http-endpoint` all run on the `internet` pseudo-provider, so the latency
estimate between any two of them is a last-mile internet hop (11 ms each way), even inside one Kubernetes cluster. The
**Autoscaled cluster** example sets 1 ms on each edge by hand. A scope tree (a cluster, a namespace, a data centre) with a
latency model of its own is what removes that.

## Migration map

How the existing AWS components map onto the primitives, and what moves where.

| Today | Becomes | Status |
| --- | --- | --- |
| `Edge.Config` (latency, timeout, retry, weight, request) | transport (latency) + `core.link` (timeout, retry, weight, request) | done |
| `Edge.make`'s call state machine | `Wire.call(message, policy, done)`: one try through transport, policy on top | done |
| SQS `deliver` port + `Pollers` inside the queue | `pull` port + `aws.sqs.event-source-mapping` connector | done |
| SQS → consumer timeout workaround (edge timeout = function timeout) | gone: the mapping waits for the function | done |
| `Message.count` | `count` named by position, `batched` for a taker's batch; `records` with identities when needed | partly done |
| Whole-batch success or failure | `ItemFailures` on the success channel; `ReportBatchItemFailures` on the SQS mapping, `batch.errors: report` on Lambda | done |
| DynamoDB `stream` port polling inside the table | `log` protocol + a stream event source mapping connector | planned |
| SNS subscription settings on the topic's port | an SNS subscription connector | planned |
| Autoscaling attached by the designer (HPA, Application Auto Scaling) | `core.target-tracking` controller | done |
| Scenario timeline, Lambda/ESM/on-demand scaling loops inside components | controllers | planned |
| `Placement`, account quotas, regional faults | scopes with resources and conditions | planned |
| Keyed objects (Durable Objects, actors) | `Family` + `common.actor` | done |
| `Message.key` hash and per-partition code in DynamoDB, SQS FIFO groups | `Family` | planned |
| Provider-neutral compute | `common.service` (replicas), `common.actor` (keyed objects) | done |
