import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { account } from "../account.ts"
import { audit } from "./audit.ts"
import { Config } from "./config.ts"

const quotas = Schema.decodeUnknownSync(account("us-east-1"))({})
const member = (id: string, settings: Record<string, unknown>) => ({ id, name: id, type: "aws.opensearch", config: Schema.decodeUnknownSync(Config)(settings) })
const codes = (members: ReadonlyArray<ReturnType<typeof member>>, q: Record<string, unknown> = {}) =>
  audit("us-east-1", members, { ...quotas, ...q }).map((d) => d.code)

describe("aws.opensearch: audit", () => {
  it("is quiet about a domain sized the way AWS recommends", () => {
    expect(codes([member("d", { dataNodes: 3, primaryShards: 3, replicas: 1 })])).toEqual([])
  })

  it("warns about copies that can't be placed and about no replicas at all", () => {
    expect(codes([member("d", { dataNodes: 2, primaryShards: 2, replicas: 2 })])).toContain("opensearch-unassigned-replicas")
    expect(codes([member("d", { dataNodes: 3, primaryShards: 3, replicas: 0 })])).toContain("opensearch-no-replicas")
  })

  it("checks instances per domain against the account quota, and T3 domains against 10", () => {
    expect(codes([member("d", { dataNodes: 201, primaryShards: 201 })])).toContain("opensearch-instances")
    expect(codes([member("d", { dataNodes: 201, primaryShards: 201 })], { opensearchInstancesPerDomain: 400 })).not.toContain("opensearch-instances")
    expect(codes([member("d", { instanceType: "t3.medium.search", dataNodes: 11, primaryShards: 11 })], { opensearchInstancesPerDomain: 400 })).toContain("opensearch-instances")
  })

  it("counts domains in the region against the quota", () => {
    const three = ["a", "b", "c"].map((id) => member(id, { primaryShards: 3 }))
    expect(codes(three, { opensearchDomains: 2 })).toContain("opensearch-domains")
    expect(codes(three)).not.toContain("opensearch-domains")
  })

  it("points out data nodes that don't divide over the domain's zones", () => {
    expect(codes([member("d", { availabilityZones: 3, dataNodes: 4, primaryShards: 4, replicas: 1 })])).toContain("opensearch-uneven-zones")
    expect(codes([member("d", { availabilityZones: 3, dataNodes: 6, primaryShards: 6, replicas: 2 })])).toEqual([])
  })

  it("points out uneven shard counts and small clusters", () => {
    expect(codes([member("d", { dataNodes: 3, primaryShards: 5, replicas: 1 })])).toContain("opensearch-shard-skew")
    expect(codes([member("d", { dataNodes: 2, primaryShards: 2, replicas: 1 })])).toContain("opensearch-few-nodes")
  })
})
