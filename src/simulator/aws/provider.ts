import { Schema, type SubscriptionRef } from "effect"
import * as Component from "../Component.ts"
import type { Diagnostic } from "../Diagnostic.ts"
import type { Provider, Region } from "../Provider.ts"
import * as Setting from "../Setting.ts"

/**
 * Amazon Web Services.
 *
 * Numbers here are AWS's published ones (see docs/AWS-LIMITS.md for each value, its source and whether it is a hard
 * limit or an adjustable quota). Adjustable quotas are settings you can change; hard limits are enforced and shown but not editable.
 */

export const docs = {
  lambda: "https://docs.aws.amazon.com/lambda/latest/dg/",
  sqs: "https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/",
  sns: "https://docs.aws.amazon.com/sns/latest/dg/",
  snsQuotas: "https://docs.aws.amazon.com/general/latest/gr/sns.html",
  dynamodb: "https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/",
  apigateway: "https://docs.aws.amazon.com/apigateway/latest/developerguide/"
} as const

const regions: ReadonlyArray<Region> = [
  { id: "us-east-1", name: "N. Virginia", lat: 38.9, lon: -77.4 },
  { id: "us-east-2", name: "Ohio", lat: 40.0, lon: -83.0 },
  { id: "us-west-1", name: "N. California", lat: 37.4, lon: -122.0 },
  { id: "us-west-2", name: "Oregon", lat: 45.8, lon: -119.7 },
  { id: "ca-central-1", name: "Canada (Central)", lat: 45.5, lon: -73.6 },
  { id: "ca-west-1", name: "Calgary", lat: 51.0, lon: -114.1 },
  { id: "mx-central-1", name: "Mexico (Central)", lat: 20.6, lon: -100.4 },
  { id: "sa-east-1", name: "São Paulo", lat: -23.5, lon: -46.6 },
  { id: "eu-west-1", name: "Ireland", lat: 53.3, lon: -6.3 },
  { id: "eu-west-2", name: "London", lat: 51.5, lon: -0.1 },
  { id: "eu-west-3", name: "Paris", lat: 48.9, lon: 2.4 },
  { id: "eu-central-1", name: "Frankfurt", lat: 50.1, lon: 8.7 },
  { id: "eu-central-2", name: "Zurich", lat: 47.4, lon: 8.5 },
  { id: "eu-north-1", name: "Stockholm", lat: 59.3, lon: 18.1 },
  { id: "eu-south-1", name: "Milan", lat: 45.5, lon: 9.2 },
  { id: "eu-south-2", name: "Spain", lat: 41.6, lon: -0.9 },
  { id: "il-central-1", name: "Tel Aviv", lat: 32.1, lon: 34.8 },
  { id: "me-south-1", name: "Bahrain", lat: 26.1, lon: 50.6 },
  { id: "me-central-1", name: "UAE", lat: 25.2, lon: 55.3 },
  { id: "af-south-1", name: "Cape Town", lat: -33.9, lon: 18.4 },
  { id: "ap-south-1", name: "Mumbai", lat: 19.1, lon: 72.9 },
  { id: "ap-south-2", name: "Hyderabad", lat: 17.4, lon: 78.5 },
  { id: "ap-east-1", name: "Hong Kong", lat: 22.3, lon: 114.2 },
  { id: "ap-southeast-1", name: "Singapore", lat: 1.3, lon: 103.8 },
  { id: "ap-southeast-2", name: "Sydney", lat: -33.9, lon: 151.2 },
  { id: "ap-southeast-3", name: "Jakarta", lat: -6.2, lon: 106.8 },
  { id: "ap-southeast-4", name: "Melbourne", lat: -37.8, lon: 145.0 },
  { id: "ap-southeast-5", name: "Malaysia", lat: 3.1, lon: 101.7 },
  { id: "ap-southeast-7", name: "Thailand", lat: 13.8, lon: 100.5 },
  { id: "ap-northeast-1", name: "Tokyo", lat: 35.7, lon: 139.7 },
  { id: "ap-northeast-2", name: "Seoul", lat: 37.6, lon: 127.0 },
  { id: "ap-northeast-3", name: "Osaka", lat: 34.7, lon: 135.5 }
]

