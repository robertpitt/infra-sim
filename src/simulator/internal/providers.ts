import { type Provider, type Region, INTERNET, zoneNames } from "../Provider.ts"
import { Schema } from "effect"

/**
 * A place outside any cloud has three zones, `eu-west-a` to `eu-west-c`: an assumption, so that a fleet run in your own
 * data centres (a Kubernetes cluster, a team's VMs) can spread over failure domains and lose one, as a cloud region's
 * can. Three is what most cloud regions have.
 */
const ZONES_PER_PLACE = 3

const place = (r: Omit<Region, "zones">): Region => ({ ...r, zones: zoneNames(r.id, ZONES_PER_PLACE, "-") })

/** Places outside any cloud: where end users and third-party services are. */
const internetRegions: ReadonlyArray<Region> = ([
  { id: "us-east", name: "US East", lat: 40.7, lon: -74.0 },
  { id: "us-west", name: "US West", lat: 37.8, lon: -122.4 },
  { id: "south-america", name: "South America", lat: -23.5, lon: -46.6 },
  { id: "eu-west", name: "Western Europe", lat: 51.5, lon: -0.1 },
  { id: "eu-central", name: "Central Europe", lat: 50.1, lon: 8.7 },
  { id: "africa", name: "Africa", lat: -26.2, lon: 28.0 },
  { id: "middle-east", name: "Middle East", lat: 25.2, lon: 55.3 },
  { id: "india", name: "India", lat: 19.1, lon: 72.9 },
  { id: "asia-southeast", name: "South-east Asia", lat: 1.3, lon: 103.8 },
  { id: "asia-northeast", name: "North-east Asia", lat: 35.7, lon: 139.7 },
  { id: "oceania", name: "Oceania", lat: -33.9, lon: 151.2 }
] as const).map(place)

export const internet: Provider = {
  id: INTERNET,
  title: "Internet",
  regions: internetRegions,
  defaultRegion: "us-east",
  account: () => Schema.Struct({})
}

/** Every provider the simulator knows. Cloud providers register themselves by adding to this list. */
export const known = (providers: ReadonlyArray<Provider>): ReadonlyMap<string, Provider> =>
  new Map([internet, ...providers].map((p) => [p.id, p]))
