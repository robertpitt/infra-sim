import type { AnyConnector } from "../../Connector.ts"
import { connectors as elb } from "../elb/Targets.ts"
import { KinesisSource as FirehoseKinesisSource } from "../firehose/KinesisSource.ts"
import { KinesisMapping } from "../kinesis/EventSourceMapping.ts"
import { DatabaseClient as RdsClient, ProxyClient as RdsProxyClient, ProxyTarget as RdsProxyTarget } from "../rds/Client.ts"
import { Connection as Route53Connection } from "../route53/Connection.ts"
import { EventSourceMapping } from "../sqs/EventSourceMapping.ts"
import { TaskIntegration } from "../stepfunctions/TaskIntegration.ts"

/**
 * What AWS puts between its services: the things on an edge that belong to neither end. Each lives in the folder of
 * the service whose integration it is, and must not import `provider.ts` (which imports this).
 */
export const connectors: ReadonlyArray<AnyConnector> = [EventSourceMapping, KinesisMapping, FirehoseKinesisSource, Route53Connection, TaskIntegration, RdsClient, RdsProxyClient, RdsProxyTarget, ...elb]
