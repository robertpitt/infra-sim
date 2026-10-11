import type { Region as ProviderRegion } from "../../Provider.ts"

/** Where AWS publishes the list of Regions, their Availability Zones and their opt-in status. */
export const REGIONS_SOURCE = "https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html"

/**
 * What AWS documents about a Region, plus the coordinates the simulator uses to estimate the network distance between
 * two of them. `azs` and `optIn` are AWS's own figures (the table at `REGIONS_SOURCE`); `lat` and `lon` are the
 * approximate location of the Region's main city, not of any data centre (AWS does not publish those).
 */
export interface RegionInfo extends ProviderRegion {
  /** Availability Zones, as the AWS table lists them. Zones are not modelled; the number bounds what a VPC may ask for. */
  readonly azs: number
  /** True when the Region is disabled by default and an account has to enable it first (Regions launched after 20 March 2019). */
  readonly optIn: boolean
}

const r = (id: string, name: string, lat: number, lon: number, azs: number, optIn: boolean): RegionInfo => ({ id, name, lat, lon, azs, optIn })

/**
 * The 34 Regions of the AWS commercial partition, as the AWS Regions page lists them. Ids are stable: designs on disk
 * name them. GovCloud (US) and the China Regions are separate partitions with their own accounts and are not here.
 * `us-west-1` shows 3 because that is what the table lists; newer accounts can use only 2 of its zones (a footnote in the table).
 */
export const catalog: ReadonlyArray<RegionInfo> = [
  r("us-east-1", "N. Virginia", 38.9, -77.4, 6, false),
  r("us-east-2", "Ohio", 40.0, -83.0, 3, false),
  r("us-west-1", "N. California", 37.4, -122.0, 3, false),
  r("us-west-2", "Oregon", 45.8, -119.7, 4, false),
  r("ca-central-1", "Canada (Central)", 45.5, -73.6, 3, false),
  r("ca-west-1", "Calgary", 51.0, -114.1, 3, true),
  r("mx-central-1", "Mexico (Central)", 20.6, -100.4, 3, true),
  r("sa-east-1", "São Paulo", -23.5, -46.6, 3, false),
  r("eu-west-1", "Ireland", 53.3, -6.3, 3, false),
  r("eu-west-2", "London", 51.5, -0.1, 3, false),
  r("eu-west-3", "Paris", 48.9, 2.4, 3, false),
  r("eu-central-1", "Frankfurt", 50.1, 8.7, 3, false),
  r("eu-central-2", "Zurich", 47.4, 8.5, 3, true),
  r("eu-north-1", "Stockholm", 59.3, 18.1, 3, false),
  r("eu-south-1", "Milan", 45.5, 9.2, 3, true),
  r("eu-south-2", "Spain", 41.6, -0.9, 3, true),
  r("il-central-1", "Tel Aviv", 32.1, 34.8, 3, true),
  r("me-south-1", "Bahrain", 26.1, 50.6, 3, true),
  r("me-central-1", "UAE", 25.2, 55.3, 3, true),
  r("af-south-1", "Cape Town", -33.9, 18.4, 3, true),
  r("ap-south-1", "Mumbai", 19.1, 72.9, 3, false),
  r("ap-south-2", "Hyderabad", 17.4, 78.5, 3, true),
  r("ap-east-1", "Hong Kong", 22.3, 114.2, 3, true),
  r("ap-east-2", "Taipei", 25.0, 121.5, 3, true),
  r("ap-southeast-1", "Singapore", 1.3, 103.8, 3, false),
  r("ap-southeast-2", "Sydney", -33.9, 151.2, 3, false),
  r("ap-southeast-3", "Jakarta", -6.2, 106.8, 3, true),
  r("ap-southeast-4", "Melbourne", -37.8, 145.0, 3, true),
  r("ap-southeast-5", "Malaysia", 3.1, 101.7, 3, true),
  r("ap-southeast-6", "New Zealand", -36.8, 174.8, 3, true),
  r("ap-southeast-7", "Thailand", 13.8, 100.5, 3, true),
  r("ap-northeast-1", "Tokyo", 35.7, 139.7, 4, false),
  r("ap-northeast-2", "Seoul", 37.6, 127.0, 4, false),
  r("ap-northeast-3", "Osaka", 34.7, 135.5, 3, false)
]

/** The catalog entry for a Region id, if AWS has such a Region. */
export const infoOf = (id: string): RegionInfo | undefined => catalog.find((region) => region.id === id)

/** The Regions as the provider wants them: id, name and coordinates. */
export const regions: ReadonlyArray<ProviderRegion> = catalog.map(({ id, name, lat, lon }) => ({ id, name, lat, lon }))
