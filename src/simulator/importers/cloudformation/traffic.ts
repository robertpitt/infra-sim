import { entryPoint } from "./common.ts"
import type { Run } from "./model.ts"

/**
 * Things that are called from outside, and nothing in the template calls them, are given a source of traffic: a
 * template has none of its own, so these are assumptions, and each is listed in the report.
 */

export const traffic = (run: Run): void => {
  for (const d of [...run.drafts.values()]) {
    if (d.type === "common.client" || d.type === "common.http-endpoint" || run.replicaCopies.has(d)) continue
    // Replication into a global table isn't someone writing to it: its home table still needs a writer.
    const inbound = run.wires.some((w) => w.to === d && w.port !== "replicas")
    const outbound = run.wires.some((w) => w.from === d)
    if (inbound) continue
    // A gateway that answers itself (MOCK) calls nothing, and still has callers.
    if (d.type === "aws.apigateway" && (outbound || run.setting(d, ["integrationType"]) === "mock")) entryPoint(run, d, `Callers of ${d.name}`)
    else if (d.type === "aws.cloudfront" && outbound) {
      // The engine's default edge is a write, which a cache passes straight through: viewers fetch (read) objects.
      entryPoint(run, d, `Viewers of ${d.name}`, { request: { operation: "read" } })
    } else if (d.type === "aws.sqs" || d.type === "aws.sns" || d.type === "aws.s3" || d.type === "aws.dynamodb" || d.type === "aws.ses") {
      if (!outbound) {
        if (d.type === "aws.ses") run.warn(`${d.name} isn't called by anything in the template, and has no event destinations: it is on the canvas but idle.`)
        continue
      }
      const client = run.draft(`client:producers:${d.key}`, `${d.type === "aws.ses" ? "Senders through" : "Writers to"} ${d.name}`, "common.client", { source: "assumed", ref: d.name })
      run.set(client, ["rps"], run.options.rps, "traffic")
      run.wire(client, "out", d, { declared: false })
      run.added.push(`A traffic source "${client.name}" at ${run.options.rps} requests/s (assumed: the template doesn't say what feeds ${d.name}).`)
    } else if (d.type === "aws.lambda" && !outbound && !run.edgeFunctions.has(d)) {
      run.warn(`${d.name} isn't triggered by anything in the template, or doesn't call anything: it is on the canvas but idle.`)
    }
  }
}
