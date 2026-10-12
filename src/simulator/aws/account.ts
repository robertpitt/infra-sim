import { Schema } from "effect"
import { quotas as apigateway } from "./apigateway/quotas.ts"
import { quotas as cloudfront } from "./cloudfront/quotas.ts"
import { quotas as dynamodb } from "./dynamodb/quotas.ts"
import { quotas as ec2 } from "./ec2/quotas.ts"
import { quotas as ecs } from "./ecs/quotas.ts"
import { quotas as elb } from "./elb/quotas.ts"
import { quotas as elasticache } from "./elasticache/quotas.ts"
import { quotas as eventbridge } from "./eventbridge/quotas.ts"
import { quotas as firehose } from "./firehose/quotas.ts"
import { quotas as kinesis } from "./kinesis/quotas.ts"
import { quotas as lambda } from "./lambda/quotas.ts"
import { quotas as opensearch } from "./opensearch/quotas.ts"
import { quotas as rds } from "./rds/quotas.ts"
import { quotas as route53 } from "./route53/quotas.ts"
import { quotas as s3 } from "./s3/quotas.ts"
import { quotas as scheduler } from "./scheduler/quotas.ts"
import { quotas as ses } from "./ses/quotas.ts"
import { quotas as sns } from "./sns/quotas.ts"
import { quotas as sqs } from "./sqs/quotas.ts"
import { quotas as stepfunctions } from "./stepfunctions/quotas.ts"
import { quotas as vpc } from "./vpc/quotas.ts"
import { quotas as waf } from "./waf/quotas.ts"

/**
 * The account-level quotas for one region: every service's slice, merged. Each service owns its own fields (in its
 * folder's `quotas.ts`); this only puts them in one form, so the UI can show one "Account quotas" panel per region and
 * `Design.accounts` can store overrides for all of them together.
 */
export const account = (region: string) =>
  Schema.Struct({
    ...lambda(region),
    ...apigateway(region),
    ...sns(region),
    ...sqs(region),
    ...kinesis(region),
    ...firehose(region),
    ...dynamodb(region),
    ...opensearch(region),
    ...elasticache(region),
    ...rds(region),
    ...s3(region),
    ...route53(region),
    ...cloudfront(region),
    ...ses(region),
    ...eventbridge(region),
    ...scheduler(region),
    ...stepfunctions(region),
    ...vpc(region),
    ...waf(region),
    ...ec2(region),
    ...elb(region),
    ...ecs(region)
  })

export type Account = (typeof account extends (region: string) => infer S ? S : never)["Type"]
