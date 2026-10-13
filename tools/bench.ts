// Benchmark an example design: how much CPU a simulated stretch costs, at a multiple of its traffic.
//   npx tsx tools/bench.ts [example-id] [virtual-ms] [traffic-scale]      e.g.  ingestion 60000 10
// Reports CPU time, not wall time: this machine is rarely idle, and wall time moves with whatever else is running.
import fs from "node:fs"
import { Effect } from "effect"
import YAML from "yaml"
import type * as Design from "../src/simulator/Design.ts"
import { sim } from "../src/simulator/testing.ts"

const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000 }
const example = (id: string): Design.Doc => {
  const file = fs.readdirSync("examples").find((f) => f.replace(/^\d+-/, "").replace(/\.(ya?ml|json)$/, "") === id)
  if (file === undefined) throw new Error(`no example "${id}" in examples/`)
  return YAML.parse(fs.readFileSync(`examples/${file}`, "utf8")) as Design.Doc
}

const which = process.argv[2] ?? "ingestion"
const virtualMs = Number(process.argv[3] ?? 60_000)
const scale = Number(process.argv[4] ?? 1)
const base = example(which)
// Scale every traffic source's rate, to push the engine at volumes the example doesn't ask for.
const doc = {
  ...base,
  nodes: Object.fromEntries(Object.entries(base.nodes).map(([id, n]) => [id, n.type === "common.client" && typeof (n.settings as any)?.rps === "number" ? { ...n, settings: { ...n.settings, rps: (n.settings as any).rps * scale } } : n]))
}
const t0 = performance.now()
const result = await sim(doc, (s) =>
  Effect.gen(function*() {
    const warm = cpu()
    const all: Array<any> = []
    const slice = Number(process.env.SLICE ?? 0)
    if (slice > 0) {
      for (let t = slice; t <= virtualMs; t += slice) {
        const w = performance.now()
        all.push(...(yield* s.advanceTo(t)))
        const timers = yield* (s as any).timers?.() ?? Effect.succeed(0)
        console.error(`t=${t / 1000}s slice ${Math.round(performance.now() - w)}ms mem ${Math.round(process.memoryUsage().heapUsed / 1e6)}MB`)
      }
    } else all.push(...(yield* s.advanceTo(virtualMs)))
    const wall = cpu() - warm
    let calls = 0
    for (const f of all) for (const n of Object.values(f.nodes)) calls += (n.rates.in ?? 0) * 0.25
    return { wall, calls, frames: all.length }
  })
)
const total = performance.now() - t0
console.log(JSON.stringify({
  which, virtualMs, scale, wallMs: Math.round(result.wall), setupMs: Math.round(total - result.wall),
  speedup: Number((virtualMs / result.wall).toFixed(2)), nodeCalls: Math.round(result.calls), callsPerSec: Math.round(result.calls / (result.wall / 1000)),
  mem: Math.round(process.memoryUsage().heapUsed / 1e6) + "MB"
}))
process.exit(0)
