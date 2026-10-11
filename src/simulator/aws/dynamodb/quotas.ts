import * as Setting from "../../Setting.ts"
import { docs } from "../docs.ts"

/**
 * The account-level quotas this service contributes: limits that belong to an AWS account in a region rather than to
 * one resource, and that every resource of the service in that region shares. Each is an editable setting whose default
 * is AWS's published number for that region. They are merged into the provider's account form (`../account.ts`).
 *
 * The four throughput fields are read by other code (keep their names). AWS publishes the same defaults in every
 * region (ServiceQuotas, "Quotas in Amazon DynamoDB": "Each quota applies on a per-Region basis"), so `region` doesn't
 * change them.
 */
export const quotas = (_region: string) => ({
  dynamodbTableReadUnits: Setting.int({
    default: 40_000,
    min: 1,
    max: 10_000_000,
    unit: "units/s",
    label: "DynamoDB per-table read units",
    help: "The most read units a table, or any one of its indexes, can have provisioned, or use on-demand.",
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
    help: "Provisioned read capacity summed across all tables and indexes in this region. On-demand tables don't count.",
    limit: Setting.quota(`${docs.dynamodb}ServiceQuotas.html`)
  }),
  dynamodbAccountWriteUnits: Setting.int({
    default: 80_000,
    min: 1,
    max: 100_000_000,
    unit: "units/s",
    label: "DynamoDB account write units",
    limit: Setting.quota(`${docs.dynamodb}ServiceQuotas.html`)
  }),
  dynamodbTables: Setting.int({
    default: 2_500,
    min: 1,
    max: 10_000,
    label: "DynamoDB tables per region",
    help: "AWS raises this to 10,000 through your account team; beyond that it recommends more accounts.",
    limit: Setting.quota(`${docs.dynamodb}ServiceQuotas.html`)
  }),
  dynamodbIndexesPerTable: Setting.int({
    default: 20,
    min: 1,
    max: 100,
    label: "DynamoDB global secondary indexes per table",
    limit: Setting.quota(`${docs.dynamodb}ServiceQuotas.html`)
  })
})
