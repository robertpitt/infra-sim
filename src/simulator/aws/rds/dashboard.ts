import { type Dashboard, dist, gauge, latencyPanel, rate, sum } from "../../Dashboard.ts"

/**
 * The dashboards of RDS and Aurora, RDS Proxy, and the connections of their clients, as CloudWatch and the RDS console
 * show them. Names follow CloudWatch's: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-metrics.html,
 * https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.AuroraMonitoring.Metrics.html and
 * https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.monitoring.html.
 */

/**
 * A database's dashboard: the writer's CPU, connections and storage, the readers beside it, query throughput and
 * latency, where queries queue, and what a failover costs. The simulator models no memory, so FreeableMemory, SwapUsage
 * and the buffer cache's hit ratio have no counterpart, and storage has no per-I/O service time, only the queue that
 * builds past the volume's IOPS (DiskQueueDepth), so there is no ReadLatency or WriteLatency.
 */
export const database: Dashboard = {
  figures: [
    { label: "CPU", metric: gauge("cpuUtilization"), unit: "ratio", cloudwatch: "CPUUtilization" },
    { label: "Connections", metric: gauge("connections"), unit: "count", cloudwatch: "DatabaseConnections" },
    { label: "Queries", metric: rate("queries"), unit: "perSecond", cloudwatch: "Queries" },
    { label: "Query time p95", metric: dist("queryTime", "p95"), unit: "ms" },
    { label: "Refused", metric: rate("refused"), unit: "perSecond", tone: "bad" },
    { label: "Unavailable", metric: sum(rate("unavailable"), rate("stale"), rate("lost")), unit: "perSecond", tone: "bad" }
  ],
  panels: [
    {
      id: "cpu",
      title: "CPU utilization",
      unit: "ratio",
      cloudwatch: ["CPUUtilization"],
      help: "Busy vCPUs, averaged over time: the writer's, and the readers' together. At 100% queries wait in line for a vCPU, holding their connections.",
      lines: [
        { label: "writer", metric: gauge("cpuUtilization"), tone: "primary" },
        { label: "readers", metric: gauge("readerCpuUtilization"), tone: "accent" }
      ]
    },
    {
      id: "connections",
      title: "Database connections",
      unit: "count",
      cloudwatch: ["DatabaseConnections"],
      help: "Open connections count against max_connections whether they run a query or sit idle in a client's pool. The readers' are all of them together; the limit is each instance's.",
      lines: [
        { label: "writer", metric: gauge("connections"), tone: "primary" },
        { label: "writer idle", metric: gauge("idleConnections"), tone: "teal" },
        { label: "readers", metric: gauge("readerConnections"), tone: "accent" },
        { label: "max_connections", metric: gauge("maxConnections"), tone: "muted", dashed: true }
      ]
    },
    {
      id: "queries",
      title: "Queries",
      unit: "perSecond",
      cloudwatch: ["Queries", "SelectThroughput", "DMLThroughput"],
      lines: [
        { label: "reads", metric: rate("reads"), tone: "primary" },
        { label: "writes", metric: rate("writes"), tone: "accent" }
      ]
    },
    {
      id: "query-latency",
      title: "Query latency",
      unit: "ms",
      cloudwatch: ["SelectLatency", "DMLLatency"],
      help: "A query's time in the database: opening its connection, waiting for a vCPU, running, storage and locks. The vCPU wait is what a saturated writer adds.",
      lines: [
        { label: "read p50", metric: dist("selectLatency", "p50"), tone: "primary" },
        { label: "write p50", metric: dist("dmlLatency", "p50"), tone: "accent" },
        { label: "p99", metric: dist("queryTime", "p99"), tone: "bad" },
        { label: "vCPU wait p95", metric: dist("cpuWait", "p95"), tone: "muted" }
      ]
    },
    {
      id: "queues",
      title: "Queues",
      unit: "count",
      cloudwatch: ["DiskQueueDepth"],
      help: "On the writer: queries waiting for a vCPU, and I/Os waiting for storage once queries ask for more than the volume's IOPS.",
      lines: [
        { label: "waiting for a vCPU", metric: gauge("cpuQueue"), tone: "warn" },
        { label: "disk queue", metric: gauge("diskQueue"), tone: "accent" }
      ]
    },
    {
      id: "iops",
      title: "Storage IOPS",
      unit: "perSecond",
      cloudwatch: ["ReadIOPS", "WriteIOPS"],
      help: "I/Os the writer's queries ask of its volume, against what the volume serves. An Aurora cluster volume isn't provisioned by IOPS: its line sits at 0.",
      lines: [
        { label: "read", metric: rate("readIops"), tone: "primary" },
        { label: "write", metric: rate("writeIops"), tone: "accent" },
        { label: "provisioned", metric: gauge("provisionedIops"), tone: "muted", dashed: true }
      ]
    },
    {
      id: "connection-attempts",
      title: "New connections",
      unit: "perSecond",
      cloudwatch: ["ConnectionAttempts"],
      help: "Connections opened (each a handshake, and vCPU time on the server), and those refused at max_connections: MySQL's ERROR 1040, PostgreSQL's reserved slots.",
      lines: [
        { label: "opened", metric: rate("opened"), tone: "primary" },
        { label: "refused", metric: rate("refused"), tone: "bad" }
      ]
    },
    {
      id: "failover-errors",
      title: "Failover errors",
      unit: "perSecond",
      help: "Requests refused while the writer fails over, from clients still caching the old primary's address, queries lost with the primary, and writes sent to a reader.",
      lines: [
        { label: "failing over", metric: rate("unavailable"), tone: "bad" },
        { label: "stale DNS", metric: rate("stale"), tone: "warn" },
        { label: "connection lost", metric: rate("lost"), tone: "accent" },
        { label: "write to a reader", metric: rate("readOnly"), tone: "muted" }
      ]
    },
    latencyPanel("replica-lag", "Replica lag", "replicaLag", ["ReplicaLag", "AuroraReplicaLag"]),
    {
      id: "failover",
      title: "Failover",
      unit: "count",
      help: "1 while the writer fails over (a standby or reader being promoted), and the reader instances serving: one fewer while one is promoted.",
      lines: [
        { label: "failing over", metric: gauge("failingOver"), tone: "bad" },
        { label: "readers serving", metric: gauge("readers"), tone: "accent" }
      ]
    }
  ]
}