// --- Regional defaults, from the published tables ---------------------------------------------------------

/** Regions where API Gateway's account throttle is 2,500 rps with a 1,250 burst instead of 10,000 / 5,000. */
const apiGatewayReduced = new Set([
  "af-south-1", "eu-south-1", "ap-southeast-3", "me-central-1", "ap-south-2", "ap-southeast-4", "eu-south-2",
  "eu-central-2", "il-central-1", "ca-west-1", "ap-southeast-5", "ap-southeast-7", "mx-central-1"
])
export const apiGatewayRate = (region: string): number => (apiGatewayReduced.has(region) ? 2_500 : 10_000)
/** The token-bucket size: AWS says customers cannot change it. */
export const apiGatewayBurst = (region: string): number => (apiGatewayReduced.has(region) ? 1_250 : 5_000)

const snsMid = new Set(["us-east-2", "us-west-1", "ap-south-1", "ap-northeast-2", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "eu-central-1"])
const snsStandardRate = (region: string): number =>
  region === "us-east-1" ? 30_000 : region === "us-west-2" || region === "eu-west-1" ? 9_000 : snsMid.has(region) ? 1_500 : 300
const snsFifoRate = (region: string): number =>
  region === "us-east-1" ? 30_000 : region === "us-west-2" || region === "eu-west-1" ? 9_000 : 3_000

