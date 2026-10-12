import type { AnyConnector } from "../Connector.ts"
import { Link } from "./Link.ts"
import { Poller } from "./Poller.ts"
import { TargetGroup } from "./TargetGroup.ts"

export { Link } from "./Link.ts"
export { Poller } from "./Poller.ts"
export { TargetGroup } from "./TargetGroup.ts"

/**
 * The connectors every registry has, whatever providers it was built with. Order matters among equally specific ones:
 * the plain link comes before the target group, so a plain edge into a fleet stays a plain call.
 */
export const core: ReadonlyArray<AnyConnector> = [Link, Poller, TargetGroup]
