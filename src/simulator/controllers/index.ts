import type { AnyController } from "../Controller.ts"
import { TargetTracking } from "./TargetTracking.ts"

export { TargetTracking } from "./TargetTracking.ts"

/** The controllers every registry has, whatever providers it was built with. */
export const core: ReadonlyArray<AnyController> = [TargetTracking]
