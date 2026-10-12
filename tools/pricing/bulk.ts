/**
 * AWS's Price List Bulk API: public files of every price, per service (an "offer") and region, no credentials needed.
 * https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-the-aws-price-list-bulk-api.html
 *
 * Reads the CSV form, streamed line by line: EC2's file for us-east-1 alone is about 300 MB. Only on-demand prices are
 * kept (no reserved or savings-plan terms). Files are cached under `.tmp/pricing-cache/<offer>/<version>/` (on-demand
 * rows only), so working on a service's mapping doesn't fetch them again; a new version from AWS is a new cache entry.
 */
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { Readable } from "node:stream"

const HOST = "https://pricing.us-east-1.amazonaws.com"
const CACHE = ".tmp/pricing-cache"

/** One on-demand price row, as the mappings see it. */
export interface Row {
  readonly offer: string
  /** The region file it came from: `eu-west-1`, or `aws-other` and the like for a global service. */
  readonly region: string
  readonly sku: string
  /** The usage type without its region prefix: `Request-ARM`, `BoxUsage:m7g.large`, `TimedStorage-ByteHrs`. */
  readonly usage: string
  /** The usage type as AWS writes it: `EUW2-Request-ARM`. */
  readonly usageType: string
  readonly operation: string
  readonly family: string
  /** AWS's unit: `Requests`, `Lambda-GB-Second`, `Hrs`, `GB-Mo`. */
  readonly unit: string
  readonly price: number
  /** The tier this price applies over, in units used that month: 0 to Infinity when untiered. */
  readonly from: number
  readonly to: number
  readonly description: string
  /** Every column, by AWS's header (`instanceType`, `Group`, `volumeApiName`...). */
  readonly attributes: Readonly<Record<string, string>>
}

/** A region's (or the global) price file of an offer: its rows, the version, and when AWS published it. */
export interface Offer {
  readonly offer: string
  readonly region: string
  readonly version: string
  readonly published: string
  readonly url: string
  /** The region's usage-type prefix (`EUW2`), stripped from each row's `usage`. */
  readonly prefix: string | undefined
  readonly rows: ReadonlyArray<Row>
}

interface RegionIndex {
  readonly regions: Record<string, { readonly regionCode: string; readonly currentVersionUrl: string }>
}

const regionIndexes = new Map<string, Promise<RegionIndex>>()

