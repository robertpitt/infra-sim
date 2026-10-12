import type { Row } from "./bulk.ts"

/**
 * How one of the simulator's services reads AWS's price lists: which offers, which dimensions it prices, and which row
 * is which dimension. The only code per service, and it changes only when AWS renames a usage type, not when a price
 * changes. Each lives in `services/<id>.ts`; `lambda.ts` is the reference.
 */
export interface ServiceMap {
  /** The simulator's name for the service: its folder under `src/simulator/aws/` (`lambda`, `dynamodb`, `elb`). */
  readonly id: string
  readonly title: string
  /** AWS's offer codes to read (`AWSLambda`; NAT gateways are in `AmazonEC2`). */
  readonly offers: ReadonlyArray<string>
  /**
   * Region files to read besides the simulator's regions, for a global service whose prices AWS lists elsewhere
   * (`aws-other`). Their rows are classified like any other; `Match.region` says where to store them.
   */
  readonly extraRegions?: ReadonlyArray<string>
  /**
   * Per offer, exactly which region files to read, instead of the simulator's regions and `extraRegions`: Route 53's
   * prices are all in `aws-other`, and its regional files hold only Resolver's.
   */
  readonly offerRegions?: Readonly<Record<string, ReadonlyArray<string>>>
  /** Every dimension it prices, by id. An id ending in `/*` stands for a family: `instance/*` for `instance/m7g.large`. */
  readonly dimensions: Readonly<Record<string, DimensionSpec>>
  /**
   * Which dimension a row prices, or `undefined` to leave it out (most rows: features the simulator doesn't model).
   * Several, for a row that stands for more than one (a free allowance both architectures share).
   */
  readonly classify: (row: Row) => Match | ReadonlyArray<Match> | undefined
}

export interface DimensionSpec {
  /** What one unit is, as a meter counts it: `request`, `GB-second`, `hour`, `GB-month`, `GB`. */
  readonly unit: string
  /** What it is, for people: "Requests (invocations)", "Duration on Arm (Graviton)". */
  readonly description: string
  /** Its free allowance is shared with every dimension naming the same group (Lambda's two architectures). */
  readonly freeShared?: string
}

export interface Match {
  readonly dimension: string
  /** A free-tier row (`Global-Request`, 0 to 1,000,000 at 0): its range is the monthly allowance, not a price. */
  readonly free?: boolean
  /** Store it under this region instead of the file's: `global`, for a service priced once. */
  readonly region?: string
  /** AWS's price is per this many of our units (per million requests: 1,000,000); its ranges are counted the same way. */
  readonly per?: number
}

/** A row's attribute, or "". */
export const attr = (row: Row, name: string): string => row.attributes[name] ?? ""
