import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { defaultMaxConnections, instanceClassMemory } from "../catalog.ts"
import { Config } from "../config.ts"
import { derive, iopsOf } from "../database.ts"
import { quotas } from "../../Quotas.ts"

const config = (settings: Record<string, unknown>) => Schema.decodeUnknownSync(Config)(settings)

describe("aws.rds: max_connections from the default parameter groups", () => {
  it("reproduces AWS's two MySQL examples: about 60 on a db.t3.micro, about 630 on an 8 GiB class", () => {
    expect(defaultMaxConnections("mysql", "db.t3.micro")).toBe(60)
    expect(defaultMaxConnections("mysql", "db.m7g.large")).toBe(630)
  })

  it("DBInstanceClassMemory is less than the class's memory", () => {
    expect(instanceClassMemory(8)).toBeLessThan(8 * 1024 ** 3)
    expect(instanceClassMemory(8)).toBeGreaterThan(0.9 * 8 * 1024 ** 3)
  })

  it("PostgreSQL divides by 9,531,392 and stops at 5,000", () => {
    expect(defaultMaxConnections("postgres", "db.t3.micro")).toBe(Math.floor(instanceClassMemory(1) / 9_531_392))
    expect(defaultMaxConnections("postgres", "db.r7g.large")).toBe(Math.floor(instanceClassMemory(16) / 9_531_392))
    expect(defaultMaxConnections("postgres", "db.r7g.4xlarge")).toBe(5_000)
    expect(defaultMaxConnections("aurora-postgres", "db.r7g.16xlarge")).toBe(5_000)
  })

  it("MariaDB divides by 25,165,760 and stops at 12,000", () => {
    expect(defaultMaxConnections("mariadb", "db.m7g.large")).toBe(Math.floor(instanceClassMemory(8) / 25_165_760))
    expect(defaultMaxConnections("mariadb", "db.r7g.16xlarge")).toBe(12_000)
  })

  it("Aurora MySQL uses AWS's table: 90 on a db.t4g.medium, 1,000 on a db.r7g.large, 6,000 on a db.r7g.16xlarge", () => {
    expect(defaultMaxConnections("aurora-mysql", "db.t4g.medium")).toBe(90)
    expect(defaultMaxConnections("aurora-mysql", "db.r7g.large")).toBe(1_000)
    expect(defaultMaxConnections("aurora-mysql", "db.r7g.16xlarge")).toBe(6_000)
  })

  it("a max_connections setting replaces the default, clamped to the engine's range", () => {
    expect(derive(config({ engine: "mysql", maxConnections: 500 })).maxConnections).toBe(500)
    expect(derive(config({ engine: "postgres", maxConnections: 3 })).maxConnections).toBe(6)
    expect(derive(config({ engine: "aurora-mysql", maxConnections: 50_000 })).maxConnections).toBe(16_000)
  })
})

describe("aws.rds: storage IOPS", () => {
  it("gp3 has a 3,000 baseline under 400 GiB and 12,000 from it, where 12,000–64,000 can be provisioned", () => {
    expect(iopsOf(config({ storage: { type: "gp3", allocated: 100 } }))).toBe(3_000)
    expect(iopsOf(config({ storage: { type: "gp3", allocated: 100, iops: 20_000 } }))).toBe(3_000)
    expect(iopsOf(config({ storage: { type: "gp3", allocated: 400 } }))).toBe(12_000)
    expect(iopsOf(config({ storage: { type: "gp3", allocated: 400, iops: 40_000 } }))).toBe(40_000)
    expect(iopsOf(config({ storage: { type: "gp3", allocated: 1_000, iops: 200_000 } }))).toBe(64_000)
  })

  it("io1 is 1,000 at least and 50 per GiB at most; io2 1,000 per GiB", () => {
    expect(iopsOf(config({ storage: { type: "io1", allocated: 100 } }))).toBe(1_000)
    expect(iopsOf(config({ storage: { type: "io1", allocated: 100, iops: 10_000 } }))).toBe(5_000)
    expect(iopsOf(config({ storage: { type: "io1", allocated: 1_000, iops: 40_000 } }))).toBe(40_000)
    expect(iopsOf(config({ storage: { type: "io2", allocated: 100, iops: 80_000 } }))).toBe(80_000)
    expect(iopsOf(config({ storage: { type: "io2", allocated: 100, iops: 200_000 } }))).toBe(100_000)
  })

  it("Aurora's cluster volume isn't limited by IOPS", () => {
    expect(iopsOf(config({ engine: "aurora-postgres" }))).toBe(Number.POSITIVE_INFINITY)
  })
})

describe("aws.rds: deployments", () => {
  it("a Multi-AZ DB cluster's two standbys serve reads; Aurora's readers are its failover targets", () => {
    expect(derive(config({ engine: "postgres", multiAz: "cluster" })).readers).toBe(2)
    expect(derive(config({ engine: "postgres", multiAz: "instance" })).readers).toBe(0)
    expect(derive(config({ engine: "postgres", readers: 3 })).promotesReader).toBe(false)
    expect(derive(config({ engine: "aurora-mysql", readers: 3 })).promotesReader).toBe(true)
    expect(derive(config({ engine: "aurora-mysql", multiAz: "cluster" })).readers).toBe(0)
  })

  it("the DB instance quota is 40 per region, and 20 in ap-south-1", () => {
    const decode = (region: string) => Schema.decodeUnknownSync(Schema.Struct(quotas(region)))({})
    expect(decode("us-east-1").rdsInstances).toBe(40)
    expect(decode("ap-south-1").rdsInstances).toBe(20)
    expect(decode("us-east-1").rdsProxies).toBe(20)
    expect(decode("us-east-1").rdsReadReplicas).toBe(15)
  })
})
