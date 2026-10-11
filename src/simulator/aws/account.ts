import { Schema } from "effect"
import { quotas as apigateway } from "./apigateway/quotas.ts"
import { quotas as cloudfront } from "./cloudfront/quotas.ts"
import { quotas as dynamodb } from "./dynamodb/quotas.ts"
import { quotas as lambda } from "./lambda/quotas.ts"
import { quotas as s3 } from "./s3/quotas.ts"
import { quotas as ses } from "./ses/quotas.ts"
import { quotas as sns } from "./sns/quotas.ts"
import { quotas as sqs } from "./sqs/quotas.ts"
import { quotas as vpc } from "./vpc/quotas.ts"

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
    ...dynamodb(region),
    ...s3(region),
    ...cloudfront(region),
    ...ses(region),
    ...vpc(region)
  })

export type Account = (typeof account extends (region: string) => infer S ? S : never)["Type"]
