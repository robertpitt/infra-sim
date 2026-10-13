import { Effect } from "effect"
import type * as Component from "../../../Component.ts"
import type { Unit } from "../../../Protocol.ts"
import type { Account } from "../../internal/account.ts"

/**
 * AWS Fargate's side of an ECS service: the task sizes it accepts, the account's regional vCPU quotas every Fargate
 * service shares, and Fargate Spot's interruptions.
 */

/**
 * Task CPU units (1,024 to a vCPU) and the memory each allows, in MiB, for Linux tasks
 * (`fargate-tasks-services.html#fargate-tasks-size`): 0.25 vCPU with 0.5, 1 or 2 GB; then ranges in 1 GB steps up to
 * 4 vCPU; 8 vCPU in 4 GB steps and 16 vCPU in 8 GB steps (platform 1.4.0+); 32 vCPU with 60, 120 or 244 GB.
 */
export const SIZES: Readonly<Record<string, ReadonlyArray<number>>> = {
  "256": [512, 1024, 2048],
  "512": range(1024, 4096, 1024),
  "1024": range(2048, 8192, 1024),
  "2048": range(4096, 16384, 1024),
  "4096": range(8192, 30720, 1024),
  "8192": range(16384, 61440, 4096),
  "16384": range(32768, 122880, 8192),
  "32768": [61440, 122880, 249856]
}

function range(from: number, to: number, step: number): ReadonlyArray<number> {
  const out: Array<number> = []
  for (let m = from; m <= to; m += step) out.push(m)
  return out
}

/** The CPU choices, for a setting. */
export const CPU_UNITS = ["256", "512", "1024", "2048", "4096", "8192", "16384", "32768"] as const
export type CpuUnits = (typeof CPU_UNITS)[number]

export const CPU_LABELS: Record<CpuUnits, string> = {
  "256": "0.25 vCPU",
  "512": "0.5 vCPU",
  "1024": "1 vCPU",
  "2048": "2 vCPU",
  "4096": "4 vCPU",
  "8192": "8 vCPU",
  "16384": "16 vCPU",
  "32768": "32 vCPU"
}

/** vCPUs of a task size. */
export const vcpusOf = (cpu: CpuUnits): number => Number(cpu) / 1024

/** Whether Fargate accepts this CPU and memory together. */
export const isValidSize = (cpu: CpuUnits, memory: number): boolean => SIZES[cpu]?.includes(memory) ?? false

/**
 * The memory Fargate would give a task asking for `memory` with this CPU: the smallest allowed value at least as large,
 * or the largest allowed. (AWS refuses an invalid pair when the task definition is registered; the design audit says so,
 * and the simulator runs the nearest valid size.)
 */
export const fargateMemory = (cpu: CpuUnits, memory: number): number => {
  const allowed = SIZES[cpu] ?? [memory]
  for (const m of allowed) if (m >= memory) return m
  return allowed[allowed.length - 1]!
}

/** A capacity type a task runs on: Fargate (On-Demand) or Fargate Spot. */
export type Purchase = "onDemand" | "spot"

/**
 * The region's running Fargate vCPUs, counted against the account's two quotas (On-Demand and Spot): one ledger per
 * placement, shared by every ECS service there through `node.shared`, so two services compete for one quota as in AWS.
 */
export interface Ledger {
  onDemand: number
  spot: number
  /** Launches refused for want of quota, over the region. */
  refused: number
}

export const LEDGER_KEY = "aws.ecs.fargate-vcpus"

export const ledgerOf = (node: { readonly shared: <A>(key: string, build: Effect.Effect<A>) => Effect.Effect<A> }): Effect.Effect<Ledger> =>
  node.shared(LEDGER_KEY, Effect.sync((): Ledger => ({ onDemand: 0, spot: 0, refused: 0 })))

export const quotaOf = (account: Account, purchase: Purchase): number => (purchase === "onDemand" ? account.fargateOnDemandVcpus : account.fargateSpotVcpus)

/** Take one task's vCPUs, or refuse when the quota hasn't room for them. */
export const take = (ledger: Ledger, account: Account, purchase: Purchase, vcpus: number): boolean => {
  if (ledger[purchase] + vcpus > quotaOf(account, purchase) + 1e-9) {
    ledger.refused++
    return false
  }
  ledger[purchase] += vcpus
  return true
}

export const give = (ledger: Ledger, purchase: Purchase, vcpus: number): void => {
  ledger[purchase] = Math.max(0, ledger[purchase] - vcpus)
}

/**
 * Which capacity a new task goes to under a capacity provider strategy (`API_CapacityProviderStrategyItem.html`): the
 * first `base` tasks on Fargate (On-Demand), then the rest in proportion to the weights, each new task going where it
 * keeps the split closest to them. A weight of 0 places nothing there.
 */
export const pick = (onDemand: number, spot: number, base: number, onDemandWeight: number, spotWeight: number): Purchase => {
  if (onDemand < base) return "onDemand"
  if (spotWeight <= 0) return "onDemand"
  if (onDemandWeight <= 0) return "spot"
  const beyond = onDemand - base
  return (beyond + 1) / onDemandWeight <= (spot + 1) / spotWeight ? "onDemand" : "spot"
}

/** How often the Spot interruption process looks again at the rate and the Spot tasks running. */
const SPOT_RECHECK_MS = 10_000

/** What the Fargate Spot interruption process needs of its service. */
export interface SpotHost {
  readonly after: Component.Fast<unknown>["after"]
  /** The process's own stream of random numbers. */
  readonly random: Component.Fast<unknown>["random"]
  /** Interruptions per Spot task per hour, now. */
  readonly rate: () => number
  /** Whether the service holds any Fargate capacity at all (if not, there are no Spot tasks to look for). */
  readonly holding: () => boolean
  /** The Spot tasks serving. */
  readonly serving: () => Array<Unit>
  /** Interrupt one: SIGTERM with the warning, then stopped after its stop timeout. */
  readonly interrupt: (victim: Unit) => void
}

/** Starts Fargate Spot interruptions: a Poisson process over the Spot tasks running, from a stream of its own. */
export const interruptSpot = (host: SpotHost): void => {
  const { after, random } = host
  const next = (): void => {
    const rate = host.rate()
    const n = host.holding() ? host.serving().length : 0
    if (rate <= 0 || n === 0) {
      after(SPOT_RECHECK_MS, due, false)
      return
    }
    // The process is memoryless, so a wait longer than the recheck can be drawn again then: a rate raised meanwhile
    // (a scenario's interruption wave) takes effect within the recheck.
    const wait = -Math.log(1 - random.nextDoubleUnsafe()) / ((rate * n) / 3_600_000)
    if (wait > SPOT_RECHECK_MS) after(SPOT_RECHECK_MS, due, false)
    else after(wait, due, true)
  }
  const due = (isDue: boolean): void => {
    if (isDue && host.rate() > 0) {
      const spot = host.serving()
      const victim = spot[Math.floor(random.nextDoubleUnsafe() * spot.length)]
      if (victim !== undefined) host.interrupt(victim)
    }
    next()
  }
  next()
}
