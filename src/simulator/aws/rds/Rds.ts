import { Effect, Schema } from "effect"
import { type CallFailure, Rejected, type Reply, Throttled, Unavailable } from "../../Message.ts"
import { totals } from "../../kit/Tally.ts"
import * as Aws from "../provider.ts"
import { classOf, isMysqlFamily } from "./catalog.ts"
import { Config } from "./config.ts"
import { DEFAULT_POLICY } from "./client.ts"
import { REFUSED } from "./connections.ts"
import { Database, makeStats } from "./database.ts"
import type { Database as DatabaseOffer } from "./endpoint.ts"
import { SOURCES } from "./limits.ts"
import { runQuery } from "./query.ts"
import { NO_EFFECT } from "./zones.ts"

/** Why a client that still caches the old primary's address can't connect after a failover. */
export const STALE_DNS = "connect timeout: the endpoint's DNS name is cached and still points at the old primary"

/** The engine's own words for "too many connections". (MySQL error 1040; PostgreSQL as AWS quotes it in AuroraPostgreSQL.Managing) */
const tooMany = (mysql: boolean): string =>
  mysql ? "ERROR 1040 (HY000): Too many connections" : "FATAL: remaining connection slots are reserved for non-replication superuser connections"

/** A write sent to a reader: the engine refuses it, and retrying can't help. */
const readOnly = (mysql: boolean): string =>
  mysql ? "ERROR 1290 (HY000): The MySQL server is running with the --read-only option" : "ERROR: cannot execute this statement in a read-only transaction"

/**
 * Amazon RDS and Aurora: one database, an RDS DB instance (with a Multi-AZ standby and read replicas) or an Aurora DB
 * cluster (a writer and readers). What it models is what an architecture runs into: connections are scarce (each query
 * holds one; `max_connections` comes from the instance's memory; past it new connections are refused, and opening one
 * costs a handshake and server CPU), queries queue for vCPUs and storage IOPS, reads can go to readers, and when the
 * primary fails the database is down for its failover time and every connection to it is dropped. Its instances live
 * in Availability Zones: losing the primary's zone fails a Multi-AZ database over to another, and a Single-AZ one is
 * down until the zone returns. README.md documents the mechanisms against AWS; the modules beside this file hold them.
 */
