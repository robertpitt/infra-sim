import { Schema } from "effect"

/**
 * Prices: what a provider charges for each thing a component uses, looked up by service, region and dimension.
 *
 * The prices are data, not code: a catalog file in the repo (`pricing/aws.json`), generated from the provider's own
 * price list (`tools/pricing/`, which reads AWS's public Price List bulk files) and stamped with the version it came
 * from. When AWS changes a price, regenerating the file is the whole change, and its diff shows exactly what moved.
 * This module only reads a catalog; where the catalog came from is the generator's business.
 *
 * A dimension is one thing billed by the unit: `requests`, `duration/arm64` (GB-seconds), `instance/m7g.large` (hours),
 * `storage` (GB-months). Its price may be tiered by how much of it the account has used that month (Lambda's duration
 * gets cheaper past 6 billion GB-seconds), and the account may get some free each month.
 */

/** One step of a tiered price: from `from` units used in the month on, each unit costs `price`. */
export const Tier = Schema.Tuple([Schema.Number, Schema.Number])
export type Tier = typeof Tier.Type

/** A dimension's price in one region: a flat price per unit, or tiers by monthly use, the first from 0. */
export const RegionPrice = Schema.Union([Schema.Number, Schema.Array(Tier)])
export type RegionPrice = typeof RegionPrice.Type

export const Dimension = Schema.Struct({
  /** What one unit is: `request`, `GB-second`, `hour`, `GB-month`, `GB`. What a meter counts to be priced by it. */
  unit: Schema.String,
  description: Schema.String,
  /** Units free each month for the account, before any price applies (Lambda's first million requests). */
  free: Schema.optionalKey(Schema.Number),
  /**
   * The allowance is one for every dimension of the service with the same name here: Lambda's free GB-seconds are for
   * both architectures together, CloudFront's free terabyte for every geography. What one uses, the others don't get, so
   * a meter adds up the group's use and passes it as `used`.
   */
  freeShared: Schema.optionalKey(Schema.String),
  /** The price by region code (`eu-west-1`), or under `global` for a service priced the same everywhere (Route 53). */
  regions: Schema.Record(Schema.String, RegionPrice)
})
export type Dimension = typeof Dimension.Type

/** Where a service's prices came from: each price list read, and the version and date the provider published it under. */
export const Source = Schema.Struct({
  /** The price list (an AWS offer code: `AWSLambda`). */
  offer: Schema.String,
  version: Schema.String,
  published: Schema.String,
  url: Schema.String
})
export type Source = typeof Source.Type

export const Service = Schema.Struct({
  title: Schema.String,
  sources: Schema.Array(Source),
  dimensions: Schema.Record(Schema.String, Dimension)
})
export type Service = typeof Service.Type

export const Catalog = Schema.Struct({
  provider: Schema.String,
  currency: Schema.String,
  /** When the file was generated. Each service's `sources` say how current its prices are. */
  generated: Schema.String,
  disclaimer: Schema.String,
  /** By the simulator's name for the service (`lambda`, `dynamodb`, `elb`), not the provider's offer code. */
  services: Schema.Record(Schema.String, Service)
})
export type Catalog = typeof Catalog.Type

export const decode = Schema.decodeUnknownSync(Catalog)

/** The region a service priced the same everywhere is listed under. */
export const GLOBAL = "global"

/** A dimension's price where something runs. */
export interface Price {
  readonly service: string
  readonly dimension: string
  /** The region the price is for, or `global`. */
  readonly region: string
  readonly unit: string
  readonly currency: string
  readonly description: string
  /** Ascending by `from`, the first from 0. */
  readonly tiers: ReadonlyArray<Tier>
  /** Free each month, for the account. */
  readonly free: number
  /** Dimensions sharing the free allowance, by this name (see `Dimension.freeShared`). */
  readonly freeShared?: string
}

/**
 * A dimension's price in a region, or `undefined` when the catalog has none: a service not offered there, a dimension
 * the catalog doesn't have, a region it hasn't been generated for. A global service's price is found from any region.
 */
export const price = (catalog: Catalog, service: string, region: string, dimension: string): Price | undefined => {
  const d = catalog.services[service]?.dimensions[dimension]
  if (d === undefined) return undefined
  const at = d.regions[region] !== undefined ? region : d.regions[GLOBAL] !== undefined ? GLOBAL : undefined
  if (at === undefined) return undefined
  const p = d.regions[at]!
  return {
    service,
    dimension,
    region: at,
    unit: d.unit,
    currency: catalog.currency,
    description: d.description,
    tiers: typeof p === "number" ? [[0, p]] : p,
    free: d.free ?? 0,
    ...(d.freeShared === undefined ? {} : { freeShared: d.freeShared })
  }
}

/** The price of the first unit: the rate before any tier discount (what most of a small design pays). */
export const rate = (p: Price): number => p.tiers[0]?.[1] ?? 0

/**
 * What `quantity` units cost in a month in which `used` units were already used: what is still free first (unless
 * `free: false`, an account past its free tier or without one), then each tier at its price.
 */
export const cost = (p: Price, quantity: number, options: { readonly used?: number; readonly free?: boolean } = {}): number => {
  let from = Math.max(0, options.used ?? 0)
  let left = Math.max(0, quantity)
  if (options.free !== false && p.free > from) {
    const freeNow = Math.min(left, p.free - from)
    from += freeNow
    left -= freeNow
  }
  let total = 0
  for (let i = 0; i < p.tiers.length && left > 0; i++) {
    const [start, unitPrice] = p.tiers[i]!
    const end = p.tiers[i + 1]?.[0] ?? Number.POSITIVE_INFINITY
    if (from >= end) continue
    const at = Math.max(from, start)
    const n = Math.min(left, end - at)
    total += n * unitPrice
    from = at + n
    left -= n
  }
  return total
}

/** The regions a service has any price for (`global` for a global one). */
export const regionsOf = (catalog: Catalog, service: string): ReadonlyArray<string> => {
  const regions = new Set<string>()
  for (const d of Object.values(catalog.services[service]?.dimensions ?? {})) for (const r of Object.keys(d.regions)) regions.add(r)
  return [...regions].sort()
}

/** The dimensions a service has prices for. */
export const dimensionsOf = (catalog: Catalog, service: string): ReadonlyArray<string> => Object.keys(catalog.services[service]?.dimensions ?? {}).sort()
