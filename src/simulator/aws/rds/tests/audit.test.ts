import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import type { Account } from "../../internal/account.ts"
import { audit } from "../Audit.ts"
import { Config } from "../internal/config.ts"
import { ProxyConfig } from "../internal/proxyConfig.ts"
import { quotas } from "../Quotas.ts"

const account = (region = "us-east-1", overrides: Record<string, unknown> = {}): Account =>
  Schema.decodeUnknownSync(Schema.Struct(quotas(region)))(overrides) as unknown as Account
const database = (id: string, settings: Record<string, unknown> = {}) => ({ id, name: id, type: "aws.rds", config: Schema.decodeUnknownSync(Config)(settings) })
const proxy = (id: string, settings: Record<string, unknown> = {}) => ({ id, name: id, type: "aws.rds-proxy", config: Schema.decodeUnknownSync(ProxyConfig)(settings) })
const codes = (region: string, members: ReadonlyArray<ReturnType<typeof database> | ReturnType<typeof proxy>>, quota = account(region)) =>
  audit(region, members, quota).map((d) => d.code)

describe("aws.rds: audit", () => {
  it("counts DB instances against the regional quota: writers, readers and a Multi-AZ DB cluster's standbys", () => {
    const members = Array.from({ length: 10 }, (_, i) => database(`db${i}`, { readers: 3 }))
    expect(codes("us-east-1", members)).not.toContain("rds-instances")
    expect(codes("us-east-1", [...members, database("big", { readers: 1 })])).toContain("rds-instances")
    // ap-south-1 allows 20.
    expect(codes("ap-south-1", members.slice(0, 5))).not.toContain("rds-instances")
    expect(codes("ap-south-1", members.slice(0, 6))).toContain("rds-instances")
  })

  it("flags Aurora clusters, proxies and storage over their quotas", () => {
    const aurora = Array.from({ length: 3 }, (_, i) => database(`a${i}`, { engine: "aurora-mysql" }))
    expect(codes("us-east-1", aurora, account("us-east-1", { rdsClusters: 2 }))).toContain("rds-clusters")
    const proxies = Array.from({ length: 21 }, (_, i) => proxy(`p${i}`))
    expect(codes("us-east-1", proxies)).toContain("rds-proxies")
    expect(codes("us-east-1", [database("db", { storage: { allocated: 60_000 }, readers: 1 })])).toContain("rds-storage")
  })

  it("flags a class the engine doesn't run on", () => {
    expect(codes("us-east-1", [database("db", { engine: "aurora-mysql", instanceClass: "db.m7g.large" })])).toContain("rds-class-engine")
    expect(codes("us-east-1", [database("db", { engine: "aurora-mysql", instanceClass: "db.r7g.large" })])).not.toContain("rds-class-engine")
    expect(codes("us-east-1", [database("db", { engine: "mysql", multiAz: "cluster", instanceClass: "db.r7g.large" })])).toContain("rds-class-multi-az-cluster")
    expect(codes("us-east-1", [database("db", { engine: "mysql", multiAz: "cluster", instanceClass: "db.r6gd.large" })])).not.toContain("rds-class-multi-az-cluster")
  })

  it("explains settings that are ignored or clamped", () => {
    expect(codes("us-east-1", [database("db", { engine: "aurora-postgres", multiAz: "instance" })])).toContain("rds-aurora-multi-az")
    expect(codes("us-east-1", [database("db", { engine: "mysql", maxConnections: 200_000 })])).toContain("rds-max-connections")
    expect(codes("us-east-1", [database("db", { storage: { type: "io1", allocated: 50 } })])).toContain("rds-storage-size")
    expect(codes("us-east-1", [database("db", { storage: { type: "io1", allocated: 100, iops: 10_000 } })])).toContain("rds-iops")
    expect(codes("us-east-1", [database("db", { storage: { type: "gp3", allocated: 100, iops: 10_000 } })])).toContain("rds-gp3-iops")
    expect(codes("us-east-1", [database("db", { readers: 10 })], account("us-east-1", { rdsReadReplicas: 5 }))).toContain("rds-read-replicas")
    expect(codes("us-east-1", [proxy("p", { maxConnectionsPercent: 40, maxIdleConnectionsPercent: 60 })])).toContain("rds-proxy-idle")
    expect(codes("us-east-1", [proxy("p", { maxConnectionsPercent: 10 })])).toContain("rds-proxy-max-connections")
  })

  it("is quiet for a plain design", () => {
    expect(codes("us-east-1", [database("db"), proxy("p")])).toEqual([])
  })
})
