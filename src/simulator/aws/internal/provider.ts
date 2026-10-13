import type { Provider } from "../../Provider.ts"
import { account } from "./account.ts"
import { audit as apigateway } from "../apigateway/Audit.ts"
import { audit as cloudfront } from "../cloudfront/Audit.ts"
import { connectors } from "./connectors.ts"
import { audit as dynamodb } from "../dynamodb/Audit.ts"
import { audit as ec2 } from "../ec2/Audit.ts"
import { audit as ecs } from "../ecs/Audit.ts"
import { audit as eks } from "../eks/Audit.ts"
import { audit as elb } from "../elb/Audit.ts"
import { audit as elasticache } from "../elasticache/Audit.ts"
import { audit as eventbridge } from "../eventbridge/Audit.ts"
import { audit as firehose } from "../firehose/Audit.ts"
import { audit as kinesis } from "../kinesis/Audit.ts"
import { audit as lambda } from "../lambda/Audit.ts"
import { audit as opensearch } from "../opensearch/Audit.ts"
import { audit as rds } from "../rds/Audit.ts"
import { regions } from "./regions.ts"
import { audit as route53 } from "../route53/Audit.ts"
import { audit as s3 } from "../s3/Audit.ts"
import { audit as scheduler } from "../scheduler/Audit.ts"
import { audit as ses } from "../ses/Audit.ts"
import type { Audit } from "./service.ts"
import { audit as sns } from "../sns/Audit.ts"
import { audit as sqs } from "../sqs/Audit.ts"
import { audit as stepfunctions } from "../stepfunctions/Audit.ts"
import { audit as vpc } from "../vpc/Audit.ts"
import { audit as waf } from "../waf/Audit.ts"

/**
 * Amazon Web Services.
 *
 * Numbers here are AWS's published ones; each service's README lists every value with its source and says whether it is
 * a hard limit (enforced, not editable), an adjustable quota (an editable setting that defaults to AWS's number) or an
 * assumption. See `README.md` in this folder for how a service is laid out.
 */

const audits: ReadonlyArray<Audit> = [lambda, apigateway, sns, sqs, kinesis, firehose, dynamodb, elasticache, opensearch, rds, s3, cloudfront, ses, eventbridge, scheduler, stepfunctions, vpc, waf, route53, ec2, elb, ecs, eks]

export const provider: Provider = {
  id: "aws",
  title: "Amazon Web Services",
  regions,
  defaultRegion: "us-east-1",
  account,
  audit: (region, members, quotas) => audits.flatMap((check) => check(region, members, quotas)),
  connectors
}

// What components import, so they have one place to get the AWS building blocks from.
export { component, type Node } from "./component.ts"
export type { Account } from "./account.ts"
export { docs } from "./docs.ts"
