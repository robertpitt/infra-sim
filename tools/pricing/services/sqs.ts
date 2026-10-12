import { attr, type ServiceMap } from "../map.ts"

/**
 * SQS: requests, by queue type, tiered by the month's requests (standard and FIFO each have their own tiers). Every API
 * action is a request, and a payload is billed as one request per 64 KB chunk: the simulator's request counting does
 * that, the price is per request. https://aws.amazon.com/sqs/pricing/
 *
 * Usage types (after the region prefix): `Requests-RBP` or `Requests-Tier1` for standard queues, `Requests-FIFO-RBP` or
 * `Requests-FIFO-Tier1` for FIFO (the name differs by region, so rows are told apart by their `Queue Type` column). The
 * free tier is `Global-Requests`, 0 to 1,000,000 at 0, once for every queue type together.
 * Left out: fair queues (`Requests-Fair-*`: the simulator has no fair queues), data transfer (not in this price list).
 */
export const sqs: ServiceMap = {
  id: "sqs",
  title: "Amazon SQS",
  offers: ["AWSQueueService"],
  dimensions: {
    "requests/standard": {
      unit: "request",
      description: "API requests to standard queues, each 64 KB chunk of a payload counting as one",
      freeShared: "requests"
    },
    "requests/fifo": {
      unit: "request",
      description: "API requests to FIFO queues, each 64 KB chunk of a payload counting as one",
      freeShared: "requests"
    }
  },
  classify: (row) => {
    if (row.family !== "API Request") return undefined
    // The free million is for every queue type together: listed once, given to both, shared (`freeShared`).
    if (row.usage === "Global-Requests")
      return [
        { dimension: "requests/standard", free: true },
        { dimension: "requests/fifo", free: true }
      ]
    if (!row.usage.startsWith("Requests-")) return undefined
    switch (attr(row, "Queue Type")) {
      case "Standard":
        return { dimension: "requests/standard" }
      case "FIFO (first-in, first-out)":
        return { dimension: "requests/fifo" }
      default:
        return undefined
    }
  }
}
