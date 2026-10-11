import type { AnyConnector } from "../Connector.ts"
import { Link } from "./Link.ts"
import { Poller } from "./Poller.ts"

export { Link } from "./Link.ts"
export { Poller } from "./Poller.ts"

/** The connectors every registry has, whatever providers it was built with. */
export const core: ReadonlyArray<AnyConnector> = [Link, Poller]
