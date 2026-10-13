import { Effect } from "effect"
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000 }
import * as Builder from "../src/simulator/Builder.ts"
import { sim } from "../src/simulator/testing.ts"

const RPS = Number(process.env.RPS ?? 4000)
const VIRTUAL = Number(process.env.VIRTUAL ?? 10_000)
const REPS = Number(process.env.REPS ?? 3)

type Make = (b: Builder.Builder, client: Builder.NodeRef) => void
const sink = (b: Builder.Builder) => b.add("common.http-endpoint", { id: "sink", settings: { latency: { mean: 5, cv: 0.3 } } })
const cases: Record<string, Make> = {
  "http-endpoint": (b, c) => b.connect(c, sink(b)),
  "lambda (sync)": (b, c) => {
    const fn = b.add("aws.lambda", { id: "fn", settings: { memory: 1769, duration: { mean: 10, cv: 0.3 }, fanOut: "none" } })
    b.connect(c, fn)
  },
  "lambda -> endpoint": (b, c) => {
    const fn = b.add("aws.lambda", { id: "fn", settings: { memory: 1769, duration: { mean: 10, cv: 0.3 } } })
    b.connect(c, fn); b.connect(fn, sink(b))
  },
  "apigateway -> endpoint": (b, c) => {
    const gw = b.add("aws.apigateway", { id: "gw", settings: { apiType: "http" } })
    b.connect(c, gw); b.connect(gw, sink(b))
  },
  "dynamodb (on-demand)": (b, c) => b.connect(c, b.add("aws.dynamodb", { id: "t", settings: { mode: "on-demand" } })),
  "dynamodb (provisioned)": (b, c) => b.connect(c, b.add("aws.dynamodb", { id: "t", settings: { readCapacity: 40000, writeCapacity: 40000 } })),
  "s3": (b, c) => b.connect(c, b.add("aws.s3", { id: "bucket", settings: { prefixes: 50 } })),
  "sns -> 3 endpoints": (b, c) => {
    const t = b.add("aws.sns", { id: "topic" })
    b.connect(c, t)
    for (let i = 0; i < 3; i++) b.connect(t, b.add("common.http-endpoint", { id: `sub${i}`, settings: { latency: { mean: 5, cv: 0 } } }))
  },
  "sqs -> lambda": (b, c) => {
    const q = b.add("aws.sqs", { id: "q" })
    const fn = b.add("aws.lambda", { id: "fn", settings: { memory: 1769, duration: { mean: 10, cv: 0.3 }, fanOut: "none" } })
    b.connect(c, q); b.connect(q.port("deliver"), fn)
  }
}

const only = process.argv[2]
for (const [name, make] of Object.entries(cases)) {
  if (only && !name.includes(only)) continue
  const b = Builder.make(name, { seed: 3 })
  const c = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: RPS } })
  make(b, c)
  const doc = b.build()
  let r: any
  for (let rep = 0; rep < REPS; rep++) {
  const x = await sim(doc, (s) => Effect.gen(function*() {
    const t0 = cpu()
    const all = yield* s.advanceTo(VIRTUAL)
    const wall = cpu() - t0
    let ok = 0
    for (const f of all) ok += (f.nodes.web?.rates.ok ?? 0) * 0.25
    let calls = 0
    for (const f of all) for (const n of Object.values(f.nodes)) calls += (n.rates.in ?? 0) * 0.25
    return { wall, ok, calls }
  }))
  if (r === undefined || x.wall < r.wall) r = x
  }
  console.log(name.padEnd(26), `${(r.wall / (RPS * VIRTUAL / 1000)).toFixed(2).padStart(6)} cpu-ms/1000 client reqs`.padEnd(30), `${((r.wall * 1000) / Math.max(1, r.calls)).toFixed(1).padStart(6)} us/node-call`, ` ok ${Math.round(r.ok)}/${RPS * VIRTUAL / 1000}`)
}
process.exit(0)