const getJson = async <T>(url: string): Promise<T> => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`)
  return (await res.json()) as T
}

/** The regions an offer has a price file for. */
export const regionsOf = async (offer: string): Promise<ReadonlyArray<string>> => {
  let index = regionIndexes.get(offer)
  if (index === undefined) regionIndexes.set(offer, (index = getJson<RegionIndex>(`${HOST}/offers/v1.0/aws/${offer}/current/region_index.json`)))
  return Object.keys((await index).regions)
}

/** One CSV line's fields: quoted, with `""` for a quote inside a field. */
const fields = (line: string): Array<string> => {
  const out: Array<string> = []
  let i = 0
  while (i <= line.length) {
    if (line[i] === '"') {
      let s = ""
      i++
      while (i < line.length) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            s += '"'
            i += 2
            continue
          }
          i++
          break
        }
        s += line[i++]
      }
      out.push(s)
      i++ // the comma
    } else {
      const end = line.indexOf(",", i)
      out.push(line.slice(i, end === -1 ? line.length : end))
      i = end === -1 ? line.length + 1 : end + 1
    }
  }
  return out
}

/**
 * A region file's usage-type prefix: `EUW2` in `EUW2-Request-ARM`. Read from the data (the leading all-capitals token
 * most usage types share), not from a table, so a new region needs nothing; us-east-1's files mostly have none.
 */
const prefixOf = (usageTypes: ReadonlyArray<string>): string | undefined => {
  const counts = new Map<string, number>()
  for (const u of usageTypes) {
    const m = /^([A-Z][A-Z0-9]*[0-9]|[A-Z]{2,4})-/.exec(u)
    if (m) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1)
  }
  let best: [string, number] | undefined
  for (const e of counts) if (best === undefined || e[1] > best[1]) best = e
  return best !== undefined && best[1] > usageTypes.length / 2 ? best[0] : undefined
}

/**
 * The offer a region's usage-type prefix is learnt from. A region's prefix is the same in every price list, but read
 * from a file by majority it can be wrong: S3's region-pair transfer rows outvote it, and us-east-1 prefixes only some
 * usage types (`USE1-`). Lambda's files are small, exist in every region, and prefix nearly every row.
 */
const REFERENCE = "AWSLambda"
const prefixes = new Map<string, Promise<string | undefined>>()

const referencePrefix = (region: string, usageTypes: ReadonlyArray<string>): string | undefined =>
  // Lambda's us-east-1 file has no prefix at all; other price lists use `USE1-` there for some usage types.
  region === "us-east-1" ? "USE1" : prefixOf(usageTypes)

/** A region's usage-type prefix, from Lambda's file for it; for a region Lambda has no file for, the file's own majority. */
const regionPrefix = (region: string, fallback: () => string | undefined): Promise<string | undefined> => {
  let p = prefixes.get(region)
  if (p === undefined) {
    p = regionsOf(REFERENCE).then((regions) => (regions.includes(region) ? fetchOffer(REFERENCE, region).then((o) => o.prefix) : fallback()))
    prefixes.set(region, p)
  }
  return p
}

/** Reads a price file's lines: the five header lines, then the column names, then a row per line. */
const readCsv = async (lines: AsyncIterable<string>, onRow: (cells: Array<string>, header: Array<string>) => void) => {
  const meta: Record<string, string> = {}
  let header: Array<string> | undefined
  let n = 0
  for await (const line of lines) {
    if (line === "") continue
    const cells = fields(line)
    if (header === undefined) {
      if (n++ < 5 && cells.length === 2) meta[cells[0]!] = cells[1]!
      else header = cells
      continue
    }
    onRow(cells, header)
  }
  return { meta, header: header ?? [] }
}

const linesOf = (stream: NodeJS.ReadableStream | Readable): AsyncIterable<string> => readline.createInterface({ input: stream, crlfDelay: Infinity })

/**
 * An offer's prices in one of its regions (a key of its region index: `eu-west-1`, or `aws-other` for what a global
 * service lists there): fetched, or read from the cache when this version was read before.
 */
export const fetchOffer = async (offer: string, region: string, options: { readonly cache?: boolean } = {}): Promise<Offer> => {
  let index = regionIndexes.get(offer)
  if (index === undefined) regionIndexes.set(offer, (index = getJson<RegionIndex>(`${HOST}/offers/v1.0/aws/${offer}/current/region_index.json`)))
  const entry = (await index).regions[region]
  if (entry === undefined) throw new Error(`${offer} has no price file for ${region}`)
  const relative = entry.currentVersionUrl
  const url = `${HOST}${relative.replace(/\.json$/, ".csv")}`
  // The version is in the URL (`/offers/v1.0/aws/AWSLambda/20261009223122/us-east-1/index.json`), except for "current".
  const version = /\/(\d{14})\//.exec(relative)?.[1]
  const cached = version === undefined ? undefined : path.join(CACHE, offer, version, `${region}.csv`)

  const kept: Array<string> = []
  let meta: Record<string, string>
  let header: Array<string>
  if (cached !== undefined && options.cache !== false && fs.existsSync(cached)) {
    ;({ meta, header } = await readCsv(linesOf(fs.createReadStream(cached)), (cells) => void kept.push(JSON.stringify(cells))))
  } else {
    const res = await fetch(url)
    if (!res.ok || res.body === null) throw new Error(`${url}: ${res.status} ${res.statusText}`)
    const termType = { i: -1 }
    ;({ meta, header } = await readCsv(linesOf(Readable.fromWeb(res.body as never)), (cells, h) => {
      if (termType.i === -1) termType.i = h.indexOf("TermType")
      if (cells[termType.i] === "OnDemand") kept.push(JSON.stringify(cells))
    }))
    if (cached !== undefined && options.cache !== false) {
      fs.mkdirSync(path.dirname(cached), { recursive: true })
      const out = [
        ...Object.entries(meta).map(([k, v]) => JSON.stringify([k, v]).slice(1, -1)),
        header.map((h) => JSON.stringify(h)).join(","),
        ...kept.map((k) =>
          JSON.parse(k)
            .map((c: string) => JSON.stringify(c))
            .join(",")
        )
      ]
      fs.writeFileSync(cached, out.join("\n") + "\n")
    }
  }

  const col = (name: string) => header.indexOf(name)
  const at = {
    sku: col("SKU"),
    term: col("TermType"),
    desc: col("PriceDescription"),
    from: col("StartingRange"),
    to: col("EndingRange"),
    unit: col("Unit"),
    price: col("PricePerUnit"),
    family: col("Product Family"),
    usage: col("usageType"),
    operation: col("operation")
  }
  const parsed = kept.map((k) => JSON.parse(k) as Array<string>)
  // Two candidates: the region's prefix as Lambda writes it, and this file's own majority. Price lists don't always agree
  // (Firehose writes `EUW1-` where Lambda writes `EU-` for eu-west-1), and neither alone is always right.
  const own = prefixOf(parsed.map((c) => c[at.usage] ?? ""))
  const reference =
    offer === REFERENCE
      ? referencePrefix(
          region,
          parsed.map((c) => c[at.usage] ?? "")
        )
      : await regionPrefix(region, () => own)
  const prefixes = [reference, own].filter((p): p is string => p !== undefined)
  const prefix = reference ?? own
  const strip = (usageType: string): string => {
    for (const p of prefixes) if (usageType.startsWith(`${p}-`)) return usageType.slice(p.length + 1)
    return usageType
  }
  const rows = parsed
    .filter((c) => c[at.term] === "OnDemand")
    .map((c): Row => {
      const usageType = c[at.usage] ?? ""
      const to = c[at.to] ?? ""
      return {
        offer,
        region,
        sku: c[at.sku] ?? "",
        usage: strip(usageType),
        usageType,
        operation: c[at.operation] ?? "",
        family: c[at.family] ?? "",
        unit: c[at.unit] ?? "",
        price: Number(c[at.price]),
        from: Number(c[at.from] || 0),
        to: to === "" || to === "Inf" ? Number.POSITIVE_INFINITY : Number(to),
        description: c[at.desc] ?? "",
        attributes: Object.fromEntries(header.map((h, i) => [h, c[i] ?? ""]))
      }
    })
  return {
    offer,
    region,
    version: meta["Version"] ?? version ?? "",
    published: meta["Publication Date"] ?? "",
    url,
    prefix,
    rows
  }
}
