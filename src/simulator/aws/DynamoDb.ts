import { Effect, Schema } from "effect"
import * as Distribution from "../Distribution.ts"
import * as Flow from "../Flow.ts"
import type { Bucket } from "../Limiter.ts"
import { type Call, type CallFailure, Rejected, Throttled } from "../Message.ts"
import * as Setting from "../Setting.ts"
import * as Aws from "./provider.ts"

const D = Aws.docs.dynamodb
const ITEM_MAX_BYTES = 400 * 1024
/** One partition serves at most 3,000 read units and 1,000 write units a second, however much the table has. */
const PARTITION = { read: 3_000, write: 1_000 } as const
/** A new on-demand table sustains 12,000 reads and 4,000 writes a second, and absorbs double its previous peak. */
const ON_DEMAND_BASELINE = { read: 12_000, write: 4_000 } as const
const PEAK_WINDOW_MS = 30 * 60 * 1000

interface Region {
  /** Provisioned capacity claimed by each table, to keep the total under the account quota. */
  readonly claims: Map<string, { read: number; write: number }>
  /** Changes whenever a claim does, so each table knows when its share needs working out again. */
  version: number
}

export const DynamoDb = Aws.component({
  type: "aws.dynamodb",
  service: "DynamoDB",
  title: "DynamoDB table",
  description:
    "Key-value store with provisioned or on-demand throughput. Capacity units by item size, a hard per-partition limit (hot keys), banked burst capacity, and throttling.",
  docs: `${D}ServiceQuotas.html`,
  category: "storage",
  icon: "table",
  accent: "#2e73b8",
  limits: [
    { label: "Per-partition throughput", value: "3,000 read units and 1,000 write units per second", adjustable: false, source: `${D}bp-partition-key-design.html` },
    { label: "Item size", value: "400 KB", adjustable: false, source: `${D}Constraints.html` },
    { label: "Batch operations", value: "100 items per BatchGetItem, 25 per BatchWriteItem", adjustable: false, source: `${D}Constraints.html` },
    { label: "New on-demand table", value: "12,000 reads and 4,000 writes per second, then up to 2x the previous peak", adjustable: false, source: `${D}on-demand-capacity-mode.html`, note: "Throttling can occur beyond double the previous peak within 30 minutes." },
    { label: "Per-table and per-account throughput", value: "set in the account quotas", adjustable: true, source: `${D}ServiceQuotas.html` },
    { label: "Partition count and split timing", value: "Not published by AWS; modelled from capacity unless you set it", adjustable: false, source: `${D}bp-partition-key-design.html` }
  ],
  highlights: [
    { rate: "fail.Throttled", label: "throttled/s" },
    { gauge: "readTokens", label: "read burst" },
    { gauge: "writeTokens", label: "write burst" }
  ],
  config: Schema.Struct({
    mode: Setting.choice(["provisioned", "on-demand"], { default: "provisioned", labels: { provisioned: "Provisioned", "on-demand": "On-demand" } }),
    readCapacity: Setting.int({ default: 100, min: 1, max: 10_000_000, unit: "RCU", label: "Provisioned read capacity", help: "Provisioned mode. Capped by the per-table and per-account quotas.", limit: Setting.quota(`${D}ServiceQuotas.html`) }),
    writeCapacity: Setting.int({ default: 100, min: 1, max: 10_000_000, unit: "WCU", label: "Provisioned write capacity", limit: Setting.quota(`${D}ServiceQuotas.html`) }),
    partitions: Setting.int({
      default: 0,
      min: 0,
      max: 10_000,
      label: "Partitions",
      help: "0 derives it from capacity. AWS doesn't publish how many partitions a table has or when it splits, so this is a modelling choice."
    }),
    readConsistency: Setting.choice(["eventual", "strong", "transactional"], { default: "eventual", help: "Eventually consistent reads cost half a unit per 4 KB, strongly consistent one, transactional two." }),
    writeMode: Setting.choice(["standard", "transactional"], { default: "standard", help: "Transactional writes cost twice as much." }),
    burstSeconds: Setting.int({
      default: 300,
      min: 0,
      max: 300,
      unit: "s",
      label: "Burst capacity",
      help: "Seconds of unused capacity banked for bursts. AWS retains up to 300 s and says this may change; how it refills is not published.",
      limit: Setting.hard(`${D}burst-adaptive-capacity.html`)
    }),
    latency: Setting.latency({ mean: "5 millis", cv: 0.5, label: "Request latency", help: "AWS says 'single-digit milliseconds' and publishes no percentiles; an assumption." })
  }),
  state: Schema.Struct({
    mode: Schema.String,
    /** Throughput the table can serve right now, in units per second. */
    readCapacity: Schema.Number,
    writeCapacity: Schema.Number,
    partitions: Schema.Number,
    readTokens: Schema.Number,
    writeTokens: Schema.Number,
    served: Schema.Struct({ reads: Schema.Number, writes: Schema.Number }),
    throttled: Schema.Struct({ reads: Schema.Number, writes: Schema.Number, partition: Schema.Number }),
    /** Highest per-second consumption in the last 30 minutes. On-demand capacity follows this. */
    peak: Schema.Struct({ reads: Schema.Number, writes: Schema.Number })
  }),
  make: (node) =>
    Effect.gen(function*() {
      const { fast } = node
      const region = yield* node.shared<Region>("dynamodb", Effect.sync(() => ({ claims: new Map(), version: 0 })))
      // Register now so tables are served in creation order.
      const initial = fast.settings()
      if (initial.mode === "provisioned") claim(region, node.id, initial.readCapacity, initial.writeCapacity)
      const served = { reads: 0, writes: 0 }
      const throttled = { reads: 0, writes: 0, partition: 0 }
      const readKey = `${node.id}/table/read`
      const writeKey = `${node.id}/table/write`
      const partitionKey = (index: number, op: "read" | "write") => `${node.id}/p${index}/${op}`

      // On-demand scaling: capacity follows the highest per-second consumption of the last 30 minutes.
      const window: Array<{ t: number; reads: number; writes: number }> = []
      const consumed = { reads: 0, writes: 0 }
      const peak = { reads: 0, writes: 0 }
      const sample = (): void => {
        window.push({ t: fast.now(), reads: consumed.reads, writes: consumed.writes })
        consumed.reads = 0
        consumed.writes = 0
        while (window.length > 0 && fast.now() - window[0]!.t > PEAK_WINDOW_MS) window.shift()
        peak.reads = Math.max(0, ...window.map((w) => w.reads))
        peak.writes = Math.max(0, ...window.map((w) => w.writes))
        fast.after(1_000, sample, undefined)
      }
      fast.after(1_000, sample, undefined)

      /**
       * What the table can do right now, for both directions. Worked out once per change of settings, account quotas or
       * the set of tables, not once per request: with dozens of tables sharing an account this is the hot path.
       */
      interface Capacity {
        readonly read: number
        readonly write: number
        readonly partitions: number
        readonly readBucket: Bucket
        readonly writeBucket: Bucket
      }
      let memo: { c: Config; account: Account; version: number; peakReads: number; peakWrites: number; value: Capacity } | undefined
      const capacity = (): Capacity => {
        const c = fast.settings()
        const account = fast.account() as Account
        if (memo !== undefined && memo.c === c && memo.account === account && memo.version === region.version && memo.peakReads === peak.reads && memo.peakWrites === peak.writes) return memo.value
        const share = (op: "read" | "write"): number => {
          const tableQuota = op === "read" ? account.dynamodbTableReadUnits : account.dynamodbTableWriteUnits
          if (c.mode === "on-demand") {
            if (region.claims.delete(node.id)) region.version++
            const previous = op === "read" ? peak.reads : peak.writes
            return Math.min(tableQuota, Math.max(ON_DEMAND_BASELINE[op], 2 * previous))
          }
          claim(region, node.id, c.readCapacity, c.writeCapacity)
          // Tables are served in creation order: each gets what the account quota has left after the tables before it.
          let before = 0
          for (const [id, held] of region.claims) {
            if (id === node.id) break
            before += Math.min(held[op], tableQuota)
          }
          const accountQuota = op === "read" ? account.dynamodbAccountReadUnits : account.dynamodbAccountWriteUnits
          return Math.max(1, Math.min(op === "read" ? c.readCapacity : c.writeCapacity, tableQuota, accountQuota - before))
        }
        const read = share("read")
        const write = share("write")
        // Provisioned tables bank unused capacity for bursts. On-demand tables only smooth sub-second jitter: they scale to double their previous peak instead.
        const burst = (rate: number) => (c.mode === "on-demand" ? rate / 10 : rate * Math.max(1, c.burstSeconds))
        const value: Capacity = {
          read,
          write,
          partitions: c.partitions > 0 ? c.partitions : Math.max(1, Math.ceil(Math.max(read / PARTITION.read, write / PARTITION.write))),
          readBucket: { rate: read, burst: burst(read) },
          writeBucket: { rate: write, burst: burst(write) }
        }
        // Claiming may have changed the shared version, so remember the one we ended on.
        memo = { c, account, version: region.version, peakReads: peak.reads, peakWrites: peak.writes, value }
        return value
      }

      yield* node.meter.gauge("readTokens", Effect.sync(() => node.limiter.levelUnsafe(readKey, capacity().readBucket)))
      yield* node.meter.gauge("writeTokens", Effect.sync(() => node.limiter.levelUnsafe(writeKey, capacity().writeBucket)))

      const reject = (failure: CallFailure): Call => Effect.fail(failure)

      return {
        call: (message) => {
          const c = fast.settings()
          const op = message.operation
          const itemBytes = message.bytes / message.count
          if (itemBytes > ITEM_MAX_BYTES) return reject(Rejected({ node: node.id, reason: "item size has exceeded the maximum allowed size of 400 KB" }))
          // Capacity units: reads round up to 4 KB, writes to 1 KB; consistency and transactions multiply the cost.
          const perItem =
            op === "read"
              ? Math.ceil(itemBytes / 4096) * (c.readConsistency === "strong" ? 1 : c.readConsistency === "transactional" ? 2 : 0.5)
              : Math.ceil(itemBytes / 1024) * (c.writeMode === "transactional" ? 2 : 1)
          const units = perItem * message.count

          const cap = capacity()
          const index = Math.min(cap.partitions - 1, Math.floor(message.key * cap.partitions))
          const limit = PARTITION_BUCKET[op]
          // The partition's own ceiling first (a hot key hits it however big the table is), then the table's throughput.
          if (!node.limiter.takeUnsafe(partitionKey(index, op), limit, units)) {
            throttled.partition++
            op === "read" ? throttled.reads++ : throttled.writes++
            return reject(Throttled({ node: node.id, reason: "ProvisionedThroughputExceededException (partition limit)" }))
          }
          if (!node.limiter.takeUnsafe(op === "read" ? readKey : writeKey, op === "read" ? cap.readBucket : cap.writeBucket, units)) {
            op === "read" ? throttled.reads++ : throttled.writes++
            return reject(Throttled({ node: node.id, reason: c.mode === "on-demand" ? "ThrottlingException (beyond double the previous peak)" : "ProvisionedThroughputExceededException" }))
          }
          op === "read" ? (consumed.reads += units, served.reads += message.count) : (consumed.writes += units, served.writes += message.count)
          return Flow.wait(fast, Distribution.latencyMs(c.latency, fast.random))
        },
        probe: Effect.sync(() => {
          const c = fast.settings()
          const cap = capacity()
          return {
            mode: c.mode,
            readCapacity: cap.read,
            writeCapacity: cap.write,
            partitions: cap.partitions,
            readTokens: node.limiter.levelUnsafe(readKey, cap.readBucket),
            writeTokens: node.limiter.levelUnsafe(writeKey, cap.writeBucket),
            served: { ...served },
            throttled: { ...throttled },
            peak: { ...peak }
          }
        })
      }
    })
})

type Config = Schema.Schema.Type<typeof DynamoDb.config>
type Account = Aws.Account

const PARTITION_BUCKET = {
  read: { rate: PARTITION.read, burst: PARTITION.read },
  write: { rate: PARTITION.write, burst: PARTITION.write }
} as const

/** Record what this table asks of the account. Bumps the shared version only when something actually changed. */
const claim = (region: Region, id: string, read: number, write: number): void => {
  const held = region.claims.get(id)
  if (held !== undefined && held.read === read && held.write === write) return
  region.claims.set(id, { read, write })
  region.version++
}
