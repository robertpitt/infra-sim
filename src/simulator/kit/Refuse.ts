import { Effect } from "effect"
import { type Call, Rejected, Throttled } from "../Message.ts"

/** A call refused for lack of capacity (429, 503 Slow Down): a caller may retry it. */
export const throttled = (node: string, reason: string): Call => Effect.fail(Throttled({ node, reason }))

/** A call refused for what it is (too large, malformed, a failed condition): retrying cannot help. */
export const rejected = (node: string, reason: string): Call => Effect.fail(Rejected({ node, reason }))
