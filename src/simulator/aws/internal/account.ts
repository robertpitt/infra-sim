import { Schema } from "effect"
import { quotas as apigateway } from "../apigateway/Quotas.ts"
import { quotas as cloudfront } from "../cloudfront/Quotas.ts"
import { quotas as dynamodb } from "../dynamodb/Quotas.ts"
import { quotas as ec2 } from "../ec2/Quotas.ts"
import { quotas as ecs } from "../ecs/Quotas.ts"
import { quotas as elb } from "../elb/Quotas.ts"
import { quotas as elasticache } from "../elasticache/Quotas.ts"
import { quotas as eventbridge } from "../eventbridge/Quotas.ts"
import { quotas as firehose } from "../firehose/Quotas.ts"
import { quotas as kinesis } from "../kinesis/Quotas.ts"
import { quotas as lambda } from "../lambda/Quotas.ts"
import { quotas as opensearch } from "../opensearch/Quotas.ts"
import { quotas as rds } from "../rds/Quotas.ts"
import { quotas as route53 } from "../route53/Quotas.ts"
import { quotas as s3 } from "../s3/Quotas.ts"
import { quotas as scheduler } from "../scheduler/Quotas.ts"
import { quotas as ses } from "../ses/Quotas.ts"
import { quotas as sns } from "../sns/Quotas.ts"
import { quotas as sqs } from "../sqs/Quotas.ts"
import { quotas as stepfunctions } from "../stepfunctions/Quotas.ts"
import { quotas as vpc } from "../vpc/Quotas.ts"
import { quotas as waf } from "../waf/Quotas.ts"

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
