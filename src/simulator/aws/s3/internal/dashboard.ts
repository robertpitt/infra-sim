import { type Dashboard, dist, gauge, rate, ratio } from "../../../Dashboard.ts"

/**
 * A bucket's dashboard, as S3's request metrics and replication metrics show one in CloudWatch: requests by kind, 4xx
 * and 5xx errors (a 503 Slow Down is a prefix over its rate), first-byte and total latency, bytes moved, and the
 * replication and event notifications that follow a write. Names follow CloudWatch's
 * (https://docs.aws.amazon.com/AmazonS3/latest/userguide/metrics-dimensions.html). The daily storage metrics
 * (BucketSizeBytes, NumberOfObjects) have no counterpart: the simulator doesn't keep the objects.
 */
export const dashboard: Dashboard = {
  figures: [
    { label: "Requests", metric: rate("requests"), unit: "perSecond", cloudwatch: "AllRequests" },
    { label: "5xx (Slow Down)", metric: rate("5xxErrors"), unit: "perSecond", tone: "bad", cloudwatch: "5xxErrors" },
    { label: "4xx", metric: rate("4xxErrors"), unit: "perSecond", tone: "warn", cloudwatch: "4xxErrors" },
    { label: "First byte p95", metric: dist("firstByteLatency", "p95"), unit: "ms", cloudwatch: "FirstByteLatency" },
    { label: "Downloaded", metric: rate("bytesDownloaded"), unit: "bytesPerSecond", cloudwatch: "BytesDownloaded" },
    { label: "Uploaded", metric: rate("bytesUploaded"), unit: "bytesPerSecond", cloudwatch: "BytesUploaded" }
  ],
  panels: [
    {
      id: "requests",
      title: "Requests",
      unit: "perSecond",
      cloudwatch: ["AllRequests", "GetRequests", "PutRequests"],
      help: "Every request (refused ones too), and the GETs and PUTs served. A COPY counts as a PUT, and each part of a multipart upload as one.",
      lines: [
        { label: "all", metric: rate("requests"), tone: "primary" },
        { label: "GET", metric: rate("get"), tone: "teal" },
        { label: "PUT", metric: rate("put"), tone: "accent" }
      ]
    },
    {
      id: "errors",
      title: "Errors",
      unit: "perSecond",
      cloudwatch: ["5xxErrors", "4xxErrors"],
      help: "5xx is 503 Slow Down: a prefix asked for more than its request rate. 4xx is a single PUT over 5 GB, or a GET of an archived object.",
      lines: [
        { label: "5xx", metric: rate("5xxErrors"), tone: "bad" },
        { label: "4xx", metric: rate("4xxErrors"), tone: "warn" }
      ]
    },
    {
      id: "latency",
      title: "Request latency",
      unit: "ms",
      cloudwatch: ["FirstByteLatency", "TotalRequestLatency"],
      help: "First byte: from the request received to the response starting. Total: until the last byte, so a large object adds the time to move it.",
      lines: [
        { label: "first byte p50", metric: dist("firstByteLatency", "p50"), tone: "primary" },
        { label: "first byte p99", metric: dist("firstByteLatency", "p99"), tone: "teal" },
        { label: "total p50", metric: dist("totalRequestLatency", "p50"), tone: "accent" },
        { label: "total p99", metric: dist("totalRequestLatency", "p99"), tone: "bad" }
      ]
    },
    {
      id: "bytes",
      title: "Bytes transferred",
      unit: "bytesPerSecond",
      cloudwatch: ["BytesDownloaded", "BytesUploaded"],
      lines: [
        { label: "downloaded", metric: rate("bytesDownloaded"), tone: "primary" },
        { label: "uploaded", metric: rate("bytesUploaded"), tone: "accent" }
      ]
    },
    {
      id: "prefix-ceiling",
      title: "Request rate per prefix",
      unit: "perSecond",
      help: "The highest rate one prefix is allowed now: the guaranteed 5,500 GET/HEAD and 3,500 PUT/COPY/POST/DELETE a second, or what S3's scale-up of a busy prefix has reached.",
      lines: [
        { label: "reads", metric: gauge("readCeiling"), tone: "primary", dashed: true },
        { label: "writes", metric: gauge("writeCeiling"), tone: "accent", dashed: true }
      ]
    },
    {
      id: "replication-latency",
      title: "Replication latency",
      unit: "ms",
      cloudwatch: ["ReplicationLatency"],
      help: "From a write to its replica landing in the destination bucket. Replication Time Control queues the bytes behind the region's transfer quota.",
      lines: [
        { label: "p50", metric: dist("replicationLag", "p50"), tone: "primary" },
        { label: "p99", metric: dist("replicationLag", "p99"), tone: "warn" },
        { label: "max", metric: dist("replicationLag", "max"), tone: "bad" }
      ]
    },
    {
      id: "pending",
      title: "Pending",
      unit: "count",
      cloudwatch: ["OperationsPendingReplication"],
      help: "Replicas not yet landed, and event notifications not yet delivered: both wait out a delay, then go through their edge.",
      lines: [
        { label: "replication", metric: gauge("replicating"), tone: "accent" },
        { label: "notifications", metric: gauge("pending"), tone: "teal" }
      ]
    },
    {
      id: "deliveries",
      title: "Replication and event notifications",
      unit: "perSecond",
      cloudwatch: ["OperationsFailedReplication"],
      help: "Replicas written and event messages delivered, and those the edge gave up on after its retries.",
      lines: [
        { label: "replicated", metric: rate("replicated"), tone: "accent" },
        { label: "replication failed", metric: rate("replicationFailed"), tone: "bad" },
        { label: "events delivered", metric: rate("delivered"), tone: "teal" },
        { label: "events failed", metric: rate("undelivered"), tone: "warn" }
      ]
    },
    {
      id: "request-size",
      title: "Bytes per request",
      unit: "bytes",
      cloudwatch: ["BytesDownloaded (Average)", "BytesUploaded (Average)"],
      help: "Bytes per GET and per PUT: CloudWatch's Average statistic of the byte metrics. A COPY counts as a PUT that uploads nothing, and a multipart upload's PUTs are its parts.",
      lines: [
        { label: "per GET", metric: ratio(rate("bytesDownloaded"), rate("get")), tone: "primary" },
        { label: "per PUT", metric: ratio(rate("bytesUploaded"), rate("put")), tone: "accent" }
      ]
    },
    {
      id: "other-requests",
      title: "Other requests",
      unit: "perSecond",
      cloudwatch: ["ListRequests", "HeadRequests", "DeleteRequests", "PostRequests"],
      help: "The bucket's request mix is a setting (shares of LIST, HEAD, DELETE and COPY): left at none, every read is a GET and every write a PUT. POST is a multipart upload's initiate and complete.",
      lines: [
        { label: "LIST", metric: rate("list"), tone: "primary" },
        { label: "HEAD", metric: rate("head"), tone: "teal" },
        { label: "DELETE", metric: rate("delete"), tone: "accent" },
        { label: "POST", metric: rate("post"), tone: "muted" }
      ]
    }
  ]
}