/**
 * RDS Proxy's dashboard: its client connections, the pool of database connections they borrow from, what waiting for one
 * costs, and its target's availability. The proxy's own capacity is unlimited here, and TLS isn't modelled, so the
 * TLS and setup-failure metrics have no counterpart.
 */
export const proxy: Dashboard = {
  figures: [
    { label: "Queries", metric: rate("requests"), unit: "perSecond", cloudwatch: "QueryRequests" },
    { label: "Borrowed", metric: gauge("borrowed"), unit: "count", cloudwatch: "DatabaseConnectionsCurrentlyBorrowed" },
    { label: "Waiting", metric: gauge("waiting"), unit: "count", tone: "warn" },
    { label: "Borrow p95", metric: dist("borrowLatency", "p95"), unit: "ms", cloudwatch: "DatabaseConnectionsBorrowLatency" },
    { label: "Borrow timeouts", metric: rate("borrowTimeouts"), unit: "perSecond", tone: "bad" },
    { label: "Availability", metric: gauge("targetUp"), unit: "ratio", cloudwatch: "AvailabilityPercentage" }
  ],
  panels: [
    {
      id: "queries",
      title: "Query requests",
      unit: "perSecond",
      cloudwatch: ["QueryRequests"],
      help: "Queries received; those that had to wait for a database connection; those held through a failover and sent again; and those that waited past the borrow timeout.",
      lines: [
        { label: "queries", metric: rate("requests"), tone: "primary" },
        { label: "waited", metric: rate("queued"), tone: "warn" },
        { label: "held through failover", metric: rate("retried"), tone: "accent" },
        { label: "borrow timeouts", metric: rate("borrowTimeouts"), tone: "bad" }
      ]
    },
    {
      id: "database-connections",
      title: "Database connections",
      unit: "count",
      cloudwatch: ["DatabaseConnections", "DatabaseConnectionsCurrentlyBorrowed", "DatabaseConnectionsCurrentlySessionPinned", "MaxDatabaseConnectionsAllowed"],
      help: "Open to the database (idle ones the pool keeps too), borrowed by a request or a pinned session, and the most the pool may use: MaxConnectionsPercent of max_connections.",
      lines: [
        { label: "open", metric: gauge("databaseConnections"), tone: "primary" },
        { label: "borrowed", metric: gauge("borrowed"), tone: "accent" },
        { label: "pinned", metric: gauge("pinned"), tone: "warn" },
        { label: "max allowed", metric: gauge("limit"), tone: "muted", dashed: true }
      ]
    },
    latencyPanel("borrow-latency", "Borrow latency", "borrowLatency", ["DatabaseConnectionsBorrowLatency"]),
    {
      id: "waiting",
      title: "Waiting for a connection",
      unit: "count",
      help: "Requests waiting for a database connection: a burst past the pool waits here instead of being refused, up to the borrow timeout.",
      lines: [{ label: "waiting", metric: gauge("waiting"), tone: "warn" }]
    },
    {
      id: "latency",
      title: "Query latency",
      unit: "ms",
      cloudwatch: ["QueryResponseLatency", "QueryDatabaseResponseLatency"],
      help: "From the proxy receiving a query to answering it (waiting for a connection included), and the database's own share.",
      lines: [
        { label: "response p50", metric: dist("latency", "p50"), tone: "primary" },
        { label: "response p99", metric: dist("latency", "p99"), tone: "bad" },
        { label: "database p50", metric: dist("databaseResponseLatency", "p50"), tone: "accent" },
        { label: "database p99", metric: dist("databaseResponseLatency", "p99"), tone: "warn" }
      ]
    },
    {
      id: "client-connections",
      title: "Client connections",
      unit: "count",
      cloudwatch: ["ClientConnections"],
      help: "Connections clients hold open to the proxy. They cost the database nothing until a request borrows a connection for them.",
      lines: [{ label: "open", metric: gauge("clientConnections"), tone: "primary" }]
    },
    {
      id: "client-connects",
      title: "Client connections received",
      unit: "perSecond",
      cloudwatch: ["ClientConnectionsReceived"],
      help: "New client connections, at the proxy's handshake rather than the database's; and the share of them whose session is pinned to one database connection.",
      lines: [
        { label: "received", metric: rate("clientConnects"), tone: "primary" },
        { label: "pinned sessions", metric: rate("pinnedSessions"), tone: "warn" }
      ]
    },
    {
      id: "availability",
      title: "Availability",
      unit: "ratio",
      cloudwatch: ["AvailabilityPercentage"],
      help: "Whether the target database answers: it drops while the database fails over, and the proxy holds its clients' queries until it is back.",
      lines: [{ label: "available", metric: gauge("targetUp"), tone: "ok" }]
    }
  ]
}

