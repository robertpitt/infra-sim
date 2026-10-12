/**
 * Generates `pricing/aws.json`, the price catalog the simulator reads (`src/simulator/Pricing.ts`), from AWS's public
 * Price List bulk files. Run it when AWS changes a price; the file's diff is the change.
 *
 *   npx tsx tools/pricing/main.ts                        every service, every region the simulator has
 *   npx tsx tools/pricing/main.ts lambda dynamodb        just these (the rest of the file is kept)
 *   npx tsx tools/pricing/main.ts --regions us-east-1,eu-west-1 lambda
 *   npx tsx tools/pricing/main.ts --check                fetch and compare, write nothing
 *   npx tsx tools/pricing/main.ts --verbose              list each dimension missing from some regions
 *   npx tsx tools/pricing/main.ts --out .tmp/x.json s3   write somewhere else (starting from what is there)
 *   npx tsx tools/pricing/main.ts --explore AmazonDynamoDB us-east-1 [text]
 *                                                        the distinct usage types of a price file, to write a mapping
 *   ... --explore AmazonRDS us-east-1 --columns "Database Engine,Deployment Option"   with those columns too
 *
 * Price files are cached in `.tmp/pricing-cache/` by version (`--no-cache` to fetch them again).
 */
import fs from "node:fs"
import path from "node:path"
import { Pricing } from "../../src/simulator/index.ts"
import { catalog as regionCatalog } from "../../src/simulator/aws/region/catalog.ts"
import { assemble } from "./assemble.ts"
import { fetchOffer, type Offer, regionsOf } from "./bulk.ts"
import { format } from "./format.ts"
import type { ServiceMap } from "./map.ts"

/** Every service the generator prices: each file in `services/` exports one map (adding a service is adding a file). */
const maps: ReadonlyArray<ServiceMap> = (
  await Promise.all(
    fs
      .readdirSync(new URL("./services/", import.meta.url))
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .sort()
      .map(async (f) => Object.values((await import(`./services/${f}`)) as Record<string, unknown>))
  )
)
  .flat()
  .filter((m): m is ServiceMap => typeof m === "object" && m !== null && "classify" in m && "offers" in m)
const DISCLAIMER =
  "Generated from the AWS Price List Bulk API: on-demand prices in USD, without taxes, Savings Plans, reserved capacity or negotiated discounts. For estimates; AWS's pricing pages and your bill are the authority."

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  const value = args[i + 1]
  args.splice(i, 2)
  return value
}
const has = (name: string) => {
  const i = args.indexOf(name)
  if (i !== -1) args.splice(i, 1)
  return i !== -1
}

/** Runs `f` over `items`, `limit` at a time. */
const pool = async <A, B>(items: ReadonlyArray<A>, limit: number, f: (a: A) => Promise<B>): Promise<Array<B>> => {
  const out: Array<B> = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await f(items[i]!)
      }
    })
  )
  return out
}

const explore = async (offer: string, region: string, text?: string) => {
  const o = await fetchOffer(offer, region)
  const seen = new Map<string, string>()
  for (const r of o.rows) {
    const extra = columns.map((c) => `${c}=${r.attributes[c] ?? ""}`).join(" ")
    const line = `${r.usage} | ${r.family} | ${r.operation} | ${r.from}-${r.to} ${r.price} ${r.unit} | ${extra === "" ? "" : `${extra} | `}${r.description}`
    if (text !== undefined && !line.toLowerCase().includes(text.toLowerCase())) continue
    seen.set(line, line)
  }
  console.log(`${offer} ${region}: version ${o.version}, published ${o.published}, ${o.rows.length} on-demand rows, ${seen.size} shown`)
  for (const line of [...seen.values()].sort()) console.log(line)
}

/** Columns `--explore` shows besides the usual: `--columns "Database Engine,Deployment Option"`. */
const columns = flag("--columns")?.split(",") ?? []
const exploring = flag("--explore")
if (exploring !== undefined) {
  await explore(exploring, args[0] ?? "us-east-1", args[1])
  process.exit(0)
}

const OUT = flag("--out") ?? "pricing/aws.json"
const cache = !has("--no-cache")
const check = has("--check")
const verbose = has("--verbose")
const onlyRegions = flag("--regions")?.split(",")
const wanted =
  args.length === 0
    ? maps
    : args.map(
        (id) =>
          maps.find((m) => m.id === id) ??
          (() => {
            throw new Error(`no pricing map for "${id}": ${maps.map((m) => m.id).join(", ")}`)
          })()
      )
const simulatorRegions = onlyRegions ?? regionCatalog.map((r) => r.id)

const before: Pricing.Catalog | undefined = fs.existsSync(OUT) ? Pricing.decode(JSON.parse(fs.readFileSync(OUT, "utf8"))) : undefined
const services: Record<string, Pricing.Service> = { ...before?.services }
let failed = false

