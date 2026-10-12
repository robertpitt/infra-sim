import type { ServiceMap } from "../map.ts"

/**
 * Step Functions: Standard workflows by state transition (retries included), the first 4,000 a month free; Express
 * workflows by request (each execution started) and by duration (GB-seconds of memory used, rounded up to 100 ms and to
 * 64 MB steps), tiered by the month's GB-seconds. https://aws.amazon.com/step-functions/pricing/
 *
 * Usage types (after the region prefix): `StateTransition`, with the free tier as `Global-StateTransition` (0 to 4,000 at
 * 0); `StepFunctions-Request`; `StepFunctions-GB-Second`.
 * Left out: nothing else is in the price list. Distributed Map child executions are billed as executions of their type.
 */
export const stepfunctions: ServiceMap = {
  id: "stepfunctions",
  title: "AWS Step Functions",
  offers: ["AmazonStates"],
  dimensions: {
    "transitions/standard": {
      unit: "state-transition",
      description: "State transitions of Standard workflows, retries included"
    },
    "requests/express": {
      unit: "request",
      description: "Express workflow executions started"
    },
    "duration/express": {
      unit: "GB-second",
      description: "Express workflow duration by memory used, rounded up to 100 ms and to 64 MB"
    }
  },
  classify: (row) => {
    switch (row.usage) {
      case "StateTransition":
        return { dimension: "transitions/standard" }
      case "Global-StateTransition":
        return { dimension: "transitions/standard", free: true }
      case "StepFunctions-Request":
        return { dimension: "requests/express" }
      case "StepFunctions-GB-Second":
        return { dimension: "duration/express" }
      default:
        return undefined
    }
  }
}
