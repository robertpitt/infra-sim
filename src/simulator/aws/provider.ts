import type { Provider } from "../Provider.ts"
import { account } from "./account.ts"
import { audit as apigateway } from "./apigateway/audit.ts"
import { audit as cloudfront } from "./cloudfront/audit.ts"
import { audit as dynamodb } from "./dynamodb/audit.ts"
import { audit as lambda } from "./lambda/audit.ts"
import { regions } from "./regions.ts"
import { audit as s3 } from "./s3/audit.ts"
import { audit as ses } from "./ses/audit.ts"
import type { Audit } from "./service.ts"
import { audit as sns } from "./sns/audit.ts"
import { audit as sqs } from "./sqs/audit.ts"
import { audit as vpc } from "./vpc/audit.ts"

/**
 * Amazon Web Services.
 *
 * Numbers here are AWS's published ones; each service's README lists every value with its source and says whether it is
 * a hard limit (enforced, not editable), an adjustable quota (an editable setting that defaults to AWS's number) or an
 * assumption. See `README.md` in this folder for how a service is laid out.
 */

const audits: ReadonlyArray<Audit> = [lambda, apigateway, sns, sqs, dynamodb, s3, cloudfront, ses, vpc]

export const provider: Provider = {
  id: "aws",
  title: "Amazon Web Services",
  regions,
  defaultRegion: "us-east-1",
  account,
  audit: (region, members, quotas) => audits.flatMap((check) => check(region, members, quotas))
}

// What components import, so they have one place to get the AWS building blocks from.
export { component, type Node } from "./component.ts"
export type { Account } from "./account.ts"
export { docs } from "./docs.ts"
