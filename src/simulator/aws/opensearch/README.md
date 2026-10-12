# OpenSearch Service (`aws.opensearch`)

Amazon OpenSearch Service runs OpenSearch (and older Elasticsearch) clusters for you: full-text and product search, log
analytics, observability. You choose the data nodes (how many, which instance type) and the shape of your indexes (primary
shards and replicas); AWS runs them. This component is one domain holding one index. What it lets you learn is where such a
cluster runs out: indexing and search have separate thread pools on every data node but share its processors, so a bulk
reindex slows live searches down; every replica writes every document again; a routing key can pile all the writes on one
shard; queues fill and requests are rejected with 429; documents become searchable only at the next refresh; a failed
node takes its shards' primaries with it until replicas are promoted, or takes the data with it when there are none; and
an Availability Zone going down is a few nodes failing for a zone-aware domain with replicas, and the whole domain for one
in a single zone.

## Coverage

| Feature | Status | Notes |
| --- | --- | --- |
| **Cluster** | | |
| Data nodes and instance types | ✅ | 14 common types (t3, m6g, c6g, r6g, r7g): vCPUs and memory from the EC2 pages, heap half the memory up to 32 GiB, payload limit by type |
| Request payload limit | ✅ | Over 10 MiB or 100 MiB (by type) is `Rejected` (413) and not retried |
| Live changes (more nodes, larger type, shard layout) | 🟡 | Apply at once; AWS does a blue/green deployment and moves shards, which takes time and load, and primary shards can't change on an existing index |
| Dedicated master nodes, coordinator nodes, UltraWarm and cold storage, Auto-Tune, storage | ❌ | Masters are assumed healthy; no disk, EBS throughput or watermarks |
| **Thread pools** | | |
| Write pool: one thread per vCPU, queue of 10,000 | ✅ | Per node; past the queue a shard request is rejected (429 `rejected_execution_exception`) |
| Search pool: `int(vCPUs × 3 / 2) + 1` threads, queue of 1,000 | ✅ | Per node; a rejected shard query tries the next copy |
| Indexing and search share the CPU | ✅ | Processor sharing over the node's vCPUs among every running thread of both pools |
| Replica writes never rejected for a full queue | ✅ | Forced into the queue, as OpenSearch does; they count in its length |
| Indexing pressure (coordinating and primary: 10% of heap) | ✅ | In-flight bytes per node; a bulk past it is rejected (429) before any queue is full |
| Replica indexing pressure (1.5 × that) | 🟡 | The replica write is refused and counted and the write still succeeds; OpenSearch would also fail that copy and rebuild it |
| Other pools (get, refresh, merges, management), search backpressure, admission control | ❌ | |
| **Indexing** | | |
| Single documents and bulk requests | ✅ | `request.operation` write; `count` documents per request, split into one shard-level request per shard they route to |
| Partial bulk failures | 🟡 | Documents that got through are indexed; if any were refused the whole call fails `Throttled`, so a retrying client resends all of them (no per-item retry) |
| CPU cost of indexing | 🟡 | `cpuPerRequest` per shard request plus `cpuPerDocument` per document, on the primary and again on each replica; both assumed |
| Routing by document ID or by key | ✅ | By ID spreads a request's documents over all shards; by key sends them all to `floor(key × shards)`, so a hot key is a hot shard |
| Refresh interval, refresh off, `refresh=wait_for` | ✅ | All shards refresh on one clock; documents are searchable at the next tick |
| Search-idle shards, refresh and merge cost, translog, segment replication, version conflicts | ❌ | |
| **Search** | | |
| Fan-out to one copy of every shard, or to the routed shard | ✅ | One shard query per shard on the search pool of the chosen copy's node |
| Copy selection | 🟡 | The copy whose node has the fewest searches running and queued, standing in for adaptive replica selection |
| Shard failover and partial results | ✅ | A rejected or lost shard query goes to the next live copy; shards no copy could answer make a partial (200) result, or a 429/503 with partial results off |
| Query cost | 🟡 | One lognormal CPU time per shard query (assumed); no caches, aggregations' memory or circuit breakers, no reduce cost on the coordinating node |
| **Failures** | | |
| Data node failure (`failover.failedNodes`) | ✅ | Its running and queued work is lost, the requests it was coordinating fail (503), searches move to other copies |
| Replica promotion after detection | ✅ | Writes for a shard without a primary wait for it (`waitingWrites`); promoted after `failover.detection` |
| No replica: red shard | ✅ | Writes for it wait their timeout (1 minute) then fail 503 `UnavailableShardsException`; searches get partial results |
| Node back | ✅ | Its copies return; a red shard takes its copy as primary |
| Replacing a failed node, reallocating replicas elsewhere after a minute, shard recovery time, quorum loss | ❌ | |
| Domain endpoint down | ✅ | An Outage fault on the node (framework): every call 503 |
| Data nodes over 1, 2 or 3 Availability Zones | ✅ | `availabilityZones`: node `i` in zone `i mod z`, from the node's `zone` (or the region's first) |
| Zone awareness: a shard's copies in different zones | ✅ | While a zone has no copy of a shard, a copy goes to a node there |
| A zone outage | ✅ | Its data nodes fail as `failedNodes` fails them: with replicas over several zones the domain goes yellow and carries on (writes to the lost primaries wait for the promotion); in one zone, or without replicas, red |
| A zone's Slow and Errors faults | ❌ | Only its Outage reaches the nodes |
| Multi-AZ with Standby | ❌ | Three zones, one held as standby and activated within a minute |
| Dedicated masters and quorum in a zone outage | ❌ | Masters are assumed healthy: a 2-zone domain without masters, which AWS says goes down until it replaces a node, carries on here |
| JVM memory pressure, circuit breakers, writes blocked at 92% | ❌ | |
| **Account** | | |
| Domains per region, instances per domain (T3 at most 10) | ✅ | Account quotas and audit warnings; a domain over them still runs |
| Sizing checks | ✅ | Audit: copies that can't be placed, no replicas, fewer than three nodes, uneven shard counts, shards per node |