for (const map of wanted) {
  const started = performance.now()
  const offers: Array<Offer> = []
  for (const offer of map.offers) {
    const available = new Set(await regionsOf(offer))
    const regions = (map.offerRegions?.[offer] ?? [...simulatorRegions, ...(map.extraRegions ?? [])]).filter((r) => available.has(r))
    offers.push(...(await pool(regions, 6, (r) => fetchOffer(offer, r, { cache }))))
  }
  const { service, report } = assemble(map, offers)
  // Mostly what AWS doesn't sell somewhere (an instance type, a newer region); listed with --verbose.
  if (verbose) for (const w of report.warnings) console.warn(`  ${map.id}: ${w}`)
  else if (report.warnings.length > 0)
    console.warn(`  ${map.id}: ${report.warnings.length} dimension(s) without a price in some regions (--verbose lists them)`)
  if (report.errors.length > 0) {
    failed = true
    console.error(`${map.id}: ${report.errors.length} error(s), not written`)
    for (const e of report.errors.slice(0, 30)) console.error(`  ${e}`)
    continue
  }
  // With --regions, the other regions' prices stay as they were.
  const merged: Pricing.Service =
    onlyRegions === undefined || services[map.id] === undefined
      ? service
      : {
          ...service,
          dimensions: Object.fromEntries(
            [...new Set([...Object.keys(services[map.id]!.dimensions), ...Object.keys(service.dimensions)])].sort().map((d) => {
              const old = services[map.id]!.dimensions[d]
              const now = service.dimensions[d]
              return [
                d,
                {
                  ...(now ?? old)!,
                  regions: { ...old?.regions, ...now?.regions }
                }
              ]
            })
          )
        }
  const changes = diff(services[map.id], merged)
  services[map.id] = merged
  const dims = Object.keys(merged.dimensions).length
  const regions = Pricing.regionsOf(
    {
      provider: "aws",
      currency: "USD",
      generated: "",
      disclaimer: "",
      services: { [map.id]: merged }
    },
    map.id
  ).length
  console.log(`${map.id}: ${dims} dimensions in ${regions} regions, ${changes} (${Math.round(performance.now() - started)} ms)`)
}

/** What changed in a service's prices: "3 prices changed, 1 dimension added", or "unchanged". */
function diff(old: Pricing.Service | undefined, now: Pricing.Service): string {
  if (old === undefined) return "new"
  const count = { changed: 0, regionsAdded: 0, regionsRemoved: 0, added: 0, removed: 0, details: 0 }
  for (const [d, dim] of Object.entries(now.dimensions)) {
    const was = old.dimensions[d]
    if (was === undefined) {
      count.added++
      continue
    }
    for (const [r, p] of Object.entries(dim.regions)) {
      if (was.regions[r] === undefined) count.regionsAdded++
      else if (JSON.stringify(was.regions[r]) !== JSON.stringify(p)) count.changed++
    }
    for (const r of Object.keys(was.regions)) if (dim.regions[r] === undefined) count.regionsRemoved++
    const { regions: _a, ...nowRest } = dim
    const { regions: _b, ...wasRest } = was
    if (JSON.stringify(nowRest) !== JSON.stringify(wasRest)) count.details++
  }
  for (const d of Object.keys(old.dimensions)) if (now.dimensions[d] === undefined) count.removed++
  const parts = [
    count.changed > 0 && `${count.changed} price(s) changed`,
    count.regionsAdded > 0 && `${count.regionsAdded} regional price(s) added`,
    count.regionsRemoved > 0 && `${count.regionsRemoved} regional price(s) removed`,
    count.added > 0 && `${count.added} dimension(s) added`,
    count.removed > 0 && `${count.removed} dimension(s) removed`,
    count.details > 0 && `${count.details} dimension(s) with a new unit, description or free allowance`
  ].filter(Boolean)
  return parts.length === 0 ? "unchanged" : parts.join(", ")
}

const next: Pricing.Catalog = {
  provider: "aws",
  currency: "USD",
  // Only a change moves the date, so running it again with nothing new from AWS leaves the file as it was.
  generated:
    before !== undefined &&
    JSON.stringify(before.services) === JSON.stringify(Object.fromEntries(Object.entries(services).sort(([a], [b]) => a.localeCompare(b))))
      ? before.generated
      : new Date().toISOString(),
  disclaimer: DISCLAIMER,
  services: Object.fromEntries(Object.entries(services).sort(([a], [b]) => a.localeCompare(b)))
}
// Decoding checks the file is one the simulator can read.
Pricing.decode(next)
if (check) console.log("--check: nothing written")
else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, format(next))
  console.log(`wrote ${OUT}`)
}
process.exit(failed ? 1 : 0)
