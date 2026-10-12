import { type Dashboard, dist, gauge, latencyPanel, rate } from "../../Dashboard.ts"

/**
 * A domain's dashboard, as CloudWatch and the OpenSearch Service console show one: search and indexing rates and
 * latencies, the thread pools' queues and rejections, indexing pressure, CPU, the cluster's status, nodes and shards,
 * and how far refresh lags. Names follow CloudWatch's
 * (https://docs.aws.amazon.com/opensearch-service/latest/developerguide/managedomains-cloudwatchmetrics.html); its rates
 * are per minute, these per second.
 *
 * The heap and the disks aren't modelled, so JVMMemoryPressure, FreeStorageSpace and the EBS metrics have no
 * counterpart; nor does SearchableDocuments, as the domain keeps no documents, only the work of indexing them.
 */
export const dashboard: Dashboard = {
  figures: [
    { label: "Search rate", metric: rate("searchShards"), unit: "perSecond", cloudwatch: "SearchRate" },
    { label: "Search latency p95", metric: dist("searchLatency", "p95"), unit: "ms", cloudwatch: "SearchLatency" },
    { label: "Indexing rate", metric: rate("indexed"), unit: "perSecond", cloudwatch: "IndexingRate" },
    { label: "CPU (max)", metric: gauge("cpuMax"), unit: "ratio", cloudwatch: "CPUUtilization" },
    { label: "429s", metric: rate("fail.Throttled"), unit: "perSecond", tone: "bad" },
    { label: "Search queue", metric: gauge("searchQueue"), unit: "count", cloudwatch: "ThreadpoolSearchQueue" }
  ],
  panels: [
    {
      id: "search-rate",
      title: "Search rate",
      unit: "perSecond",
      cloudwatch: ["SearchRate"],
      help: "Shard-level queries: a search of every shard counts once per shard, as SearchRate does. Requests are the searches clients sent.",
      lines: [
        { label: "shard queries", metric: rate("searchShards"), tone: "primary" },
        { label: "requests", metric: rate("searchRequests"), tone: "teal" }
      ]
    },
    {
      ...latencyPanel("search-latency", "Search latency", "searchLatency", ["SearchLatency"]),
      help: "A shard's query from a search thread taking it up to its answer, as OpenSearch times it: slower when indexing shares the processors. Time waiting for a thread shows as the search queue."
    },
    {
      id: "indexing-rate",
      title: "Indexing rate",
      unit: "perSecond",
      cloudwatch: ["IndexingRate"],
      help: "Documents indexed on primaries, and again on each replica: replicas cost the same write capacity.",
      lines: [
        { label: "primaries", metric: rate("indexed"), tone: "accent" },
        { label: "replicas", metric: rate("replicated"), tone: "teal" }
      ]
    },
    {
      ...latencyPanel("indexing-latency", "Indexing latency", "indexingLatency", ["IndexingLatency"]),
      help: "A shard's part of a write, on its primary or a replica, from a write thread taking it up to done. A bulk's documents are indexed together, so a bigger bulk takes longer."
    },
    {
      id: "cpu",
      title: "CPU utilization",
      unit: "ratio",
      cloudwatch: ["CPUUtilization"],
      help: "The write and search thread pools share each node's processors, so a bulk load slows the searches beside it.",
      lines: [
        { label: "max", metric: gauge("cpuMax"), tone: "warn" },
        { label: "average", metric: gauge("cpu"), tone: "primary" }
      ]
    },
    {
      id: "queues",
      title: "Thread pool queues",
      unit: "count",
      cloudwatch: ["ThreadpoolSearchQueue", "ThreadpoolWriteQueue"],
      help: "Tasks waiting for a thread, over the nodes. A node rejects past 1,000 queued searches or 10,000 writes.",
      lines: [
        { label: "search", metric: gauge("searchQueue"), tone: "primary" },
        { label: "write", metric: gauge("writeQueue"), tone: "accent" }
      ]
    },
    {
      id: "rejections",
      title: "Rejections",
      unit: "perSecond",
      cloudwatch: ["ThreadpoolSearchRejected", "ThreadpoolWriteRejected", "CoordinatingWriteRejected", "PrimaryWriteRejected", "ReplicaWriteRejected"],
      help: "Shard tasks refused by a full queue, and writes refused for indexing pressure on the coordinating node, the primary or a replica. Each is a 429 (a replica's only fails that copy).",
      lines: [
        { label: "search queue", metric: rate("searchRejected"), tone: "bad" },
        { label: "write queue", metric: rate("writeTasksRejected"), tone: "warn" },
        { label: "coordinating", metric: rate("coordinatingWriteRejected"), tone: "accent" },
        { label: "primary", metric: rate("primaryWriteRejected"), tone: "teal" },
        { label: "replica", metric: rate("replicaWriteRejected"), tone: "muted" }
      ]
    },
    {
      id: "indexing-pressure",
      title: "Indexing pressure",
      unit: "ratio",
      help: "The fullest node's indexing bytes in flight, as coordinating node and primary, against its limit of 10% of the heap. Past it writes are rejected.",
      lines: [{ label: "fullest node", metric: gauge("indexingPressure"), tone: "accent" }]
    },
    {
      id: "status",
      title: "Cluster status",
      unit: "count",
      cloudwatch: ["ClusterStatus.green", "ClusterStatus.yellow", "ClusterStatus.red"],
      help: "1 while it holds. Yellow: every primary is assigned but some replica isn't. Red: some shard has no copy at all.",
      lines: [
        { label: "green", metric: gauge("statusGreen"), tone: "ok" },
        { label: "yellow", metric: gauge("statusYellow"), tone: "warn" },
        { label: "red", metric: gauge("statusRed"), tone: "bad" }
      ]
    },
    {
      id: "shards",
      title: "Nodes and shards",
      unit: "count",
      cloudwatch: ["Nodes", "Shards.active", "Shards.unassigned"],
      help: "Data nodes up, and shard copies serving or unassigned (on a failed node, or with nowhere to go).",
      lines: [
        { label: "data nodes", metric: gauge("liveNodes"), tone: "primary" },
        { label: "active shards", metric: gauge("activeShards"), tone: "ok" },
        { label: "unassigned shards", metric: gauge("unassignedShards"), tone: "bad" }
      ]
    },
    {
      id: "refresh",
      title: "Refresh lag",
      unit: "ms",
      help: "How long the oldest document indexed but not yet searchable has waited, and how long documents take to become searchable: both from the document's creation, so time in queues on the way counts, then until the next refresh.",
      lines: [
        { label: "oldest unsearchable", metric: gauge("refreshLag"), tone: "warn" },
        { label: "searchable after p50", metric: dist("searchableAfter", "p50"), tone: "primary" },
        { label: "searchable after p95", metric: dist("searchableAfter", "p95"), tone: "accent" }
      ]
    }
  ]
}