/** SQS FIFO high-throughput mode, non-batched requests per second per queue. Batched is ten times this. */
export const sqsFifoHighThroughputTps = (region: string): number =>
  ["us-east-1", "us-west-2", "eu-west-1"].includes(region)
    ? 70_000
    : ["us-east-2", "eu-central-1"].includes(region)
    ? 19_000
    : ["ap-south-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "eu-south-2"].includes(region)
    ? 9_000
    : ["eu-west-2", "sa-east-1"].includes(region)
    ? 4_500
    : 2_400

/** The account-level quotas for one region. */
export const account = (region: string) =>
  Schema.Struct({
    lambdaConcurrency: Setting.int({
      default: 1_000,
      min: 10,
      max: 1_000_000,
      unit: "executions",
      label: "Lambda concurrent executions",
      help: "Shared by every function in this region. At least 100 always stays unreserved.",
      limit: Setting.quota(`${docs.lambda}gettingstarted-limits.html`, "AWS can raise this to tens of thousands on request.")
    }),
    apiGatewayRate: Setting.int({
      default: apiGatewayRate(region),
      min: 1,
      max: 10_000_000,
      unit: "req/s",
      label: "API Gateway request rate",
      help: `Steady-state rate shared by every API in this region. The burst (${apiGatewayBurst(region).toLocaleString("en-US")}) is fixed by AWS.`,
      limit: Setting.quota(`${docs.apigateway}limits.html`)
    }),
    snsPublishRate: Setting.int({
      default: snsStandardRate(region),
      min: 1,
      max: 10_000_000,
      unit: "msg/s",
      label: "SNS publish rate (standard)",
      help: "Messages published per second across every standard topic in this region.",
      limit: Setting.quota(docs.snsQuotas)
    }),
    snsFifoPublishRate: Setting.int({
      default: snsFifoRate(region),
      min: 1,
      max: 10_000_000,
      unit: "msg/s",
      label: "SNS publish rate (FIFO)",
      limit: Setting.quota(docs.snsQuotas)
    }),
    sqsFifoHighThroughput: Setting.int({
      default: sqsFifoHighThroughputTps(region),
      min: 300,
      max: 10_000_000,
      unit: "req/s",
      label: "SQS FIFO high-throughput limit",
      help: "Per queue, non-batched requests per second when high-throughput mode is on. Batched is ten times this.",
      limit: Setting.quota(`${docs.sqs}quotas-messages.html`)
    }),
    dynamodbTableReadUnits: Setting.int({
      default: 40_000,
      min: 1,
      max: 10_000_000,
      unit: "units/s",
      label: "DynamoDB per-table read units",
      limit: Setting.quota(`${docs.dynamodb}ServiceQuotas.html`)
    }),
    dynamodbTableWriteUnits: Setting.int({
      default: 40_000,
      min: 1,
      max: 10_000_000,
      unit: "units/s",
      label: "DynamoDB per-table write units",
      limit: Setting.quota(`${docs.dynamodb}ServiceQuotas.html`)
    }),
    dynamodbAccountReadUnits: Setting.int({
      default: 80_000,
      min: 1,
      max: 100_000_000,
      unit: "units/s",
      label: "DynamoDB account read units",
      help: "Provisioned read capacity summed across all tables in this region.",
      limit: Setting.quota(`${docs.dynamodb}ServiceQuotas.html`)
    }),
    dynamodbAccountWriteUnits: Setting.int({
      default: 80_000,
      min: 1,
      max: 100_000_000,
      unit: "units/s",
      label: "DynamoDB account write units",
      limit: Setting.quota(`${docs.dynamodb}ServiceQuotas.html`)
    })
  })

export type Account = (typeof account extends (region: string) => infer S ? S : never)["Type"]

type LambdaSettings = { reserved: { enabled: boolean; concurrency: number }; provisioned: number }
type TableSettings = { mode: string; readCapacity: number; writeCapacity: number }

/** What a design asks of one AWS account in one region, against the account's quotas. */
const audit: NonNullable<Provider["audit"]> = (region, members, quotas) => {
  const account = quotas as Account
  const out: Array<Diagnostic> = []
  const lambdas = members.filter((m) => m.type === "aws.lambda")
  const held = lambdas.reduce((sum, m) => {
    const c = m.config as LambdaSettings
    return sum + (c.reserved.enabled ? c.reserved.concurrency : c.provisioned)
  }, 0)
  const reservable = Math.max(0, account.lambdaConcurrency - 100)
  if (held > reservable) {
    out.push({
      level: "warning",
      code: "lambda-reservations",
      message: `Lambda in ${region} reserves or provisions ${held.toLocaleString("en-US")} concurrent executions, but only ${reservable.toLocaleString("en-US")} can be held back (AWS keeps 100 of the ${account.lambdaConcurrency.toLocaleString("en-US")} unreserved).`
    })
  }
  const tables = members.filter((m) => m.type === "aws.dynamodb" && (m.config as TableSettings).mode === "provisioned")
  for (const [dir, key, quota] of [["read", "readCapacity", account.dynamodbAccountReadUnits], ["write", "writeCapacity", account.dynamodbAccountWriteUnits]] as const) {
    const total = tables.reduce((sum, m) => sum + Math.min((m.config as TableSettings)[key], dir === "read" ? account.dynamodbTableReadUnits : account.dynamodbTableWriteUnits), 0)
    if (total > quota) {
      out.push({
        level: "warning",
        code: `dynamodb-account-${dir}`,
        message: `DynamoDB tables in ${region} provision ${total.toLocaleString("en-US")} ${dir} units a second; the account allows ${quota.toLocaleString("en-US")}. Later tables get what is left.`
      })
    }
  }
  return out
}

export const provider: Provider = {
  id: "aws",
  title: "Amazon Web Services",
  regions,
  defaultRegion: "us-east-1",
  account,
  audit
}

/** An AWS component's node: the generic one, with the account quotas typed. */
export type Node<C extends Schema.Top, P extends Component.PortDefs> =
  & Omit<Component.Node<C["Type"], P>, "account">
  & { readonly account: SubscriptionRef.SubscriptionRef<Account> }

/** Define an AWS component. Same as `Component.make`, with `provider` fixed and the node's account quotas typed. */
export const component = <
  const C extends Schema.Top,
  const P extends Component.PortDefs = { readonly out: Component.PortDef<undefined> },
  const S extends Schema.Top = Schema.Struct<{}>
>(
  input: Omit<Component.Input<C, P, S>, "provider" | "make"> & { readonly make: (node: Node<C, P>) => ReturnType<Component.ComponentDef<C, P, S>["make"]> }
): Component.ComponentDef<C, P, S> =>
  Component.make<C, P, S>({ ...input, provider: "aws", make: (node) => input.make(node as unknown as Node<C, P>) } as Component.Input<C, P, S>)
