import type { Pricing } from "../../src/simulator/index.ts"
import type { Offer, Row } from "./bulk.ts"
import type { DimensionSpec, ServiceMap } from "./map.ts"

/** What went wrong or is worth knowing, per service: errors stop the file being written. */
export interface Report {
  readonly errors: Array<string>
  readonly warnings: Array<string>
}

const specOf = (map: ServiceMap, dimension: string): DimensionSpec | undefined =>
  map.dimensions[dimension] ?? Object.entries(map.dimensions).find(([k]) => k.endsWith("/*") && dimension.startsWith(k.slice(0, -1)))?.[1]

const show = (r: Row) => `${r.usageType} ${r.from}-${r.to} ${r.price} ${r.unit} (${r.sku})`

/**
 * A service's prices from the offers' rows: each dimension's tiers per region, and its free allowance. Strict, so a
 * mapping mistake is loud: a row classified as a dimension the map doesn't declare, two rows that price the same units
 * differently, tiers with a gap, units that don't agree.
 */
export const assemble = (map: ServiceMap, offers: ReadonlyArray<Offer>): { readonly service: Pricing.Service; readonly report: Report } => {
  const report: Report = { errors: [], warnings: [] }
  /** dimension → region → rows */
  const priced = new Map<string, Map<string, Array<{ row: Row; per: number }>>>()
  const free = new Map<string, { amount: number; row: Row }>()

  for (const offer of offers) {
    for (const row of offer.rows) {
      const classified = map.classify(row)
      for (const match of classified === undefined ? [] : "dimension" in classified ? [classified] : classified) {
        if (specOf(map, match.dimension) === undefined) {
          report.errors.push(`${match.dimension}: not a dimension ${map.id} declares (${show(row)})`)
          continue
        }
        const per = match.per ?? 1
        if (match.free) {
          const amount = row.to * per
          const seen = free.get(match.dimension)
          if (seen !== undefined && seen.amount !== amount)
            report.errors.push(`${match.dimension}: free allowances disagree: ${show(seen.row)} and ${show(row)}`)
          free.set(match.dimension, { amount, row })
          continue
        }
        const region = match.region ?? row.region
        let byRegion = priced.get(match.dimension)
        if (byRegion === undefined) priced.set(match.dimension, (byRegion = new Map()))
        let rows = byRegion.get(region)
        if (rows === undefined) byRegion.set(region, (rows = []))
        rows.push({ row, per })
      }
    }
  }

  const dimensions: Record<string, Pricing.Dimension> = {}
  for (const [dimension, byRegion] of [...priced].sort(([a], [b]) => a.localeCompare(b))) {
    const spec = specOf(map, dimension)!
    const regions: Record<string, Pricing.RegionPrice> = {}
    for (const [region, rows] of [...byRegion].sort(([a], [b]) => a.localeCompare(b))) {
      // AWS writes some units two ways in one file ("Request" for x86, "Requests" for Arm).
      const units = new Set(rows.map((r) => r.row.unit.toLowerCase().replace(/s$/, "")))
      if (units.size > 1)
        report.errors.push(`${dimension} in ${region}: rows in different units (${[...units].join(", ")}): ${rows.map((r) => show(r.row)).join("; ")}`)
      // One tier per starting point; the same price listed twice (a global service in several files) is one.
      const tiers = new Map<number, { price: number; to: number; row: Row }>()
      for (const { row, per } of rows) {
        const from = row.from * per
        const tier = { price: row.price / per, to: row.to * per, row }
        const seen = tiers.get(from)
        if (seen === undefined) tiers.set(from, tier)
        else if (seen.price !== tier.price || seen.to !== tier.to)
          report.errors.push(`${dimension} in ${region}: two prices from ${from}: ${show(seen.row)} and ${show(row)}`)
      }
      const sorted = [...tiers].sort(([a], [b]) => a - b)
      // A free tier listed as the usage type's first range (DynamoDB's 25 free units, 0 to 18,600 unit-hours) is the
      // allowance; the paid tiers then start where it ends, and are counted from 0 like any other.
      const allowance = free.get(dimension)?.amount
      if (allowance !== undefined && sorted[0]?.[0] === allowance) sorted[0] = [0, sorted[0][1]]
      if (sorted[0]?.[0] !== 0) report.errors.push(`${dimension} in ${region}: the first tier starts at ${sorted[0]?.[0]}, not 0`)
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i - 1]![1].to !== sorted[i]![0])
          report.errors.push(`${dimension} in ${region}: tiers don't meet: ${show(sorted[i - 1]![1].row)} then ${show(sorted[i]![1].row)}`)
      }
      regions[region] = sorted.length === 1 ? sorted[0]![1].price : sorted.map(([from, t]) => [from, t.price] as const)
    }
    const allowance = free.get(dimension)
    dimensions[dimension] = {
      unit: spec.unit,
      description: spec.description,
      ...(allowance === undefined ? {} : { free: allowance.amount }),
      ...(allowance === undefined || spec.freeShared === undefined ? {} : { freeShared: spec.freeShared }),
      regions
    }
  }

  for (const dimension of free.keys()) if (!priced.has(dimension)) report.errors.push(`${dimension}: a free allowance but no price`)
  for (const id of Object.keys(map.dimensions)) {
    if (id.endsWith("/*")) {
      if (![...priced.keys()].some((d) => d.startsWith(id.slice(0, -1)))) report.errors.push(`${id}: declared, but no row priced any of it`)
    } else if (!priced.has(id)) report.errors.push(`${id}: declared, but no row priced it`)
  }

  // A dimension missing where the rest of the service is priced: often AWS doesn't sell it there (an instance type, SES
  // in a newer region), but a usage type the mapping didn't recognise in one region looks just the same, so say so.
  const serviceRegions = new Set(Object.values(dimensions).flatMap((d) => Object.keys(d.regions)))
  for (const [id, d] of Object.entries(dimensions)) {
    const missing = [...serviceRegions].filter((r) => d.regions[r] === undefined && r !== "global" && d.regions["global"] === undefined)
    if (missing.length > 0) report.warnings.push(`${id}: no price in ${missing.length} region(s) where the service has others: ${missing.sort().join(", ")}`)
  }

  const versions = new Map<string, Offer>()
  for (const o of offers) {
    const seen = versions.get(o.offer)
    if (seen === undefined || o.published > seen.published) versions.set(o.offer, o)
  }
  const sources = [...versions.values()].map((o) => ({
    offer: o.offer,
    version: o.version,
    published: o.published,
    url: `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/${o.offer}/current/region_index.json`
  }))
  return { service: { title: map.title, sources, dimensions }, report }
}