## Settings

| Path | Default | Range | Kind | What it models |
| --- | --- | --- | --- | --- |
| `instanceType` | `r6g.large.search` | 14 types | | Data node type: vCPUs (thread pools, CPU), memory (heap, indexing pressure), payload limit |
| `dataNodes` | 3 | 1 to 1,002 | hard | Data nodes; the per-domain quota (200) is checked by the audit |
| `availabilityZones` | 1 | 1 to 3 | hard | Zones the data nodes are spread over: 1 is zone awareness off (the API's default); 2 or 3, Multi-AZ without Standby, with zone-aware copies |
| `primaryShards` | 5 | 1 to 1,024 | hard | Primary shards of the index (OpenSearch Service's default is 5) |
| `replicas` | 1 | 0 to 30 | | Replicas per primary (the maximum is a form bound) |
| `routing` | `id` | id, key | | Shard routing: by document ID, or by the message key (custom routing) |
| `refreshInterval` | 1 s | 0 (off) to 1 h | | `index.refresh_interval` |
| `indexing.cpuPerDocument` | 0.5 ms | 0 to 1,000 ms | assumed | CPU to index one document, per copy |
| `indexing.cpuPerRequest` | 1 ms | 0 to 1,000 ms | assumed | CPU per shard-level indexing request, per copy |
| `indexing.waitForRefresh` | false | | | `refresh=wait_for`: answer once searchable |
| `indexing.timeout` | 1 minute | 1 ms to 10 minutes | | How long a write waits for an active primary, then 503 |
| `search.cpuPerShard` | 5 ms, cv 1 | | assumed | CPU per shard query (lognormal) |
| `search.allowPartialResults` | true | | | `allow_partial_search_results` |
| `failover.failedNodes` | 0 | 0 to 1,002 | | How many data nodes are down (the first ones); set it from a scenario |
| `failover.detection` | 30 s | 0 to 5 minutes | assumed | From a node failing to its primaries' replicas being promoted |

Account quotas (`quotas.ts`): `opensearchDomains` (500 per region), `opensearchInstancesPerDomain` (200).

## Limits

| Limit | Value | Kind | Source |
| --- | --- | --- | --- |
| Write thread pool | allocated processors (one per vCPU) threads, queue 10,000 | hard | [ThreadPool.java](https://github.com/opensearch-project/OpenSearch/blob/main/server/src/main/java/org/opensearch/threadpool/ThreadPool.java), [CloudWatch metrics](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/managedomains-cloudwatchmetrics.html) ("increased from 200 to 10000 in version 7.1") |
| Search thread pool | `((processors × 3) / 2) + 1` threads, queue 1,000 | hard | [ThreadPool.java](https://github.com/opensearch-project/OpenSearch/blob/main/server/src/main/java/org/opensearch/threadpool/ThreadPool.java), [CloudWatch metrics](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/managedomains-cloudwatchmetrics.html) ("The maximum search queue size is 1,000") |
| Replica writes never rejected on thread-pool capacity | forced execution | hard | [TransportReplicationAction.java](https://github.com/opensearch-project/OpenSearch/blob/main/server/src/main/java/org/opensearch/action/support/replication/TransportReplicationAction.java) |
| Indexing pressure | `indexing_pressure.memory.limit` 10% of heap; replicas 1.5 × | hard | [IndexingPressure.java](https://github.com/opensearch-project/OpenSearch/blob/main/server/src/main/java/org/opensearch/index/IndexingPressure.java) |
| Java heap | 50% of memory, at most 32 GiB (r7g and OR can go higher, not by default) | hard | [limits](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/limits.html#java-process-limit) |
| HTTP request payload | 10 MiB (t3, m6g.large, m7g.large and smaller), 100 MiB (larger types, all r6g/r7g) | hard | [limits, network quotas](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/limits.html#network-limits) |
| vCPUs and memory | t3.medium 2/4 GiB; m6g.large 2/8, xlarge 4/16, 2xlarge 8/32; c6g.xlarge 4/8, 2xlarge 8/16; r6g and r7g large 2/16, xlarge 4/32, 2xlarge 8/64, 4xlarge 16/128 | hard | [EC2 general purpose](https://docs.aws.amazon.com/ec2/latest/instancetypes/gp.html), [compute](https://docs.aws.amazon.com/ec2/latest/instancetypes/co.html), [memory](https://docs.aws.amazon.com/ec2/latest/instancetypes/mo.html); [bp-instances](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/bp-instances.html) confirms m6g.large.search |
| Instances per domain | 200 by default, up to 1,002 on request; T2 10 | quota | [Service Quotas (General Reference)](https://docs.aws.amazon.com/general/latest/gr/opensearch-service.html) |
| T3 domains | at most 10 instances; no Multi-AZ with Standby | hard | [supported-instance-types](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/supported-instance-types.html) |
| Domains per region | 500 | quota | [Service Quotas](https://docs.aws.amazon.com/general/latest/gr/opensearch-service.html) |
| Availability Zones | `AvailabilityZoneCount` 2 or 3 with zone awareness (`ZoneAwarenessEnabled`, off by default); one otherwise | hard | [ZoneAwarenessConfig](https://docs.aws.amazon.com/opensearch-service/latest/APIReference/API_ZoneAwarenessConfig.html), [managedomains-multiaz](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/managedomains-multiaz.html) |
| Shard placement over zones | "a best effort to distribute primary shards and their corresponding replica shards to different zones"; without replicas data can't be in other zones | behaviour | [managedomains-multiaz](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/managedomains-multiaz.html) |
| A zone disruption | 3 zones: no downtime, two-thirds of the data nodes left; 2 zones without dedicated masters: downtime until a node is replaced | behaviour | same |
| Dedicated master nodes | 5 per domain (not modelled) | hard | [Service Quotas](https://docs.aws.amazon.com/general/latest/gr/opensearch-service.html) |
| Primary shards per index | 1 to 1,024; OpenSearch Service default 5 primaries and 1 replica (open source: 1 and 1) | hard | [IndexMetadata.java](https://github.com/opensearch-project/OpenSearch/blob/main/server/src/main/java/org/opensearch/cluster/metadata/IndexMetadata.java), [bp-sharding](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/bp-sharding.html) |
| Shards per node | 1,000 (to 2.15); 1,000 per 16 GiB of heap up to 4,000 (2.17+) | hard (audit) | [limits, shard count](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/limits.html#shard-count), [bp-sharding](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/bp-sharding.html) |
| Refresh interval | 1 s by default; `index.search.idle.after` 30 s (not modelled) | default | [index settings](https://docs.opensearch.org/latest/install-and-configure/configuring-opensearch/index-settings/) |
| Write timeout | 1 minute waiting for an active primary, then 503 `UnavailableShardsException` | default | [ReplicationRequest.java](https://github.com/opensearch-project/OpenSearch/blob/main/server/src/main/java/org/opensearch/action/support/replication/ReplicationRequest.java) |
| Partial search results | `allow_partial_search_results` true by default | default | [search API](https://docs.opensearch.org/latest/api-reference/search-apis/search/) |
| Node failure detection | at once on disconnect; else 3 failed checks, 1 s apart, 10 s timeout each | default | [FollowersChecker.java](https://github.com/opensearch-project/OpenSearch/blob/main/server/src/main/java/org/opensearch/cluster/coordination/FollowersChecker.java) |
| Adaptive replica selection | on by default | default | [OperationRouting.java](https://github.com/opensearch-project/OpenSearch/blob/main/server/src/main/java/org/opensearch/cluster/routing/OperationRouting.java) |
| Writes blocked at high JVM pressure | over 92% for 30 minutes; unblocked at 88% for 5 minutes (not modelled) | behaviour | [handling-errors](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/handling-errors.html#handling-errors-block-disks) |
| Circuit breakers | parent 95%, field data 40%, request 60% of heap (not modelled) | behaviour | [handling-errors](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/handling-errors.html#handling-errors-jvm_out_of_memory_error) |

Pages that differ: the General Reference's Service Quotas table gives 200 instances per domain by default (up to 1,002); the
developer guide's "Total node limit by instance family" table gives 80 as the default for most families, 200 up to 2.15 and
400 or 1,002 from 2.17. The account quota uses 200 and its help text says so. The thread pool numbers are OpenSearch's
defaults (AWS doesn't let you change them); the CloudWatch metrics page confirms the queue sizes.

## Behaviour

**Nodes and pools.** Each data node has `vCPUs` write threads and `int(vCPUs × 3 / 2) + 1` search threads (2 and 4 on an
r6g.large), with queues of 10,000 and 1,000. A shard-level task starts if a thread of its pool is free and nobody is
waiting, otherwise it queues; past the queue it is rejected. Running tasks are jobs on the node's processors, which are
shared: with `n` running on `c` vCPUs each runs at `min(1, c / n)`. With both pools busy a node has more runnable threads
than vCPUs, and the CPU divides by thread count: search gets 4/6 of an r6g.large, writes 2/6. So a search load that used
90% of the CPU alone gets only 67% of it during a bulk load, and its queue grows, then overflows into 429s.

**Writes.** A call with `operation: write` carries `count` documents and `bytes`. Over the type's payload limit it is
refused (413). The domain endpoint hands it to a random live node (the coordinating node), which holds its bytes against
indexing pressure (10% of heap): past that it is refused at once (429). Routed by ID, the documents spread evenly over the
shards (which shards get the odd ones out is random); routed by key, all go to `floor(key × shards)`. Each shard's part is a
task on its primary's write pool (also holding its bytes there, unless that node is the coordinator), costing
`cpuPerRequest + documents × cpuPerDocument`; when it finishes, the same task is forced into each live replica's write
pool. When every part is done the call is answered: `Throttled` if any documents were refused (a bulk's 200 with
`errors: true`, which a client that retries on 429 resends whole), `Unavailable` if any timed out waiting for a primary,
otherwise success. Documents are indexed when the primary finishes; they are searchable at the next refresh tick
(`floor(now / interval + 1) × interval`), and with `waitForRefresh` the call is answered then.

**Searches.** A call with `operation: read` is a search of every shard (or, routed by key, of one). Each shard's query goes
to the live copy whose node has the fewest searches running and queued; if that node rejects it, or fails under it, it goes
to the next copy. A shard nothing could answer is a shard failure: with partial results allowed (the default) the search
still succeeds (counted as `partialSearches`) unless every shard failed; otherwise it fails with 429 (rejections) or 503.

**Node failure and failover.** `failover.failedNodes = k` takes the first `k` data nodes down. Their tasks are lost: a lost
primary write is sent again once its shard has a primary, a lost replica write is dropped (the write succeeds on the
primary), a lost shard query tries another copy, and requests those nodes were coordinating fail with 503 at once. A shard
whose primary was on a failed node has none until `failover.detection` has passed (OpenSearch notices a dropped connection
at once and a silent node after 3 failed 10 s checks: about 30 s), when a live copy is promoted; writes for it wait
meanwhile (up to `indexing.timeout`). With no live copy the shard is red: its writes fail with 503 after the timeout and
searches lose it. When the nodes come back their copies return, and a red shard's primary with them. Cluster status:
red if a shard has no live copy, yellow if a copy is missing, unplaced or a primary is being replaced, green otherwise.

**Availability zones.** With `availabilityZones` = `z`, data node `i` is in the `(i mod z)`-th zone from the node's own
zone (or the region's first), round robin over the region's zones; with 1, every node is in that zone. With more than one,
copies are placed zone aware: a copy goes to the next node (in the balanced order above) in a zone that holds no copy of
its shard yet, while there is one, so with a replica every shard has a copy in two zones. The domain handles its zones'
faults (`handlesZoneFaults`): an Outage on a zone fails the data nodes in it through the same path as `failedNodes` (lost
work, primaries promoted after `failover.detection`, coordinating requests cut off), and its end brings them back. Over
three zones with a replica, losing one leaves a copy of every shard: the cluster is yellow, searches go on at once and
writes to the lost primaries wait for their promotion. Over two zones with four nodes, two shards and a replica, either
zone can go. In one zone, or without replicas, the shards there are red. A zone's Slow and Errors don't reach the nodes.

**Where it departs from OpenSearch.** One index; shards are placed once (no relocation, no replica reallocation after a
node leaves, no recovery time); the CPU costs are assumptions; no merges, refresh cost, translog or disk; no JVM memory
model; copy selection approximates adaptive replica selection; a bulk's partial failure fails the whole call.

## Connections

- `in` (any caller): `request.operation` decides: `write` indexes `count` documents (a bulk request when more than one;
  Lambda with `batchCalls: once` behind SQS or a stream sends bulks), `read` searches. `payload` and the message key matter
  (`routing: key`). Failures: `Throttled` (429: queue full, indexing pressure, all shards rejected), `Unavailable` (503: no
  primary within the timeout, no copy of any shard, the coordinating node failed, or an Outage fault on the domain),
  `Rejected` (413: payload over the type's limit).
- No output ports: a domain calls nothing.
- In a VPC: a VPC domain goes in an `aws.vpc` box (a public domain sits straight in the region box). The box only
  draws where it lives: callers reach it the same either way.
- Availability zones: the data nodes are spread over the domain's 1 to 3 zones (see *Availability zones* above); place
  the node in a zone (`zone: us-east-1b`) to start them there. Inject an Outage on a zone (`zone:aws:<region>:<zone>`)
  to lose its nodes.

## Metrics and state

Counters (rates in frames): `writeRequests`, `searchRequests` (calls), `indexed` and `replicated` (documents on primaries
and replicas), `searchShards` (shard queries run, CloudWatch's SearchRate), `partialSearches`, `writeRejected` (documents
refused by a full write queue), `searchRejected` (shard queries refused by a full search queue), `pressureRejected`
(documents refused by indexing pressure), `replicaRejected` (replica writes refused by replica pressure),
`unavailableDocs` (documents not indexed for want of a primary or a live node), `unavailableShards` (shard queries with no
copy left), `lostTasks` (shard tasks lost with a node); plus the usual `in`, `ok`, `fail.<Tag>`, `latency`.
Distribution: `searchableAfter` (ms from a document's creation to the refresh that makes it searchable).
Gauges: `cpu` (mean utilisation of live nodes over the frame), `cpuMax` (the busiest node), `writeActive`, `writeQueue`,
`writeQueueMax`, `searchActive`, `searchQueue`, `searchQueueMax` (threads busy and tasks queued, summed over nodes or the
largest node's), `indexingPressure` (the fullest node's coordinating and primary bytes over its limit), `unrefreshed`
(documents not yet searchable), `refreshLag` (age of the oldest of them, ms), `clusterStatus` (0 green, 1 yellow, 2 red),
`liveNodes`, `unassignedShards`, `waitingWrites`.

Probe `state`: instance type, vCPUs, heap, threads and queues per pool, the indexing pressure limit, `status`, nodes
(configured, live), `zones` (the zones its nodes are in) and `zonesDown`, shards (primaries, replicas, active, unassigned, promotions, waiting writes), `perNode` (zone, up, primaries,
replicas, CPU, each pool's active, queued and rejected, indexing and replica bytes), `totals` of every counter, and
`refresh` (interval, unrefreshed, lag).

## Not yet simulated

1. Multi-AZ with Standby: three zones, one held as standby (not serving searches) and activated in under a minute when
   another fails, with no data moved. And dedicated masters spread over three zones, so a 2-zone domain without them
   loses quorum with a zone; a zone's Slow and Errors faults on its nodes.
2. Shard recovery and reallocation: after a node leaves, replicas are rebuilt on other nodes after `delayed_timeout` (1
   minute), costing disk and network; AWS replaces failed nodes. Needs a shard size (GiB) and a recovery rate.
3. JVM memory pressure: heavy aggregations filling the heap, circuit breakers (429 at 95% of heap for the parent breaker),
   writes blocked at 92% for 30 minutes. Needs a memory model per search (aggregation buckets) and a garbage collector.
4. Per-item bulk responses: retry only the refused documents (`ItemFailures` back to a caller that understands them).
5. Disk: storage per node, watermarks and `ClusterBlockException` at 20% free, EBS throughput limits.
6. Several indexes with their own shards and settings, index lifecycle (rollover), UltraWarm and cold tiers.
7. Background CPU: merges, refresh cost (a short refresh interval taxes indexing), translog fsyncs per request.
8. Segment replication (replicas copy segments instead of re-indexing: far less replica CPU).
9. Dedicated master and coordinator nodes; quorum loss making the cluster read-only.
10. Search caches (request, query, field data) and search backpressure / CPU admission control.
11. Live configuration changes as blue/green deployments that take time and double the nodes meanwhile.
12. A client that can send bulks of its own (`count` > 1) needs a batch setting on `common.client`; today bulks come from a
    batching Lambda (or the test indexer).

## Assumptions

- CPU per document 0.5 ms and per shard request 1 ms, the same on replicas (document replication re-indexes); per shard
  query 5 ms, cv 1. Real costs depend on mapping, document size and query: set them from your own measurements.
- A search's latency is CPU time only (queueing and sharing included); no disk I/O, no coordination or network inside the
  domain, no reduce phase.
- Refresh ticks are aligned across shards at whole multiples of the interval.
- Failure detection 30 s by default (OpenSearch's checks for a silent node; a crashed process is noticed at once).
- The coordinating node is a random live data node (no dedicated coordinators); requests it is coordinating fail with it.
- Copy selection by fewest searches running and queued on the node, ties broken at random.
- A node that comes back has its shards (as after a restart with its disk intact), whether it was failed or its zone was down.
- Node `i` in the `(i mod z)`-th zone, and zone-aware placement by skipping nodes in zones that already hold a copy: AWS
  balances nodes over zones the same way but doesn't publish its allocator's order.
- `.search` instance types have the vCPUs and memory of the EC2 type of the same name.

## References

- https://docs.aws.amazon.com/opensearch-service/latest/developerguide/limits.html
- https://docs.aws.amazon.com/general/latest/gr/opensearch-service.html
- https://docs.aws.amazon.com/opensearch-service/latest/developerguide/supported-instance-types.html
- https://docs.aws.amazon.com/opensearch-service/latest/developerguide/bp-sharding.html
- https://docs.aws.amazon.com/opensearch-service/latest/developerguide/bp-instances.html
- https://docs.aws.amazon.com/opensearch-service/latest/developerguide/handling-errors.html
- https://docs.aws.amazon.com/opensearch-service/latest/developerguide/managedomains-cloudwatchmetrics.html
- https://docs.aws.amazon.com/opensearch-service/latest/developerguide/managedomains-multiaz.html
- https://docs.aws.amazon.com/ec2/latest/instancetypes/gp.html, co.html, mo.html
- https://docs.opensearch.org/latest/install-and-configure/configuring-opensearch/index-settings/
- https://docs.opensearch.org/latest/api-reference/search-apis/search/
- https://docs.opensearch.org/latest/api-reference/document-apis/bulk/
- OpenSearch source (main): `threadpool/ThreadPool.java`, `index/IndexingPressure.java`,
  `action/support/replication/TransportReplicationAction.java`, `ReplicationRequest.java`,
  `action/UnavailableShardsException.java`, `cluster/coordination/FollowersChecker.java`,
  `cluster/routing/OperationRouting.java`, `cluster/metadata/IndexMetadata.java`, `libs/core/.../OpenSearchException.java`
