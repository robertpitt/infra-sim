import fs from "node:fs"
const [, , profFile, mapFile, top = "35"] = process.argv
const p = JSON.parse(fs.readFileSync(profFile, "utf8"))
const map = JSON.parse(fs.readFileSync(mapFile, "utf8"))

// --- minimal sourcemap decoder (VLQ) -> per generated line sorted segments
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const dec = new Map([...B64].map((c, i) => [c, i]))
const lines = []
let src = 0, sl = 0, sc = 0, nm = 0
for (const line of map.mappings.split(";")) {
  let col = 0
  const segs = []
  for (const seg of line.split(",")) {
    if (!seg) continue
    const vals = []
    let shift = 0, val = 0
    for (const ch of seg) {
      const d = dec.get(ch)
      val += (d & 31) << shift
      if (d & 32) shift += 5
      else { vals.push(val & 1 ? -(val >> 1) : val >> 1); val = 0; shift = 0 }
    }
    col += vals[0]
    if (vals.length >= 4) { src += vals[1]; sl += vals[2]; sc += vals[3]; segs.push([col, src, sl, sc]) }
  }
  lines.push(segs)
}
const original = (line, col) => {
  const segs = lines[line]
  if (!segs || segs.length === 0) return undefined
  let lo = 0, hi = segs.length - 1, best = segs[0]
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (segs[mid][0] <= col) { best = segs[mid]; lo = mid + 1 } else hi = mid - 1 }
  return `${map.sources[best[1]].replace(/^(\.\.\/)+/, "").replace(/^.*\/(infra-sim|effect-playground)\//, "")}:${best[2] + 1}`
}

const byId = new Map(p.nodes.map((n) => [n.id, n]))
const parent = new Map()
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
const labelCache = new Map()
const label = (n) => { let l = labelCache.get(n.id); if (l === undefined) { l = rawLabel(n); labelCache.set(n.id, l) } return l }
const rawLabel = (n) => {
  const cf = n.callFrame
  if (cf.url.endsWith("bundle.mjs")) return original(cf.lineNumber, cf.columnNumber) ?? `bundle:${cf.lineNumber}`
  return `${cf.functionName || "(anon)"} ${cf.url.replace(/^.*node_modules\//, "")}:${cf.lineNumber + 1}`
}
const ours = (n) => { const l = label(n); const m = /(src\/simulator\/[^:]+:\d+)/.exec(l); return m ? m[1] : undefined }
const ownerCache = new Map()
const ownerOf = (id) => {
  if (ownerCache.has(id)) return ownerCache.get(id)
  const path = []
  let cur = id, owner
  while (cur !== undefined) {
    if (ownerCache.has(cur)) { owner = ownerCache.get(cur); break }
    path.push(cur)
    const o = ours(byId.get(cur))
    if (o) { owner = o; break }
    cur = parent.get(cur)
  }
  for (const p of path) ownerCache.set(p, owner)
  return owner
}
const self = new Map()
for (let i = 0; i < p.samples.length; i++) self.set(p.samples[i], (self.get(p.samples[i]) ?? 0) + (p.timeDeltas[i] ?? 0))
const total = [...self.values()].reduce((a, b) => a + b, 0)

// 1. self time by leaf
const leaf = new Map(), onBehalf = new Map()
for (const [id, t] of self) {
  const n = byId.get(id)
  const l = label(n)
  leaf.set(l, (leaf.get(l) ?? 0) + t)
  // attribute to nearest ancestor (or self) in our code
  const owner = ownerOf(id)
  const key = owner ?? "(no src/ frame: " + (l.includes("src/simulator") ? l : n.callFrame.functionName || "root") + ")"
  onBehalf.set(key, (onBehalf.get(key) ?? 0) + t)
}
const show = (title, m, k) => {
  console.log(`\n${title}  (total ${(total / 1000).toFixed(0)} ms)`)
  for (const [key, t] of [...m].sort((a, b) => b[1] - a[1]).slice(0, k)) console.log((t / 1000).toFixed(0).padStart(7), ((100 * t) / total).toFixed(1).padStart(5) + "%", key)
}
show("SELF time by function", leaf, Number(top))
show("Time on behalf of OUR code (self + effect internals beneath it, by nearest src frame)", onBehalf, Number(top))

// --- callers of selected functions (env CALLERS="Hash.ts:108,Equal.ts:208")
if (process.env.CALLERS) {
  for (const needle of process.env.CALLERS.split(",")) {
    const agg = new Map()
    for (const [id, t] of self) {
      const n = byId.get(id)
      if (!label(n).includes(needle)) continue
      // walk up to the first frame that is neither the needle nor in effect/Hash/Equal internals
      let cur = parent.get(id), chain = []
      while (cur !== undefined && chain.length < 6) { chain.push(label(byId.get(cur)).replace(/^.*node_modules\//, "").replace(/^.*effect-playground\//, "")); cur = parent.get(cur) }
      const key = chain.join("  <-  ")
      agg.set(key, (agg.get(key) ?? 0) + t)
    }
    console.log(`\nCALLERS of ${needle}`)
    for (const [k, t] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log((t / 1000).toFixed(0).padStart(6), k)
  }
}
