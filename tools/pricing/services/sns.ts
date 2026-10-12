import type { Row } from "../bulk.ts"
import type { ServiceMap } from "../map.ts"

/** A usage type's first range at 0 (0 to 1,000,000 publishes): the monthly free tier, the paid range following it. */
const freeRange = (row: Row) => row.price === 0 && row.from === 0 && row.to !== Number.POSITIVE_INFINITY

/**
 * SNS: publishes (API requests, one per 64 KB chunk of a message), and deliveries by the subscriber's protocol; a FIFO
 * topic instead bills publishes plus the payload published, and deliveries to its SQS subscribers plus their payload.
 * https://aws.amazon.com/sns/pricing/
 *
 * Usage types (after the region prefix): `Requests-Tier1` (the first 1,000,000 a month at 0, the free tier);
 * `DeliveryAttempts-SQS`, `DeliveryAttempts-LAMBDA` (both 0) and `DeliveryAttempts-HTTP` (the first 100,000 at 0);
 * FIFO's `F-Request-Tier1`, `F-Ingress-Tier1` (GB published), `F-DA-SQS` (messages delivered) and `F-Egress-SQS` (GB
 * delivered).
 * Left out: email, SMS, mobile push and Firehose deliveries (no such subscriber in the simulator), payload-based message
 * filtering (`PL-Filter-*`: filtering is a rate here, with no payload to scan), FIFO archiving and replay
 * (`F-Storage`, `F-ArchiveProcessing`), message data protection (`MDP-*`).
 */
export const sns: ServiceMap = {
  id: "sns",
  title: "Amazon SNS",
  offers: ["AmazonSNS"],
  dimensions: {
    "publish/standard": {
      unit: "request",
      description: "Publishes to standard topics, each 64 KB chunk of a message counting as one"
    },
    "publish/fifo": {
      unit: "request",
      description: "Publishes to FIFO topics, each 64 KB chunk of a message counting as one"
    },
    "publish-payload/fifo": {
      unit: "GB",
      description: "Payload published to FIFO topics"
    },
    "delivery/sqs": {
      unit: "notification",
      description: "Deliveries from standard topics to SQS queues (no charge)"
    },
    "delivery/lambda": {
      unit: "notification",
      description: "Deliveries from standard topics to Lambda functions (no charge)"
    },
    "delivery/http": {
      unit: "notification",
      description: "Deliveries from standard topics to HTTP/S endpoints, each 64 KB chunk counting as one"
    },
    "delivery/fifo": {
      unit: "message",
      description: "Deliveries from FIFO topics to SQS queues, after filtering"
    },
    "delivery-payload/fifo": {
      unit: "GB",
      description: "Payload delivered from FIFO topics to SQS queues"
    }
  },
  classify: (row) => {
    switch (row.usage) {
      case "Requests-Tier1":
        return { dimension: "publish/standard", free: freeRange(row) }
      case "F-Request-Tier1":
        return { dimension: "publish/fifo" }
      case "F-Ingress-Tier1":
        return { dimension: "publish-payload/fifo" }
      case "DeliveryAttempts-SQS":
        return { dimension: "delivery/sqs" }
      case "DeliveryAttempts-LAMBDA":
        return { dimension: "delivery/lambda" }
      case "DeliveryAttempts-HTTP":
        return { dimension: "delivery/http", free: freeRange(row) }
      case "F-DA-SQS":
        return { dimension: "delivery/fifo" }
      case "F-Egress-SQS":
        return { dimension: "delivery-payload/fifo" }
      default:
        return undefined
    }
  }
}
