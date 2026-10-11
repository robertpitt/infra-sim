import type { AnyComponent } from "../Component.ts"
import { ApiGateway } from "./ApiGateway.ts"
import { DynamoDb } from "./DynamoDb.ts"
import { Lambda } from "./Lambda.ts"
import { Region } from "./Region.ts"
import { S3 } from "./S3.ts"
import { Sns } from "./Sns.ts"
import { Sqs } from "./Sqs.ts"
import { Vpc } from "./Vpc.ts"

export { provider } from "./provider.ts"
export { ApiGateway, DynamoDb, Lambda, Region, S3, Sns, Sqs, Vpc }

/** Every AWS component, in palette order. */
export const components: ReadonlyArray<AnyComponent> = [Region, Vpc, ApiGateway, Lambda, Sqs, Sns, DynamoDb, S3]
