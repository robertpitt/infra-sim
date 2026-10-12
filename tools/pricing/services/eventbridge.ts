import type { ServiceMap } from "../map.ts"

/**
 * EventBridge (event buses): custom events put on a bus, and invocations of API destinations, each counted in 64 KB
 * chunks of the event. Delivering to other targets is free. https://aws.amazon.com/eventbridge/pricing/
 *
 * Usage types (after the region prefix): `Event-64K-Chunks` with operation `PutEvents` (custom events; the same usage type
 * with `ReceivedPartnerEvents` is partner events) and `Invocation-64K-Chunks` with operation `InvokeApiDestination`.
 * Left out: partner events, cross-account and cross-region delivery (`Invocation-64K-Chunks` with `CrossAccountInvoke-*`),
 * archive and replay (`ArchivedEvents-Bytes`, `TimedStorage-ByteHrs`), schema discovery, Pipes, and the newer event bus
 * (`EventsV2-*`): none of them is in the simulator. Scheduler's invocations, in the same price list, are `scheduler.ts`.
 */
export const eventbridge: ServiceMap = {
  id: "eventbridge",
  title: "Amazon EventBridge",
  offers: ["AWSEvents"],
  dimensions: {
    "events/custom": {
      unit: "event",
      description: "Custom events put on an event bus, each 64 KB chunk of an event counting as one"
    },
    "api-destination": {
      unit: "invocation",
      description: "Invocations of API destinations, each 64 KB chunk of an event counting as one"
    }
  },
  classify: (row) => {
    if (row.usage === "Event-64K-Chunks" && row.operation === "PutEvents") return { dimension: "events/custom" }
    if (row.usage === "Invocation-64K-Chunks" && row.operation === "InvokeApiDestination") return { dimension: "api-destination" }
    return undefined
  }
}
