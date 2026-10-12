import { Schema } from "effect"
import * as Setting from "../../Setting.ts"
import { CLASS_NAMES, ENGINE_LABELS, ENGINES } from "./catalog.ts"
import { MAX_READERS, SOURCES, STORAGE } from "./limits.ts"

const Hard = Setting.hard

/**
 * The settings of one database: an RDS DB instance (with its standby and read replicas) or an Aurora DB cluster (its
 * writer and readers). Numbers AWS publishes are cited; everything else says it is an assumption.
 */
export const Config = Schema.Struct({
  engine: Setting.choice(ENGINES, {
    default: "postgres",
    labels: ENGINE_LABELS,
    help: "Decides the default max_connections formula, the errors clients see, and whether this is an RDS instance (storage with IOPS, Multi-AZ standbys, read replicas) or an Aurora cluster (a shared cluster volume, a writer and up to 15 readers)."
  }),
  instanceClass: Setting.choice(CLASS_NAMES, {
    default: "db.r7g.large",
    label: "Instance class",
    help: "vCPUs and memory, from AWS's hardware table. Memory sets the default max_connections; vCPUs set how much query work runs at once. Readers use the same class."
  }),
  maxConnections: Setting.int({
    default: 0,
    min: 0,
    max: 262_143,
    label: "max_connections",
    help: "0 keeps the default parameter group's value, derived from the class's memory (MySQL: memory/12,582,880; MariaDB: memory/25,165,760 up to 12,000; PostgreSQL: memory/9,531,392 up to 5,000; Aurora MySQL: AWS's table). Each instance has its own.",
    limit: Hard(SOURCES.maxConnections, "MySQL and MariaDB accept 1–100,000, PostgreSQL 6–262,143, Aurora MySQL up to 16,000 (50,000 from 8.4.10).")
  }),
  multiAz: Setting.choice(["none", "instance", "cluster"], {
    default: "none",
    labels: { none: "Single-AZ", instance: "Multi-AZ DB instance (one standby)", cluster: "Multi-AZ DB cluster (two readable standbys)" },
    help: "RDS engines only. A Multi-AZ DB instance keeps a synchronous standby in another Availability Zone that serves nothing until it takes over; a Multi-AZ DB cluster has two standbys, in two other zones, that serve reads too. Aurora's availability comes from its readers instead, spread over the zones after the writer's."
  }),
  readers: Setting.int({
    default: 0,
    min: 0,
    max: MAX_READERS,
    label: "Readers",
    help: "Aurora Replicas behind the reader endpoint (failover targets), or RDS read replicas (asynchronous copies, not failover targets). Same class as the writer. Reads go to them when the client's endpoint says so.",
    limit: Hard(SOURCES.auroraReplicas, "Aurora: 15 per cluster. RDS read replicas: 15 per primary, a quota in the account quotas.")
  }),

  query: Setting.group(
    {
      readCpu: Setting.latency({
        mean: "1 millis",
        cv: 0.5,
        label: "Read: vCPU time",
        help: "vCPU time one read needs. Queries queue for a vCPU when every one is busy, which is how query time stretches as the CPU saturates. An assumption: it depends on your queries."
      }),
      readWait: Setting.latency({
        mean: "2 millis",
        cv: 0.5,
        label: "Read: other time",
        help: "Time a read spends off the CPU at low load: buffer pool misses, storage, locks. An assumption."
      }),
      writeCpu: Setting.latency({ mean: "2 millis", cv: 0.5, label: "Write: vCPU time", help: "vCPU time one write needs. An assumption." }),
      writeWait: Setting.latency({
        mean: "4 millis",
        cv: 0.5,
        label: "Write: other time",
        help: "Time a write spends off the CPU at low load: the log flush, storage, row locks. An assumption."
      }),
      readIos: Setting.number({
        default: 0.5,
        min: 0,
        max: 10_000,
        step: 0.1,
        label: "Storage I/Os per read",
        help: "Reads served from the buffer pool cost none. An assumption. Past the volume's IOPS they queue (RDS storage only)."
      }),
      writeIos: Setting.number({ default: 2, min: 0, max: 10_000, step: 0.1, label: "Storage I/Os per write", help: "Data and log pages written. An assumption." })
    },
    { label: "Queries", help: "A call is one query (a batch of n records, n of them, on one connection)." }
  ),

  connection: Setting.group(
    {
      handshake: Setting.latency({
        mean: "15 millis",
        cv: 0.4,
        label: "Handshake",
        help: "Opening a connection: TCP, TLS and authentication round trips, paid by every request that has no open connection to reuse. AWS publishes no figure; an assumption."
      }),
      cpu: Setting.latency({
        mean: "3 millis",
        cv: 0.5,
        label: "Server CPU per new connection",
        help: "vCPU time the database spends accepting a connection (TLS, authentication, a backend process). A storm of new connections competes with queries for the vCPUs. An assumption."
      })
    },
    { label: "Opening a connection" }
  ),

  storage: Setting.group(
    {
      type: Setting.choice(["gp3", "io1", "io2"], {
        default: "gp3",
        labels: { gp3: "General Purpose (gp3)", io1: "Provisioned IOPS (io1)", io2: "Provisioned IOPS (io2 Block Express)" },
        help: "RDS engines only: Aurora's cluster volume isn't provisioned by IOPS, and isn't limited here."
      }),
      allocated: Setting.int({
        default: 100,
        min: STORAGE.minGiB.gp3,
        max: STORAGE.maxGiB,
        unit: "GiB",
        label: "Allocated storage",
        help: "gp3's baseline jumps from 3,000 to 12,000 IOPS at 400 GiB, where RDS stripes it over four volumes. io1 and io2 need 100 GiB or more.",
        limit: Hard(SOURCES.storage)
      }),
      iops: Setting.int({
        default: 0,
        min: 0,
        max: STORAGE.io2.maxIops,
        unit: "IOPS",
        label: "Provisioned IOPS",
        help: "0 is gp3's baseline (or io1/io2's 1,000 minimum). gp3 can be provisioned 12,000–64,000 from 400 GiB; io1 1,000–256,000 at up to 50 per GiB; io2 1,000–256,000 at up to 1,000 per GiB. Out-of-range values are clamped (the audit says so).",
        limit: Hard(SOURCES.storage)
      })
    },
    { label: "Storage (RDS)" }
  ),

  standbyCommit: Setting.latency({
    mean: "2 millis",
    cv: 0.5,
    label: "Standby commit",
    help: "Multi-AZ (RDS): what a write waits for the standby to acknowledge. AWS says synchronous replication increases write and commit latency but gives no figure; an assumption."
  }),
  replicaLag: Setting.latency({
    mean: "20 millis",
    cv: 1,
    label: "Replica lag",
    help: "From a write on the writer to readers seeing it, recorded per write. Aurora: 'usually much less than 100 milliseconds'. RDS read replicas replicate asynchronously with the engine's own replication, typically slower and worse under heavy writes; raise it for them. An assumption."
  }),

  failover: Setting.group(
    {
      multiAzInstance: Setting.latency({
        mean: "90 seconds",
        cv: 0.2,
        label: "Multi-AZ DB instance",
        help: "AWS: failover times are typically 60–120 seconds."
      }),
      multiAzCluster: Setting.latency({
        mean: "25 seconds",
        cv: 0.2,
        label: "Multi-AZ DB cluster",
        help: "AWS: typically under 35 seconds."
      }),
      aurora: Setting.latency({
        mean: "30 seconds",
        cv: 0.4,
        label: "Aurora, promoting a reader",
        help: "AWS: service is typically restored in less than 60 seconds, and often less than 30."
      }),
      auroraRecreate: Setting.latency({
        mean: "5 minutes",
        cv: 0.4,
        label: "Aurora with no reader",
        help: "The primary is recreated: AWS says this typically takes less than 10 minutes."
      }),
      singleAz: Setting.latency({
        mean: "5 minutes",
        cv: 0.4,
        label: "Single-AZ",
        help: "No standby: the instance has to be recovered. AWS publishes no time for this; an assumption."
      })
    },
    {
      label: "Failover",
      help: "An Outage on this node is its primary failing, and an Outage on its primary's Availability Zone loses the primary with the zone. The database is then unavailable for its failover time while a standby or reader in another zone takes over (an Outage on the node itself keeps it down for the outage, if that is longer), every connection to the old primary is dropped, and clients reconnect. With nothing in another zone to take over, a zone outage keeps the database down until the zone returns."
    }
  )
})

export type Config = typeof Config.Type
