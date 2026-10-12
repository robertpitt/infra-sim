import type { ServiceMap } from "../map.ts"

/**
 * Lambda: requests, and duration by memory (GB-seconds), each by architecture; provisioned concurrency (GB-seconds
 * configured, plus a lower duration rate while running on it); ephemeral storage past the free 512 MB.
 * https://aws.amazon.com/lambda/pricing/
 *
 * Usage types (after the region prefix): `Request` and `Request-ARM`; `Lambda-GB-Second` and `Lambda-GB-Second-ARM`,
 * tiered by the month's GB-seconds; `Lambda-Provisioned-Concurrency[-ARM]`; `Lambda-Provisioned-GB-Second[-ARM]`;
 * `Lambda-Storage-GB-Second[-ARM]`. The free tier is listed as `Global-Request` and `Global-Lambda-GB-Second` at 0.
 * Left out: Lambda@Edge (priced with CloudFront's), managed instances, SnapStart, durable functions, response streaming.
 */
export const lambda: ServiceMap = {
  id: "lambda",
  title: "AWS Lambda",
  offers: ["AWSLambda"],
  dimensions: {
    requests: {
      unit: "request",
      description: "Requests (invocations), either architecture"
    },
    "duration/x86_64": {
      unit: "GB-second",
      description: "Duration on x86, by memory configured",
      freeShared: "duration"
    },
    "duration/arm64": {
      unit: "GB-second",
      description: "Duration on Arm (Graviton), by memory configured",
      freeShared: "duration"
    },
    "provisioned-concurrency/x86_64": {
      unit: "GB-second",
      description: "Provisioned concurrency configured, on x86, while it is configured"
    },
    "provisioned-concurrency/arm64": {
      unit: "GB-second",
      description: "Provisioned concurrency configured, on Arm, while it is configured"
    },
    "provisioned-duration/x86_64": {
      unit: "GB-second",
      description: "Duration on x86 of invocations served by provisioned concurrency"
    },
    "provisioned-duration/arm64": {
      unit: "GB-second",
      description: "Duration on Arm of invocations served by provisioned concurrency"
    },
    "ephemeral-storage/x86_64": {
      unit: "GB-second",
      description: "Ephemeral storage configured past the free 512 MB, on x86"
    },
    "ephemeral-storage/arm64": {
      unit: "GB-second",
      description: "Ephemeral storage configured past the free 512 MB, on Arm"
    }
  },
  classify: (row) => {
    const arch = row.usage.endsWith("-ARM") ? "arm64" : "x86_64"
    const usage = row.usage.replace(/-ARM$/, "")
    switch (usage) {
      case "Request":
        return { dimension: "requests" }
      case "Global-Request":
        return { dimension: "requests", free: true }
      case "Lambda-GB-Second":
        return { dimension: `duration/${arch}` }
      // The free 400,000 GB-seconds are for both architectures together: listed once, given to both, shared (`freeShared`).
      case "Global-Lambda-GB-Second":
        return [
          { dimension: "duration/x86_64", free: true },
          { dimension: "duration/arm64", free: true }
        ]
      case "Lambda-Provisioned-Concurrency":
        return { dimension: `provisioned-concurrency/${arch}` }
      case "Lambda-Provisioned-GB-Second":
        return { dimension: `provisioned-duration/${arch}` }
      case "Lambda-Storage-GB-Second":
        return { dimension: `ephemeral-storage/${arch}` }
      default:
        return undefined
    }
  }
}
