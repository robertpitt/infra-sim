import type { Diagnostic } from "../../Diagnostic.ts"
import type { Account } from "../account.ts"
import type { Audit } from "../service.ts"
import type { Config } from "./config.ts"

const fmt = (n: number): string => n.toLocaleString("en-US")

/** What a table asks of one direction of the account: itself and each index, every one clamped to the per-table quota. */
const provisioned = (c: Config, dir: "read" | "write", account: Account): number => {
  const tableQuota = dir === "read" ? account.dynamodbTableReadUnits : account.dynamodbTableWriteUnits
  const table = dir === "read" ? c.readCapacity : c.writeCapacity
  const own = dir === "read" ? c.gsi.readCapacity : c.gsi.writeCapacity
  const indexes = Math.min(c.gsi.count, account.dynamodbIndexesPerTable)
  return Math.min(table, tableQuota) + indexes * Math.min(own > 0 ? own : table, tableQuota)
}

/**
 * Checks of the tables in a region against the account's quotas:
 *  - provisioned throughput summed over tables and their indexes, against the account totals (AWS counts indexes in it);
 *  - how many tables the region may hold;
 *  - indexes asked for beyond the per-table quota;
 *  - a provisioned index with less write capacity than its table, which AWS warns pushes back on the table's writes.
 */
export const audit: Audit = (region, members, quotas) => {
  const account = quotas as Account
  const out: Array<Diagnostic> = []
  const tables = members.filter((m) => m.type === "aws.dynamodb")

  if (tables.length > account.dynamodbTables) {
    out.push({
      level: "warning",
      code: "dynamodb-tables",
      message: `${fmt(tables.length)} DynamoDB tables in ${region}; the account allows ${fmt(account.dynamodbTables)} per region.`
    })
  }

  const provisionedTables = tables.filter((m) => (m.config as Config).mode === "provisioned")
  for (const dir of ["read", "write"] as const) {
    const quota = dir === "read" ? account.dynamodbAccountReadUnits : account.dynamodbAccountWriteUnits
    const total = provisionedTables.reduce((sum, m) => sum + provisioned(m.config as Config, dir, account), 0)
    if (total > quota) {
      out.push({
        level: "warning",
        code: `dynamodb-account-${dir}`,
        message: `DynamoDB tables and indexes in ${region} provision ${fmt(total)} ${dir} units a second; the account allows ${fmt(quota)}. Later tables get what is left.`
      })
    }
  }

  for (const m of tables) {
    const c = m.config as Config
    if (c.gsi.count > account.dynamodbIndexesPerTable) {
      out.push({
        level: "warning",
        code: "dynamodb-indexes",
        node: m.id,
        message: `${m.name} has ${c.gsi.count} global secondary indexes; the account allows ${account.dynamodbIndexesPerTable} per table, so the rest are ignored.`
      })
    }
    if (c.mode === "provisioned" && c.gsi.count > 0 && c.gsi.writeCapacity > 0 && c.gsi.writeCapacity < c.writeCapacity) {
      out.push({
        level: "warning",
        code: "dynamodb-index-underprovisioned",
        node: m.id,
        message: `${m.name}: each index has ${fmt(c.gsi.writeCapacity)} write units but the table has ${fmt(c.writeCapacity)}. Every table write also writes to the indexes, so a busy table will be throttled by them. AWS advises indexes at least as wide as the table.`
      })
    }
  }
  return out
}
