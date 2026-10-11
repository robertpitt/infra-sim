import type { AnyConnector } from "../Connector.ts"
import { EventSourceMapping } from "./sqs/EventSourceMapping.ts"

/**
 * What AWS puts between its services: the things on an edge that belong to neither end. Each lives in the folder of
 * the service whose integration it is, and must not import `provider.ts` (which imports this).
 */
export const connectors: ReadonlyArray<AnyConnector> = [EventSourceMapping]
