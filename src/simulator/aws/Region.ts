import { Effect, Schema } from "effect"
import * as Setting from "../Setting.ts"
import * as Aws from "./provider.ts"

const ids = Aws.provider.regions.map((r) => r.id) as [string, ...Array<string>]
const labels = Object.fromEntries(Aws.provider.regions.map((r) => [r.id, `${r.name} (${r.id})`]))

/**
 * An AWS region as a boundary on the canvas. Everything inside runs there: placing a component in the box is how you
 * choose its region, and the box's own settings are the region's account quotas, the totals everything inside shares.
 */
export const Region = Aws.component({
  type: "aws.region",
  service: "Region",
  title: "Region",
  description: "A boundary for one AWS region. Components inside run there and share its account quotas.",
  category: "network",
  icon: "region",
  accent: "#ec7211",
  docs: "https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html",
  config: Schema.Struct({
    region: Setting.choice(ids, { default: "us-east-1", label: "Region", labels })
  }),
  container: {
    // Anything on AWS, except another region.
    accepts: (child) => child.provider === "aws" && child.container?.region === undefined,
    region: (config: { region: string }) => config.region
  },
  ports: {},
  make: () => Effect.succeed({})
})
