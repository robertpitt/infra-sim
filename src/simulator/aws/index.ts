import type { AnyComponent } from "../Component.ts"
import { ApiGateway } from "./apigateway/index.ts"
import { CloudFront } from "./cloudfront/index.ts"
import { DynamoDb } from "./dynamodb/index.ts"
import { Lambda } from "./lambda/index.ts"
import { Region } from "./region/index.ts"
import { S3 } from "./s3/index.ts"
import { Ses } from "./ses/index.ts"
import { Sns } from "./sns/index.ts"
import { Sqs } from "./sqs/index.ts"
import { NatGateway, Vpc, VpcEndpoint } from "./vpc/index.ts"

export { provider } from "./provider.ts"
export { ApiGateway, CloudFront, DynamoDb, Lambda, NatGateway, Region, S3, Ses, Sns, Sqs, Vpc, VpcEndpoint }

/** Every AWS component, in palette order. */
export const components: ReadonlyArray<AnyComponent> = [Region, Vpc, NatGateway, VpcEndpoint, ApiGateway, CloudFront, Lambda, Sqs, Sns, DynamoDb, S3, Ses]