/**
 * A caller's connections to a database (the `aws.rds.client` connector's edge): how many it holds open against
 * max_connections, how many it opens, and how many are refused. CloudWatch counts these for the instance as a whole;
 * here each caller's share is its own.
 */
export const databaseClient: Dashboard = {
  figures: [
    { label: "Connections", metric: gauge("connections"), unit: "count" },
    { label: "In use", metric: gauge("connectionsInUse"), unit: "count" },
    { label: "Opened", metric: rate("connectionsOpened"), unit: "perSecond" },
    { label: "Refused", metric: rate("connectionsRefused"), unit: "perSecond", tone: "bad" }
  ],
  panels: [
    {
      id: "connections",
      title: "Connections",
      unit: "count",
      cloudwatch: ["DatabaseConnections"],
      help: "This caller's connections: in use by a query (or held around one), and open altogether, idle ones in its pool included. Every open one counts against max_connections.",
      lines: [
        { label: "open", metric: gauge("connections"), tone: "primary" },
        { label: "in use", metric: gauge("connectionsInUse"), tone: "accent" }
      ]
    },
    {
      id: "connections-opened",
      title: "New connections",
      unit: "perSecond",
      cloudwatch: ["ConnectionAttempts"],
      help: "Connections this caller opened, each paying a handshake, and those the database refused at max_connections. One per request opens one for every call.",
      lines: [
        { label: "opened", metric: rate("connectionsOpened"), tone: "primary" },
        { label: "refused", metric: rate("connectionsRefused"), tone: "bad" }
      ]
    }
  ]
}

/** A caller's connections to an RDS Proxy (the `aws.rds-proxy.client` connector's edge). The proxy refuses none. */
export const proxyClient: Dashboard = {
  figures: [
    { label: "Connections", metric: gauge("connections"), unit: "count" },
    { label: "In use", metric: gauge("connectionsInUse"), unit: "count" },
    { label: "Opened", metric: rate("connectionsOpened"), unit: "perSecond" }
  ],
  panels: [
    {
      id: "connections",
      title: "Client connections",
      unit: "count",
      cloudwatch: ["ClientConnections"],
      help: "This caller's connections to the proxy: in use by a query (or held around one), and open altogether. They cost the database nothing until a query borrows one of its connections.",
      lines: [
        { label: "open", metric: gauge("connections"), tone: "primary" },
        { label: "in use", metric: gauge("connectionsInUse"), tone: "accent" }
      ]
    },
    {
      id: "connections-opened",
      title: "New connections",
      unit: "perSecond",
      cloudwatch: ["ClientConnectionsReceived"],
      lines: [{ label: "opened", metric: rate("connectionsOpened"), tone: "primary" }]
    }
  ]
}
