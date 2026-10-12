import { describe, expect, it } from "vitest"
import * as Builder from "../Builder.ts"
import { frames, mean } from "../components/testing.ts"

describe("common.client", () => {
  it("sends a batch of records in one request when asked, and services count the records", async () => {
    const run = async (records: number) => {
      const b = Builder.make("batch", { seed: 2 })
      const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 10, records, payload: 1 } })
      b.connect(web, b.add("aws.dynamodb", { id: "table", settings: { mode: "on-demand" } }))
      const all = await frames(b.build(), 10_000)
      return { requests: mean(all, "nodes", "web", "rates", "sent", 3_000), units: mean(all, "nodes", "table", "rates", "consumedWrite", 3_000) }
    }
    const single = await run(1)
    const batched = await run(25)
    expect(batched.requests).toBeCloseTo(single.requests, 0)
    expect(batched.units).toBeGreaterThan(20 * single.units)
  })
})
