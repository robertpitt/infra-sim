# RDS and Aurora (`aws.rds`), RDS Proxy (`aws.rds-proxy`)

Amazon RDS runs a relational database (PostgreSQL, MySQL, MariaDB) on an instance you choose; Aurora is its cluster form,
a writer and up to 15 readers over one shared volume. What an architecture runs into first is not storage or SQL but
**connections**: every query holds one, a database allows only `max_connections` of them (a number its parameter group
derives from the instance's memory), opening one costs a TLS and authentication handshake, and callers that hold
connections while they do other work (Lambda functions, above all) need far more of them than their queries suggest.
Past the limit the database refuses ("Too many connections"). RDS Proxy is AWS's answer: a pool shared by many clients,
where a request borrows a connection for its transaction and gives it back, and waits for one rather than being refused.

These components let you see that play out: a Lambda burst exhausting `max_connections` and the same burst going through
a proxy; queries stretching as the vCPUs or the storage's IOPS saturate; reads moving to readers; a Multi-AZ or Aurora
failover, with its clients' connections dropped, a reconnection storm, and stale DNS, and a proxy riding it out; and an
Availability Zone going down, which a Multi-AZ database survives from another zone and a Single-AZ one doesn't.

| File | What it holds |
| --- | --- |
| `Rds.ts` | The database component: ports, state, admission (endpoint, failover, DNS, connection), the probe |
| `internal/config.ts` | The database's settings |
| `internal/catalog.ts` | Engines, instance classes (vCPU, memory), `max_connections` from the default parameter groups |
| `internal/database.ts` | A database's runtime: its writer and readers (`Role`: vCPUs, storage, connections), what follows from the settings |
| `internal/query.ts` | One query: handshake, vCPU line, CPU, storage and standby waits, releasing the connection |
| `internal/connections.ts` | Connection accounting: a server's open connections, each client's pool of idle ones, idle expiry, epochs |
| `internal/failover.ts` | The failover window, the DNS move, stale caches |
| `internal/zones.ts` | Where the instances are: the writer, standbys, readers and read replicas in the region's Availability Zones |
| `Client.ts` | The connectors on edges into a database or proxy: how a caller handles its connections; the proxy's own edge |
| `internal/endpoint.ts` | What a database and a proxy offer the connectors on their edges, and a proxy its database (`Instance.offer`) |
| `Proxy.ts`, `internal/proxyConfig.ts`, `internal/borrow.ts` | RDS Proxy: the component, its settings, and the borrow (pool slots, waiting, pinning, riding out a failover) |
| `internal/limits.ts` | Named AWS numbers and the pages they come from |
| `Quotas.ts`, `Audit.ts` | The account quotas, and checks of a design against them and against what AWS accepts |
| `testing.ts` | Test helpers |

## Coverage

| Feature | Status | Notes |
| --- | --- | --- |
| **Connections** | | |
| Each query holds a connection | ✅ | For the query, any time it queues for a vCPU or storage, and the time the client holds it besides (`client.hold`). |
| `max_connections` from the default parameter group | ✅ | MySQL, MariaDB (10.5+), PostgreSQL and Aurora PostgreSQL by AWS's formulas; Aurora MySQL by AWS's table. `DBInstanceClassMemory` is an assumption fitted to AWS's two examples (see Assumptions). Overridable. |
| Refused past the limit, in the engine's words | ✅ | `Throttled` (retryable): MySQL `ERROR 1040 (HY000): Too many connections`, PostgreSQL "remaining connection slots are reserved...". |
| Opening a connection costs a handshake and server CPU | ✅ | Paid by every request that has no open connection to reuse; the CPU part queues with queries, so a connection storm slows them. |
| Per-request connections vs kept-open pools | ✅ | Per edge (`client.connections`). Kept connections count against the limit while idle, until `client.idleTimeout`. |
| Callers that hold a connection around their work (Lambda) | 🟡 | `client.hold`: the connection stays checked out that long after the query. The engine's Lambda calls downstream after its handler, so the hold comes after the query rather than around it; the number in use is the same. A caller's per-instance pool size (HikariCP's maximum, one per Lambda environment) isn't modelled: a client's pool is shared by all its requests. |
| Superuser-reserved connections, `max_user_connections` | ❌ | All of `max_connections` is the clients'. |
| **The instance** | | |
| Instance classes | ✅ | 24 common classes (t3, t4g, m5, m6g, m6gd, m7g, r6g, r6gd, r7g), vCPU and memory from AWS's table. |
| Queries queue for vCPUs | ✅ | A line for the vCPUs (first come, first served): query time stretches as the CPU saturates. Gauge `cpu`. |
| Reads and writes differ | ✅ | By the edge's `request.operation`: their own CPU, other time and I/O; writes wait for a Multi-AZ standby. |
| Storage IOPS: gp3 baseline, io1/io2 provisioned | ✅ | gp3 3,000 (12,000 from 400 GiB, 12,000–64,000 provisioned); io1/io2 with AWS's ranges and ratios. I/O past the IOPS queues (`diskQueue`). Aurora isn't limited. |
| Throughput (MiB/s), the instance's EBS bandwidth, gp2 burst credits | ❌ | Only IOPS. |
| Burstable classes' CPU credits | ❌ | A t3/t4g runs at full speed. |
| Idle connections costing memory and CPU | ❌ | Only the limit; AWS warns idle connections slow a database. |
| Locks, deadlocks, long transactions | ❌ | A query's other time stands in for them. |
| **Replicas** | | |
| Aurora readers behind the reader endpoint | ✅ | `readers` (0–15), the writer's class. Reads go to them per the client's `endpoint`; with none, the reader endpoint reaches the writer. They are pooled together (vCPUs, connections) as the reader endpoint spreads connections. |
| RDS read replicas | 🟡 | The same `readers`, asynchronous, not failover targets. RDS has no reader endpoint: reads are spread evenly, as an application balancing over the replicas' endpoints would. |
| Multi-AZ DB cluster's readable standbys | ✅ | Two readers, failover targets. |
| A write sent to a reader | ✅ | Refused, `Rejected` (not retried), in the engine's words. |
| Replica lag | 🟡 | Recorded per write (`replicaLag`), an assumed distribution. It doesn't grow with write load, and reads aren't stale (the simulator has no data). |
| Creating a reader takes time; Aurora replica auto scaling | ❌ | A reader added is serving at once. |
| **Multi-AZ and failover** | | |
| Instances in Availability Zones | ✅ | The primary in the node's `zone` (the region's first if none), a Multi-AZ instance's standby in the next zone, a Multi-AZ cluster's standbys in the two after, Aurora's readers and RDS read replicas round robin over the zones after the primary's. The probe reports the writer's zone. |
| Failover when the primary's zone goes down | ✅ | A Multi-AZ instance or cluster, or Aurora with a reader in another zone, fails over to it (the failover time below) and serves from there for as long as the zone is down. The old writer becomes the standby or a reader, back when its zone is. |
| A Single-AZ instance (or Aurora with no reader elsewhere) in a zone that goes down | ✅ | Down until the zone returns, as AWS can only recover it there (Aurora: you would create an instance in another zone yourself). Not counted as a failover. |
| Readers lost with their zone | 🟡 | They stop serving and the reader endpoint spreads over the rest (with none left, it reaches the writer). Every reader connection is dropped, not only the lost readers': the readers are one pool. |
| A zone's Slow and Errors faults | ✅ | Reach the queries of the instance in that zone: the writer's, or the reader a query's key picks. |
| Failover on an Outage | ✅ | An Outage on the node (or its region), as it begins, is the primary failing: the writer is unavailable for the deployment's failover time, sampled from AWS's typical figures (Multi-AZ instance 60–120 s, cluster under 35 s, Aurora under 60 s, Aurora with no reader under 10 min; Single-AZ assumed), and the next instance in a zone that is up takes over. |
| Connections dropped | ✅ | Every connection to the old writer: idle ones at once, running queries fail when they finish ("connection lost"). Clients reconnect, paying the handshake. |
| Stale DNS after a failover | ✅ | Per client (`client.dnsCache`): a share of requests falling from all to none over the TTL still reaches the old writer and fails. Only the writer's endpoint moves. |
| Readers serving during the writer's failover | ✅ | Aurora and Multi-AZ clusters lose the one being promoted; RDS read replicas carry on. |
| An Outage longer than the failover | 🟡 | An Outage on the node is the database failing as a whole: the engine refuses its calls while it lasts, so it is down for the longer of the two. A short one (a second) shows the failover itself; a zone outage is the primary dead and the standby serving. |
| Synchronous standby commit | ✅ | Writes on a Multi-AZ instance or cluster wait `standbyCommit` (assumed). |
| The old primary coming back as a reader (Aurora, a cluster) or the standby (an instance) | ✅ | In its own zone. |
| Failover priority tiers, the replica with the least lag | ❌ | The next instance after the writer whose zone is up is promoted. |
| **RDS Proxy** | | |
| Pool of `MaxConnectionsPercent` of `max_connections` | ✅ | Requests borrow a connection for their transaction and give it back (multiplexing). |
| Waiting for a connection, `ConnectionBorrowTimeout` | ✅ | Past the pool requests wait, first come first served, up to the timeout (0–300 s): then `ERROR 9501 ... Timed-out waiting to acquire database connection`, `Throttled`. `borrowLatency` is CloudWatch's `DatabaseConnectionsBorrowLatency`. |
| `MaxIdleConnectionsPercent` | ✅ | Idle database connections beyond it close after five minutes. |
| Client connections, `IdleClientTimeout` | ✅ | As many as clients open, at the proxy's own handshake; closed when idle past the client's timeout or the proxy's. |
| Pinning | 🟡 | A share of client sessions (`pinning`) keeps its database connection until the client connection closes. Which statements pin, and session pinning filters, aren't modelled: it is a share. |
| Riding out a failover | ✅ | Client connections stay open; requests refused by the failing database wait (within the borrow timeout) while the proxy checks it every `targetCheck`, and go to the new writer at once, past DNS. Requests mid-query fail, as AWS says. The same for a zone's failover, and a Single-AZ database down with its zone. |
| Spanning zones | ✅ | A proxy runs in subnets in at least two zones: no zone outage takes it down, whatever zone its node is drawn in. |
| Read-only endpoints (Aurora) | ✅ | `endpoint: read-only` sends everything to the readers. |
| The proxy's own capacity, connection rate limits, reserved monitoring connections | ❌ | AWS scales the proxy and publishes neither its limits nor how many connections it reserves. |
| IAM authentication, secrets, TLS, initialization queries | ❌ | Not load behaviour (an IAM token's cost could be part of the handshake). |
| **Account** | | |
| DB instances, Aurora clusters, proxies, read replicas per primary, total storage | ✅ | Account quotas per region (ap-south-1's lower default included), checked by the audit. |

## Settings

### `aws.rds`

| Setting | Default | Range | Kind | What it models |
| --- | --- | --- | --- | --- |
| `engine` | postgres | postgres, mysql, mariadb, aurora-postgres, aurora-mysql | | The formula for `max_connections`, the error texts, RDS instance or Aurora cluster. |
| `instanceClass` | db.r7g.large | 24 classes | hard | vCPUs and memory. |
| `maxConnections` | 0 (the default parameter group's) | 0–262,143, clamped to the engine's range | hard | Per instance. |
| `multiAz` | none | none, instance, cluster | | RDS: one synchronous standby, or a Multi-AZ DB cluster with two readable standbys. Ignored for Aurora. |
| `readers` | 0 | 0–15 | hard | Aurora Replicas or RDS read replicas, the writer's class. |
| `query.readCpu`, `query.writeCpu` | 1 ms, 2 ms (cv 0.5) | mean 0–10 min | assumed | vCPU time per query (per record of a batch). |
| `query.readWait`, `query.writeWait` | 2 ms, 4 ms (cv 0.5) | mean 0–10 min | assumed | Time off the CPU at low load. |
| `query.readIos`, `query.writeIos` | 0.5, 2 | 0–10,000 | assumed | Storage I/Os per query (per record). |
| `connection.handshake` | 15 ms (cv 0.4) | mean 0–10 min | assumed | TCP, TLS, authentication round trips. |
| `connection.cpu` | 3 ms (cv 0.5) | mean 0–10 min | assumed | Server CPU to accept a connection. |
| `storage.type` | gp3 | gp3, io1, io2 | | RDS only. |
| `storage.allocated` | 100 GiB | 20–65,536 (io1/io2 from 100) | hard | gp3's baseline steps up at 400 GiB. |
| `storage.iops` | 0 (baseline or minimum) | 0–256,000, clamped as AWS accepts | hard | Provisioned IOPS. |
| `standbyCommit` | 2 ms (cv 0.5) | mean 0–10 min | assumed | A Multi-AZ write's wait for the standby. |
| `replicaLag` | 20 ms (cv 1) | mean 0–10 min | assumed | Recorded per write while there are readers. |
| `failover.multiAzInstance` | 90 s (cv 0.2) | mean 0–10 min | AWS's typical | "Typically 60–120 seconds." |
| `failover.multiAzCluster` | 25 s (cv 0.2) | | AWS's typical | "Typically under 35 seconds." |
| `failover.aurora` | 30 s (cv 0.4) | | AWS's typical | "Less than 60 seconds, and often less than 30." |
| `failover.auroraRecreate` | 5 min (cv 0.4) | | AWS's typical | No reader: "typically less than 10 minutes". |
| `failover.singleAz` | 5 min (cv 0.4) | | assumed | No standby; AWS publishes no figure. |

The node's `zone` (the Zone selector under Region, `zone: us-east-1b` in a design) is where the primary is; without one it
is in the region's first zone. The rest follow from it (see *Availability zones* below).

### `aws.rds-proxy`

| Setting | Default | Range | Kind | What it models |
| --- | --- | --- | --- | --- |
| `maxConnectionsPercent` | 100 | 1–100 | hard | The pool, as a share of `max_connections`. |
| `maxIdleConnectionsPercent` | 50 | 0–100, at most `maxConnectionsPercent` | hard | Idle connections kept past five minutes idle. |
| `borrowTimeout` | 120 s | 0–300 s | hard | `ConnectionBorrowTimeout`. |
| `idleClientTimeout` | 30 min | 1 s–24 h | hard (default), assumed (range) | `IdleClientTimeout`; AWS states no range, and ends client connections after 24 h. |
| `endpoint` | read-write | read-write, read-only | | Which instances the proxy's clients reach. |
| `pinning` | 0 | 0–1 | assumed | Share of client sessions pinned. |
| `latency` | 1 ms (cv 0.3) | mean 0–10 min | assumed | The proxy's hop. |
| `clientHandshake` | 15 ms (cv 0.4) | mean 0–10 min | assumed | Opening a client connection to the proxy. |
| `targetCheck` | 1 s | 100 ms–1 min | assumed | How often a failing database is tried again. |

### On edges into a database or a proxy (`aws.rds.client`, `aws.rds-proxy.client`)

The plain link's settings (`weight`, `request`, `timeout`, `cancelOnTimeout`, `retry`), then `client`:

| Setting | Default | Range | Kind | What it models |
| --- | --- | --- | --- | --- |
| `client.connections` | reused | reused, per-request | | Keep connections open and reuse them (a pool; a Lambda function connecting outside its handler), or open one per request. |
| `client.hold` | 0 | 0–15 min | assumed (your caller's) | How long the caller keeps a connection checked out besides the query. For a Lambda function: its duration besides the query. |
| `client.idleTimeout` | 10 min | 1 s–8 h | assumed | How long an idle connection stays open (a pool's idle timeout, a Lambda environment's idle life). |
| `client.endpoint` | auto | auto, writer, reader | | Reads to the reader endpoint and writes to the cluster endpoint, or everything to one. |
| `client.dnsCache` | 0 | 0–1 h | assumed (your caller's) | How long the caller caches the endpoint's address. AWS advises a JVM no more than 60 s. |

The proxy's edge to its database (`aws.rds-proxy.target`) has only `timeout`, `cancelOnTimeout` and `retry`: the proxy forwards what its clients asked.

Account quotas (`Quotas.ts`): `rdsInstances` 40 (20 in ap-south-1), `rdsClusters` 40, `rdsReadReplicas` 15, `rdsProxies` 20, `rdsStorage` 100,000 GB.

## Limits

| Limit | Value | Kind | Source |
| --- | --- | --- | --- |
| `max_connections`, MySQL | `{DBInstanceClassMemory/12582880}`; about 60 on db.t3.micro, about 630 on 8 GiB; 1–100,000 | default, hard range | [CHAP_Limits](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Limits.html#RDS_Limits.MaxConnections) |
| `max_connections`, MariaDB 10.5+ | `LEAST({DBInstanceClassMemory/25165760},12000)` | default | same |
| `max_connections`, PostgreSQL | `LEAST({DBInstanceClassMemory/9531392},5000)`; 6–262,143 | default, hard range | same |
| `max_connections`, Aurora PostgreSQL | `LEAST({DBInstanceClassMemory/9531392},5000)` | default | [AuroraPostgreSQL.Managing](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.Managing.html#AuroraPostgreSQL.Managing.MaxConnections) |
| `max_connections`, Aurora MySQL | by class: t3/t4g.medium 90, t4g.large 135, r6g/r7g.large 1,000 ... 16xlarge 6,000; at most 16,000 (50,000 from 8.4.10) | default, hard | [AuroraMySQL.Managing.Performance](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraMySQL.Managing.Performance.html#AuroraMySQL.Managing.MaxConnections) |
| `DBInstanceClassMemory` | the class's memory less what the OS and RDS reserve; formula integer division truncates | hard (unpublished amount) | [USER_ParamValuesRef](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ParamValuesRef.html) |
| Instance classes' vCPU and memory | e.g. db.t4g.medium 2 / 4 GiB, db.m7g.large 2 / 8, db.r7g.large 2 / 16, db.r7g.16xlarge 64 / 512 | hard | [DBInstanceClass.Summary](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.DBInstanceClass.Summary.html) |
| Aurora Replicas | 15 per cluster | hard | [Aurora.Replication](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.Replication.html) |
| Aurora replica lag | "usually much less than 100 milliseconds" | (figure) | same |
| Read replicas per primary | 15 | quota | [CHAP_Limits](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Limits.html) |
| Multi-AZ DB instance standby | synchronous, serves no reads | hard | [MultiAZSingleStandby](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZSingleStandby.html) |
| Multi-AZ DB instance failover | typically 60–120 s; DNS record moves to the standby | (figure) | [MultiAZ.Failover](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.Failover.html) |
| Multi-AZ DB cluster | a writer and two readable standbys, semi-synchronous; instance-store classes only | hard | [multi-az-db-clusters-concepts](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/multi-az-db-clusters-concepts.html) |
| Multi-AZ DB cluster failover | typically under 35 s | (figure) | [multi-az-db-clusters-concepts-failover](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/multi-az-db-clusters-concepts-failover.html) |
| Aurora failover | promoting a replica: under 60 s, often under 30 s; with no replica, the primary is recreated in typically under 10 minutes; other readers keep serving (Aurora MySQL) | (figure) | [Concepts.AuroraHighAvailability](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Concepts.AuroraHighAvailability.html) |
| gp3 | 3,000 IOPS / 125 MiB/s under 400 GiB; 12,000 / 500 MiB/s from 400 GiB, 12,000–64,000 provisioned; at most 500 IOPS per GiB; 20–65,536 GiB | hard | [CHAP_Storage](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Storage.html) |
| io1 | 1,000–19,950 IOPS under 400 GiB, up to 256,000 from it; 0.5–50 IOPS per GiB; 100–65,536 GiB | hard | same |
| io2 Block Express | 1,000–256,000 IOPS; 0.5–1,000 per GiB; 100–65,536 GiB | hard | same |
| DB instances per region | 40 (ap-south-1: 20) | quota | [CHAP_Limits](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Limits.html) |
| Aurora DB clusters per region | 40 | quota | same |
| Proxies per region | 20 | quota | same, and [rds-proxy](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html) |
| Total storage | 100,000 GB, all RDS instances (not Aurora) | quota | [CHAP_Limits](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Limits.html) |
| `MaxConnectionsPercent` | 1–100, default 100 | hard | [API_ConnectionPoolConfiguration](https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_ConnectionPoolConfiguration.html) |
| `MaxIdleConnectionsPercent` | 0–`MaxConnectionsPercent`, default half of it (50) | hard | same |
| `ConnectionBorrowTimeout` | 0–300 s, default 120 | hard | same |
| Idle database connection | after five minutes without activity | hard | [rds-proxy-connections](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-connections.html) |
| `IdleClientTimeout` | default 1,800 s; client connections end after 24 h | hard | same, and [rds-proxy-creating](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-creating.html) |
| Recommended minimum `MaxConnectionsPercent` | 30 on db.t3.small, 20 on db.t3.medium and above | (advice) | [rds-proxy-connections](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-connections.html) |
| Proxy targets, endpoints, secrets | one target; 20 extra endpoints; 200 secrets; writer only for RDS replication | hard | [rds-proxy](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html) |
| Pinning | a statement over 16 KB pins; a pinned session keeps its connection until it ends | hard | [rds-proxy-pinning](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-pinning.html) |
| Proxy failover | client connections kept; requests queued while the writer is unavailable; DNS caches bypassed, failover up to 66% faster (Aurora Multi-AZ) | (behaviour) | [rds-proxy.howitworks](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.howitworks.html), [Concepts.AuroraHighAvailability](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Concepts.AuroraHighAvailability.html) |
| Proxy errors | `ERROR 9501 (HY000)` / `ERROR 08000: Timed-out waiting to acquire database connection` | (behaviour) | [rds-proxy.troubleshooting](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.troubleshooting.html) |
| Proxy subnets | a VPC with at least two subnets in different Availability Zones | hard | [rds-proxy-network-prereqs](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-network-prereqs.html) |
| Multi-AZ instance failover | to "a standby replica in another Availability Zone"; reasons include the primary host unreachable through loss of network connectivity | (behaviour) | [MultiAZ.Failover](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.Failover.html) |
| Aurora in a zone outage | readers in other zones: one is promoted; a single instance, or every instance in one zone: "manually create one or more new DB instances in another AZ"; with no reader the primary is recreated in the same zone | (behaviour) | [Concepts.AuroraHighAvailability](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Concepts.AuroraHighAvailability.html) |

## Behaviour

**A query.** A call is one query on one connection (a batch of n records is n statements on it: n times the CPU and
I/O). The database first decides which endpoint it reached (the client's `endpoint`: reads to the readers when there are
any), refuses a write sent to a reader, refuses everything on the writer while it fails over, and refuses a request from
a client still caching the old writer's address. Then it needs a connection: an idle one from the client's pool if the
client keeps them, or a new one if the endpoint has fewer than `max_connections` open (counting every client's busy and
idle ones), or else "too many connections" (`Throttled`). A new connection costs the handshake, then joins the line for a
vCPU with its share of server CPU. The query runs its CPU work on a vCPU (first come, first served), then its time off
the CPU: storage, queued behind other I/O once the volume is at its IOPS, and on a Multi-AZ RDS instance a write waits for
the standby. The answer goes back; the connection stays checked out for the client's `hold`, then returns to the client's
pool (or closes, for per-request clients). Idle connections close after the client's idle timeout, checked every second.

**Why connections run out.** A caller needs about its request rate times how long it holds each connection. A service
that borrows from its pool for each query needs few. A Lambda function that keeps its environment's connection for its
whole invocation needs one per concurrent invocation, and keeps them while its environments sit idle: 1,500 requests a
second at 300 ms is about 470 connections, more than a db.t4g.medium's 304 (MySQL). Per-request connections add the
handshake to every request and a connection's CPU to every query, which is how a connection storm slows a database.

**The CPU and storage.** The writer has its class's vCPUs; readers together have theirs times their number. Busy vCPUs
are the query rate times the CPU per query (Little's law), and as that nears the number of vCPUs queries wait (`cpuWait`),
which keeps their connections longer, which can run out the connections. Storage is a queue served at the volume's IOPS:
under it nothing waits, past it a backlog grows by the difference (`diskQueue`, RDS's `DiskQueueDepth`). Aurora's volume
isn't limited.

**`max_connections`.** The default parameter group's formula divides `DBInstanceClassMemory`, the class's memory less
what RDS reserves for itself, by a per-engine constant. AWS doesn't publish the reservation, but gives two MySQL examples
(about 60 on a db.t3.micro, about 630 on 8 GiB); the simulator reserves a fixed part plus a share of memory, fitted
through both (257 MiB plus 4.6%). Aurora MySQL uses AWS's table of defaults by class.

**Failover.** An Outage on the node (or its region) is the primary failing, and the database sees it begin (it watches its
own faults). From then the writer is unavailable for the deployment's failover time: a Multi-AZ instance's standby taking
over, a Multi-AZ cluster's or Aurora's reader being promoted (one reader fewer meanwhile), Aurora with no reader
recreating its primary, or a Single-AZ instance recovering. The instance promoted is the next one after the writer whose
zone is up; the old writer becomes the standby or a reader. Every connection to the old writer is dropped: idle ones at
once, and queries that were running fail when they finish ("connection lost"). Clients then reconnect, each paying the
handshake. When it is done the writer's DNS name moves; a client caching DNS for T keeps reaching the old writer for a
share of its requests that falls from all to none over T. The engine refuses every call to a node while an Outage on it
lasts, so an Outage on the node is the database failing as a whole: one longer than the failover keeps it down for the
Outage. Inject a short one (a second) to see the failover itself, or take the primary's zone down to see the standby
serve.

**Availability zones.** The instances live in the region's zones: the primary in the node's `zone` (the region's first if
it has none), a Multi-AZ instance's standby in the next zone, a Multi-AZ cluster's two standbys in the two after, Aurora's
readers one per zone after the primary's, round robin, and RDS read replicas likewise (they don't move in a failover). The
database handles its zones' faults itself (`handlesZoneFaults`), so an Outage on a zone:

- **the writer's zone:** the writer and its connections are lost. With an instance that can take over in a zone that is up
  (a Multi-AZ standby, a cluster's standby, an Aurora reader) the database fails over to it, for the failover time above,
  and then serves from there however long the zone stays down; when it returns, the old writer is back as the standby or
  a reader. With none (Single-AZ, Aurora whose readers are all in that zone or that has none) the writer refuses
  ("the primary's Availability Zone is down") until the zone returns, and nothing fails over: AWS recovers an instance in
  its own zone, and for Aurora says to create one in another zone yourself. If the instance being promoted loses its zone
  too, the next one is promoted; if none is left, the writer waits for a zone to return and fails over to it then.
- **a reader's zone:** that reader stops serving; the reader endpoint spreads over the others (with none, it reaches the
  writer), and every reader connection is dropped (the readers are modelled as one pool), so reader clients reconnect.
- **a zone's Slow or Errors:** added to the queries of the instance in it, as the engine does for any node: the writer's
  queries, or a reader's (a query's key picks which serving reader it lands on).

A Multi-AZ instance whose standby's zone is down keeps serving, and its writes still wait `standbyCommit`.

**RDS Proxy.** Clients connect to the proxy (each new client connection costs the proxy's handshake, not the
database's) and every request borrows a database connection for its transaction: a slot of the pool, `MaxConnectionsPercent`
of `max_connections`. The proxy is one client of the database, which reuses its connections and keeps
`MaxIdleConnectionsPercent` of them however long they sit idle (the rest close after five minutes). With the pool in use,
requests wait in line up to the borrow timeout, then fail (`Throttled`). A pinned session (a share of client
connections) keeps its database connection from its first request until its client connection closes, so pinned
sessions of clients that keep connections open use up the pool. When the database refuses as down (failing over, or an
Outage), the proxy holds the request, marks the target down (pinned sessions lose their connections), and tries it every
`targetCheck`; once it answers the line goes through, at once and past DNS, and the proxy opens connections for all of it.
Requests that were mid-query fail. A "too many connections" from the database (other clients took them) is passed on.
The proxy runs in at least two zones, so no zone outage takes it down (it handles zone faults by ignoring them); a
database down with its zone is waited out the same way, within the borrow timeout.

## Connections

`aws.rds` has no output ports: a database calls nothing. It is called over any edge; what sits on that edge is chosen by
the registry:

- **`aws.rds.client`** (any caller to `aws.rds`) and **`aws.rds-proxy.client`** (any caller to `aws.rds-proxy`): the plain
  link (weight, `request.operation` and payload, timeout, retries) plus the `client` settings above. It tells the node at
  its far end how it handles its connections (through what the node offers, `ctx.offer()`) and tags each request with the
  edge, so the database knows whose connections they are.
- **`aws.rds-proxy.target`** (`aws.rds-proxy` to `aws.rds`): the proxy's pooled connections; timeout and retries only.

An edge into a database with another connector (an explicit `core.link`, or a component's own connector that is more
specific) is a client with the default `client` settings, shared by all such edges. Reads need `request: { operation: read }`
on the edge (the engine's default is a write).

`aws.rds-proxy` has one output, `out` ("Database"): wire it to the database it fronts (it finds it through what the
database offers, `link.offer()`). Unwired, it refuses every request as unavailable. Wired to something other than an
`aws.rds`, its pool is unlimited.

Both belong in a VPC in AWS (a DB subnet group; a proxy must be in its database's VPC and can't be public): put them in
an `aws.vpc` box. A design that doesn't draw the VPC can leave them straight in the region box.

The CloudFormation importer doesn't map `AWS::RDS::DBInstance`, `AWS::RDS::DBCluster` or `AWS::RDS::DBProxy` yet. The
mapping would be: engine and class from `Engine` and `DBInstanceClass`, `MultiAZ` (and a cluster's
`DBClusterInstanceClass`) to `multiAz`, the cluster's `AWS::RDS::DBInstance` members to `readers`, `max_connections` from a
parameter group, `StorageType`/`AllocatedStorage`/`Iops`; a proxy's `ConnectionPoolConfigurationInfo` from its
`AWS::RDS::DBProxyTargetGroup`, and its target to the edge.

## Metrics and state

`aws.rds` counters (rates in frames, totals in the probe): `queries`, `reads`, `writes`, `opened` (new connections),
`refused` (too many connections), `readOnly` (writes to a reader), `stale` (stale DNS), `lost` (queries running when the
primary failed), `unavailable` (refused while failing over), `failovers`; and, rates only, `readIops` and `writeIops`
(storage I/Os the writer's queries ask of its volume: CloudWatch's `ReadIOPS` and `WriteIOPS`). Samplers: `queryTime`
(arrival to answer, in the database), `selectLatency` and `dmlLatency` (the same, of successful reads and writes: Aurora's
`SelectLatency` and `DMLLatency`), `connectTime` (handshakes), `cpuWait`, `ioWait`, `replicaLag`. Gauges: `connections`
(the writer's open connections, busy and idle: CloudWatch's `DatabaseConnections`), `idleConnections`, `maxConnections`,
`cpu` (the writer's busy share of vCPUs at the instant), `cpuUtilization` (the same averaged over the frame, as
CloudWatch's `CPUUtilization` averages it over a period), `cpuQueue`, `diskQueue`, `provisionedIops` (what the writer's
volume serves; 0 for Aurora), `readerConnections`, `readerCpu`, `readerCpuUtilization`, `readers` (reader instances
serving), `failingOver` (1 while it fails over). The probe reports the engine, class, `max_connections`, the writer's and
readers' connections, CPU and queues, IOPS, the totals, the failover state, and the writer's zone (`writerZone`, and
`writerZoneDown`). The `readers` gauge counts the readers serving: one fewer while one is promoted, none in a zone that is
down.

`aws.rds-proxy` counters: `requests`, `queued` (had to wait), `borrowTimeouts`, `retried` (held through a failover),
`clientConnects`, `pinnedSessions`. Samplers: `borrowLatency`, `databaseResponseLatency` (the database's answer to each
query the proxy sent it: `QueryDatabaseResponseLatency`). Gauges: `borrowed` (database connections in use, pinned ones
included), `waiting`, `limit`, `pinned`, `clientConnections`, `databaseConnections` (open, as the database counts the
proxy's), `targetUp`. The probe reports the same.

The client connectors (`aws.rds.client`, `aws.rds-proxy.client`) count their own caller's connections on their edge:
`connectionsOpened` and `connectionsRefused` (refused at `max_connections`; a proxy refuses none), and the gauges
`connections` (open, busy and idle) and `connectionsInUse`.

Each has a dashboard (`internal/dashboard.ts`) under CloudWatch's names. The database's: CPUUtilization, DatabaseConnections
against `max_connections`, Queries (SelectThroughput, DMLThroughput), SelectLatency and DMLLatency, the vCPU and disk
queues (DiskQueueDepth), ReadIOPS and WriteIOPS against the volume's IOPS, ConnectionAttempts and refusals, failover errors,
ReplicaLag (AuroraReplicaLag) and the failover itself. The proxy's: QueryRequests, DatabaseConnections,
DatabaseConnectionsCurrentlyBorrowed, DatabaseConnectionsCurrentlySessionPinned, MaxDatabaseConnectionsAllowed,
DatabaseConnectionsBorrowLatency, QueryResponseLatency and QueryDatabaseResponseLatency, ClientConnections,
ClientConnectionsReceived and AvailabilityPercentage. No memory is modelled (FreeableMemory, SwapUsage, BufferCacheHitRatio),
nor a disk's service time per I/O (ReadLatency, WriteLatency: only the queue past the IOPS), nor TLS or authentication
(the proxy's TLS and setup-failure metrics, LoginFailures).

## Not yet simulated

1. **Readers as instances.** The readers are one pool (their vCPUs, connections and storage together), so losing one
   reader's zone drops every reader connection rather than that reader's, and a hot reader can't be seen. Per-reader
   pools, with the reader endpoint's DNS spreading connections, would fix both.
2. **Per-instance pools.** A caller's connections are one pool shared by all its requests, so a Lambda function's
   connections are approximated by `client.hold`. A pool per caller instance (a Lambda environment, a container) needs the
   caller's instances on the call (a fleet member id on the message).
3. **Creating readers takes minutes, and Aurora replica auto scaling.** A reader added now serves now; with a creation
   delay the target-tracking controller could scale `readers` on `readerCpu` as Aurora Auto Scaling does.
4. **Failover choices**: promotion tiers and instance sizes (Aurora), the replica with the least lag, a standby that can't
   keep up; a Multi-AZ instance with its standby's zone down still waits for the standby on every write.
5. **Replica lag that grows with writes**, and read replicas replaying writes on their own CPU.
6. **Memory**: idle connections, the buffer pool and cache hit ratio (reads from storage), `work_mem`.
7. **Throughput limits** (MiB/s), the instance's EBS bandwidth and IOPS caps, gp2 and burstable CPU credits.
8. **Aurora Serverless v2** (capacity in ACUs, `max_connections` by capacity), Aurora global databases, Aurora
   Limitless, RDS Custom, Oracle, SQL Server and Db2. Aurora's storage (six copies over three zones) is taken to survive
   any one zone; losing two zones isn't modelled.
9. **The proxy's limits** on client connections and connection rate (AWS returns errors for both but publishes neither),
   its reserved monitoring connections, initialization queries and session pinning filters; a zone's Slow or Errors on
   the proxy's endpoints.
10. **Blue/green deployments, maintenance windows, reboots, backups' I/O, storage autoscaling.**

## Assumptions

- `DBInstanceClassMemory`: 257 MiB plus 4.6% of the class's memory reserved, fitted to AWS's two MySQL examples.
- Query CPU, other time and I/Os, connection handshake and server CPU: illustrative defaults (1–4 ms, 15 ms, 3 ms); they
  depend on your queries and clients.
- The vCPU line is first come, first served (an operating system shares time; the throughput is the same).
- Readers are one pool: perfect balance over their vCPUs and connections. RDS read replicas have no reader endpoint; reads
  are spread evenly as an application would.
- Standby commit 2 ms; replica lag 20 ms; Single-AZ recovery 5 minutes; failover times as lognormals around AWS's
  typical figures.
- Stale DNS: clients' caches expire at uniformly spread moments, so the share still stale falls linearly.
- The proxy: 1 ms per request, a 15 ms client handshake, a check of a failing database every second, no limit on client
  connections; the IdleClientTimeout range (AWS states none).
- A client's idle timeout of 10 minutes (pools differ; Lambda doesn't publish its environments' idle life).
- Where the instances are: the primary in the node's zone or the region's first; standbys, readers and read replicas
  round robin over the zones after it. AWS lets you choose (and recommends readers in two or more zones); this is one
  sensible layout. The instance promoted is the next one after the writer whose zone is up.
- An instance in a zone that comes back is serving at once (AWS gives no recovery time for it).

## References

- https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Limits.html
- https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ParamValuesRef.html
- https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.DBInstanceClass.Summary.html
- https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraMySQL.Managing.Performance.html
- https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.Managing.html
- https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZSingleStandby.html
- https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.Failover.html
- https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/multi-az-db-clusters-concepts.html
- https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/multi-az-db-clusters-concepts-failover.html
- https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Concepts.AuroraHighAvailability.html
- https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.Replication.html
- https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReadRepl.html
- https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Storage.html
- https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html
- https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.howitworks.html
- https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-connections.html
- https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-pinning.html
- https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-creating.html
- https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-network-prereqs.html
- https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.troubleshooting.html
- https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_ConnectionPoolConfiguration.html
