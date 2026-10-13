/**
 * Which metrics each component's dashboard reads that no example ever records: a misspelt counter, or one a component
 * forgot to register, shows as "—" on screen and nowhere else. Runs every example for a while and reports, per component
 * type (and per connector), the dashboard's names never seen. A name an example simply never exercises (a stream nobody
 * reads, a fault nobody injects) shows here too; read the list, don't trust it blindly.
 *
 *   npx tsx tools/dashboard-check.ts [seconds] [type-filter]
 */
import fs from "node:fs"
import { Graph } from "effect"
import YAML from "yaml"
import { Dashboard, Design } from "#simulator"
import { registry } from "#simulator/components"
import { frames } from "../src/simulator/testing.ts"

/** The examples, read from disk (the app bundles them with Vite; here there is no Vite). */
const examples = fs
  .readdirSync("examples")
  .filter((f) => /\.(ya?ml|json)$/.test(f))
  .sort()
  .map((f) => {
    const parsed = Design.parse(YAML.parse(fs.readFileSync(`examples/${f}`, "utf8")))
    if (!parsed.ok) throw new Error(`${f}: ${parsed.issues.join(" ")}`)
    return { id: f, design: () => parsed.doc }
  })

const seconds = Number(process.argv[2] ?? 90)
const filter = process.argv[3]

/** Every rate, gauge and distribution name seen on nodes of each type, and on edges of each connector. */
const seen = new Map<string, { rates: Set<string>; gauges: Set<string>; dists: Set<string> }>()
const bag = (key: string) => {
  let b = seen.get(key)
  if (b === undefined) seen.set(key, (b = { rates: new Set(), gauges: new Set(), dists: new Set() }))
  return b
}

for (const example of examples) {
  if (example.id.includes("blank")) continue
  const doc = example.design()
  const resolved = Design.resolve(doc, registry).design
  if (resolved === undefined) continue
  const connectorOf = new Map([...resolvedEdges(resolved)])
  const all = await frames(doc, seconds * 1000)
  for (const f of all) {
    for (const [id, s] of Object.entries(f.nodes)) {
      const type = doc.nodes[id]?.type
      if (type === undefined) continue
      const b = bag(type)
      for (const k of Object.keys(s.rates)) b.rates.add(k)
      for (const k of Object.keys(s.gauges)) b.gauges.add(k)
      for (const [k, d] of Object.entries(s.dist)) if (d.n > 0) b.dists.add(k)
    }
    for (const [id, s] of Object.entries(f.edges)) {
      const type = connectorOf.get(id)
      if (type === undefined) continue
      const b = bag(type)
      for (const k of Object.keys(s.rates)) b.rates.add(k)
      for (const k of Object.keys(s.gauges)) b.gauges.add(k)
      for (const [k, d] of Object.entries(s.dist)) if (d.n > 0) b.dists.add(k)
    }
  }
  console.error(`ran ${example.id}`)
}

/** Each edge's id and the type of the connector on it. */
function* resolvedEdges(design: Design.Design): Generator<[string, string]> {
  for (const [, e] of Graph.edges(design.graph)) yield [e.data.id, e.data.connector.type]
}

const report = (type: string, dashboard: Dashboard.Dashboard | undefined): void => {
  if (dashboard === undefined || (filter !== undefined && !type.includes(filter))) return
  const names = Dashboard.namesIn(dashboard)
  const b = seen.get(type)
  if (b === undefined) {
    console.log(`${type}: in no example`)
    return
  }
  const missing = [
    ...[...names.rates].filter((n) => !b.rates.has(n)).map((n) => `rate ${n}`),
    ...[...names.gauges].filter((n) => !b.gauges.has(n)).map((n) => `gauge ${n}`),
    ...[...names.dists].filter((n) => !b.dists.has(n)).map((n) => `dist ${n}`)
  ]
  console.log(missing.length === 0 ? `${type}: ok` : `${type}: never seen: ${missing.join(", ")}`)
}

for (const m of registry.manifests) report(m.type, m.dashboard)
for (const c of registry.connectorManifests) report(c.type, c.dashboard)
