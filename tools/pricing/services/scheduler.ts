import type { ServiceMap } from "../map.ts"

/**
 * EventBridge Scheduler: invocations of a schedule's target, the first 14 million a month free (for the account, across
 * regions). Listed in EventBridge's price list. https://aws.amazon.com/eventbridge/pricing/#Scheduler
 *
 * Usage types (after the region prefix): `ScheduledInvocation` (operation `Invocation`), 0 to 14,000,000 at 0 (the free
 * tier), then paid.
 * Left out: nothing else is billed (creating schedules and schedule groups is free).
 */
export const scheduler: ServiceMap = {
  id: "scheduler",
  title: "Amazon EventBridge Scheduler",
  offers: ["AWSEvents"],
  dimensions: {
    invocations: {
      unit: "invocation",
      description: "Scheduled invocations of a target"
    }
  },
  classify: (row) => {
    if (row.usage !== "ScheduledInvocation") return undefined
    return { dimension: "invocations", free: row.price === 0 && row.from === 0 && row.to !== Number.POSITIVE_INFINITY }
  }
}
