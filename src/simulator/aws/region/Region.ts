import { Effect, Schema } from "effect"
import * as Setting from "../../Setting.ts"
import * as Aws from "../internal/provider.ts"
import { REGIONS_SOURCE } from "./Catalog.ts"

const ids = Aws.provider.regions.map((r) => r.id) as [string, ...Array<string>]
const labels = Object.fromEntries(Aws.provider.regions.map((r) => [r.id, `${r.name} (${r.id})`]))

/**
 * An AWS region as a boundary on the canvas. Everything inside runs there: placing a component in the box is how you
 * choose its region, and the box's own settings are the region's account quotas, the totals everything inside shares.
 * The box has no behaviour of its own: the region decides three things for what is inside, and each is applied by the
 * engine, not here. Distance sets the default latency of edges between regions (`Provider.oneWayLatencyMs`), the
 * placement keys the account quotas, and a regional fault takes every node inside down.
 */
export const Region = Aws.component({
  type: "aws.region",
  service: "Region",
  title: "Region",
  description: "A boundary for one AWS region. Components inside run there and share its account quotas.",
  category: "network",
  icon: "region",
  accent: "#ec7211",
  docs: REGIONS_SOURCE,
  limits: [
    { label: "Regions", value: "34 in the commercial partition", adjustable: false, source: REGIONS_SOURCE, note: "GovCloud (US) and the China Regions are separate partitions with their own accounts and are not simulated." },
    { label: "Availability Zones", value: "3 in most Regions; 6 in us-east-1, 4 in us-west-2, ap-northeast-1 and ap-northeast-2", adjustable: false, source: REGIONS_SOURCE, note: "Newer accounts can use 2 of the 3 zones in us-west-1. Zones are not modelled." },
    { label: "Opt-in Regions", value: "17 are disabled by default", adjustable: false, source: REGIONS_SOURCE, note: "Those launched after 20 March 2019 must be enabled in the account. A design that uses one gets an info note." }
  ],
  config: Schema.Struct({
    region: Setting.choice(ids, { default: "us-east-1", label: "Region", labels })
  }),
  container: {
    // Anything on AWS that can sit straight in a region: not another region, and not a component that only lives in a
    // container of its own (a NAT gateway belongs in a VPC).
    accepts: (child) => child.provider === "aws" && child.container?.region === undefined && (child.within === undefined || child.within.includes("aws.region")),
    region: (config: { region: string }) => config.region
  },
  ports: {},
  make: () => Effect.succeed({})
})