export const Rds = Aws.component({
  type: "aws.rds",
  service: "RDS",
  title: "RDS database",
  description:
    "A relational database: an RDS instance or an Aurora cluster. Each query holds a connection, and max_connections comes from the instance's memory; queries queue for vCPUs and IOPS; reads can go to readers; a failed primary, or its Availability Zone, fails over to a standby or reader in another zone.",
  docs: SOURCES.maxConnections,
  category: "storage",
  icon: "database",
  accent: "#2e73b8",
  limits: [
    { label: "max_connections (default parameter group)", value: "MySQL: memory/12,582,880; MariaDB: memory/25,165,760 up to 12,000; PostgreSQL and Aurora PostgreSQL: memory/9,531,392 up to 5,000; Aurora MySQL: AWS's table by class", adjustable: true, source: SOURCES.maxConnections, note: "Memory is DBInstanceClassMemory, the class's memory less what RDS reserves; AWS doesn't publish the reservation (see README)." },
    { label: "Readers", value: "Up to 15 Aurora Replicas per cluster; 15 read replicas per RDS primary (a quota)", adjustable: false, source: SOURCES.auroraReplicas },
    { label: "Failover", value: "Multi-AZ DB instance typically 60–120 s; Multi-AZ DB cluster typically under 35 s; Aurora typically under 60 s, often under 30 s, or under 10 minutes with no reader to promote", adjustable: false, source: SOURCES.multiAzInstanceFailover },
    { label: "Storage (gp3)", value: "3,000 IOPS baseline under 400 GiB, 12,000 from 400 GiB (12,000–64,000 provisioned)", adjustable: false, source: SOURCES.storage },
    { label: "Storage (io1, io2)", value: "1,000–256,000 IOPS; io1 up to 50 per GiB (19,950 under 400 GiB), io2 up to 1,000 per GiB", adjustable: false, source: SOURCES.storage },
    { label: "Multi-AZ standby", value: "Serves no reads (DB instance); two readable standbys (DB cluster)", adjustable: false, source: SOURCES.multiAzInstance },
    { label: "DB instances, clusters, proxies, storage", value: "Per region, in the account quotas", adjustable: true, source: SOURCES.quotas }
  ],
  highlights: [
    { gauge: "connections", label: "conns" },
    { gauge: "cpu", label: "cpu", format: "percent" },
    { rate: "refused", label: "refused/s" }
  ],
  config: Config,
  ports: {},
  // A Multi-AZ database outlives its primary's zone: it fails over to an instance in another (see `Database`).
  handlesZoneFaults: true,
  state: Schema.Struct({
    engine: Schema.String,
    instanceClass: Schema.String,
    vcpu: Schema.Number,
    memoryGiB: Schema.Number,
    /** `max_connections` of each instance. */
    maxConnections: Schema.Number,
    /** The writer's connections: open (busy and idle together), running a query, and idle in clients' pools. */
    writer: Schema.Struct({ open: Schema.Number, busy: Schema.Number, idle: Schema.Number, cpu: Schema.Number, cpuQueue: Schema.Number, diskQueue: Schema.Number }),
    /** The readers together. `instances` is how many serve right now. */
    readers: Schema.Struct({ instances: Schema.Number, open: Schema.Number, busy: Schema.Number, idle: Schema.Number, cpu: Schema.Number, cpuQueue: Schema.Number }),
    /** IOPS each instance's storage serves (`Infinity` reported as 0 for Aurora). */
    iops: Schema.Number,
    /** Clients that told the database how they handle connections (edges with the client connector, proxies). */
    clients: Schema.Number,
    queries: Schema.Number,
    reads: Schema.Number,
    writes: Schema.Number,
    /** New connections opened. */
    opened: Schema.Number,
    /** Connections refused: too many connections. */
    refused: Schema.Number,
    /** Writes sent to a reader, refused. */
    readOnly: Schema.Number,
    /** Requests from clients still caching the old primary's address after a failover. */
    stale: Schema.Number,
    /** Queries running when the primary failed, failed when they finished. */
    lost: Schema.Number,
    /** Requests refused while the writer was failing over. */
    unavailable: Schema.Number,
    failovers: Schema.Number,
    /** Whether the writer is failing over right now, and until when (virtual ms). */
    failingOver: Schema.Boolean,
    failoverUntil: Schema.Number,
    /** The Availability Zone the writer is in ("" in a place with none), and whether it is down. */
    writerZone: Schema.String,
    writerZoneDown: Schema.Boolean
  }),
  make: (node) =>
    Effect.gen(function*() {
      const { fast } = node
      const db = new Database(node.id, fast, makeStats(node.meter), node.zones, node.placement.zone)
      const { count } = db.stats

      // The node sees its own faults: an Outage on it (or its region) beginning is its primary failing, and a zone
      // going down loses the instances there (see `Database`). Heard when they change, so nothing waits for a client.
      let outage = false
      const faultsChanged = (): void => {
        const now = fast.now()
        const own = node.faults.own().outage
        if (own && !outage) db.primaryFailed(now)
        outage = own
        db.faultsChanged(now)
      }
      faultsChanged()
      const unwatch = node.faults.watch(faultsChanged)
      yield* Effect.addFinalizer(() => Effect.sync(unwatch))

      /** What the connectors on edges into the database, and a proxy in front of it, reach it by. */
      const offer: DatabaseOffer = {
        kind: "rds.database",
        attach: (key, policy) => db.attach(key, policy),
        // Readers are the writer's class, so one instance of either has the same limit.
        maxConnections: () => db.derived().maxConnections,
        connections: (key) => {
          const client = db.clients.get(key)
          return client === undefined ? 0 : client.writer.busy + client.writer.idle + client.reader.busy + client.reader.idle
        },
        mysql: () => isMysqlFamily(fast.settings().engine)
      }

      // Idle connections close when their client's idle timeout passes, whether or not anything calls: check every second.
      const sweep = (): void => {
        db.sweep(fast.now())
        fast.after(1_000, sweep, undefined)
      }
      fast.after(1_000, sweep, undefined)

      node.meter.gaugeUnsafe("connections", () => db.writer.server.open)
      node.meter.gaugeUnsafe("idleConnections", () => db.writer.server.idle)
      node.meter.gaugeUnsafe("maxConnections", () => db.derived().maxConnections)
      node.meter.gaugeUnsafe("cpu", () => db.writer.utilization())
      node.meter.gaugeUnsafe("cpuQueue", () => db.writer.cpu.queued)
      node.meter.gaugeUnsafe("diskQueue", () => db.writer.diskQueue(fast.now()))
      node.meter.gaugeUnsafe("readerConnections", () => db.reader.server.open)
      node.meter.gaugeUnsafe("readerCpu", () => db.reader.utilization())
      node.meter.gaugeUnsafe("readers", () => db.reader.instances())
      node.meter.gaugeUnsafe("failingOver", () => (db.failover.down(fast.now()) ? 1 : 0))

      return {
        call: (message) => {
          const now = fast.now()
          const c = fast.settings()
          const mysql = isMysqlFamily(c.engine)
          const client = db.client(message.group)
          const policy = client === undefined ? DEFAULT_POLICY : client.policy()
          const isRead = message.operation === "read"

          // The endpoint the client connected to: the readers if it asked for them (or for its reads) and there are any.
          const wantsReader = policy.endpoint === "reader" || (policy.endpoint === "auto" && isRead)
          const role = wantsReader && db.reader.instances() > 0 ? db.reader : db.writer
          if (role === db.reader && !isRead) {
            count.readOnly.add(1)
            return Effect.fail(Rejected({ node: node.id, reason: readOnly(mysql) }))
          }
          if (role === db.writer) {
            const refusal = db.writerRefusal(now)
            if (refusal !== undefined) {
              count.unavailable.add(1)
              return Effect.fail(Unavailable({ node: node.id, reason: refusal }))
            }
            // The writer's endpoint is the name that moves in a failover; a reader endpoint still reaches a reader.
            if (policy.dnsCacheMs > 0 && db.failover.stale(now, policy.dnsCacheMs, fast.random.nextDoubleUnsafe())) {
              count.stale.add(1)
              return Effect.fail(Unavailable({ node: node.id, reason: STALE_DNS }))
            }
          }

          const pool = client === undefined ? role.anonymous : role === db.writer ? client.writer : client.reader
          const got = pool.acquire(now)
          if (got === REFUSED) {
            count.refused.add(1)
            return Effect.fail(Throttled({ node: node.id, reason: tooMany(mysql) }))
          }
          count.queries.add(1)
          if (isRead) count.reads.add(1)
          else count.writes.add(1)
          // A Slow or Errors fault on the zone of the instance that runs it (the engine leaves zones to this component).
          const zone = db.topology.anyEffect ? db.zoneEffect(role === db.writer, message.key, now) : NO_EFFECT
          return Effect.callback<Reply, CallFailure>((resume) => {
            const cancel = runQuery(db, role, pool, got, message, (failure) => resume(failure === undefined ? Effect.void : Effect.fail(failure)), zone)
            return Effect.sync(cancel)
          })
        },
        offer,
        probe: Effect.sync(() => {
          const c = fast.settings()
          const now = fast.now()
          db.settle(now)
          const d = db.derived()
          const cls = classOf(c.instanceClass)
          const t = totals(count)
          return {
            engine: c.engine,
            instanceClass: c.instanceClass,
            vcpu: cls.vcpu,
            memoryGiB: cls.memoryGiB,
            maxConnections: d.maxConnections,
            writer: {
              open: db.writer.server.open,
              busy: db.writer.server.busy,
              idle: db.writer.server.idle,
              cpu: db.writer.utilization(),
              cpuQueue: db.writer.cpu.queued,
              diskQueue: db.writer.diskQueue(now)
            },
            readers: {
              instances: db.reader.instances(),
              open: db.reader.server.open,
              busy: db.reader.server.busy,
              idle: db.reader.server.idle,
              cpu: db.reader.utilization(),
              cpuQueue: db.reader.cpu.queued
            },
            iops: d.iops === Number.POSITIVE_INFINITY ? 0 : d.iops,
            clients: db.clients.size,
            queries: t.queries,
            reads: t.reads,
            writes: t.writes,
            opened: t.opened,
            refused: t.refused,
            readOnly: t.readOnly,
            stale: t.stale,
            lost: t.lost,
            unavailable: t.unavailable,
            failovers: t.failovers,
            failingOver: db.failover.down(now),
            failoverUntil: db.failover.until,
            writerZone: db.topology.writerZoneName() ?? "",
            writerZoneDown: db.topology.memberDown(db.topology.writer)
          }
        })
      }
    })
})
