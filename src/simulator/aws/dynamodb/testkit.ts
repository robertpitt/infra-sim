import { Effect } from "effect"
import * as Builder from "../../Builder.ts"
import { sim } from "../../components/testing.ts"
import type * as Design from "../../Design.ts"
import type * as Simulation from "../../Simulation.ts"
import type { DynamoDb } from "./DynamoDb.ts"

/** Helpers shared by the DynamoDB tests: a client in front of a table, and a way to read the table's state. */

export type State = typeof DynamoDb.state.Type
export const write = { request: { operation: "write" } }
export const read = { request: { operation: "read" } }

/** A constant-rate client calling table `t` over an edge. `account` overrides the region's quotas. */
export const table = (
  settings: Record<string, unknown>,
  load: Record<string, unknown>,
  edge?: Record<string, unknown>,
  account?: Record<string, unknown>,
  seed = 2
): Design.Doc => {
  const b = Builder.make("ddb", { seed })
  const web = b.add("common.client", { id: "web", settings: { arrival: "constant", ...load } })
  const t = b.add("aws.dynamodb", { id: "t", settings })
  b.connect(web, t, edge)
  if (account !== undefined) b.account("aws:us-east-1", account)
  return b.build()
}

/** Run a design for `ms` and return the state of node `id`. */
export const stateAt = (doc: Design.Doc, ms: number, id = "t", options: Simulation.Options = {}): Promise<State> =>
  sim(doc, (s) =>
    Effect.gen(function*() {
      yield* s.advanceTo(ms)
      return (yield* s.probe(id)).state as State
    }), options)
