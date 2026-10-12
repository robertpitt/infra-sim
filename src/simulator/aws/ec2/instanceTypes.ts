/**
 * A catalog of common EC2 instance types: what an Auto Scaling group (`aws.ec2`), an ECS capacity provider or an EKS
 * node group runs on. Each entry is the type's default vCPUs and memory, as AWS's Instance Types guide lists them
 * (checked October 2026):
 *  - general purpose (t3, m5, m6i, m7i, m7g): https://docs.aws.amazon.com/ec2/latest/instancetypes/gp.html
 *  - compute optimized (c6i, c7i, c7g): https://docs.aws.amazon.com/ec2/latest/instancetypes/co.html
 *  - memory optimized (r6i): https://docs.aws.amazon.com/ec2/latest/instancetypes/mo.html
 *
 * The simulator reads two things from a type: its vCPUs, which set how many requests an instance works on at once and
 * what it counts against the account's vCPU quotas, and its memory, which an ECS or EKS scheduler packs tasks and pods
 * into. Every type here belongs to the "Standard (A, C, D, H, I, M, R, T, Z)" quota group, so they share one On-Demand
 * and one Spot vCPU quota per region (see `quotas.ts`).
 *
 * Use it from another service as:
 *
 *   import { INSTANCE_TYPE_NAMES, instanceType } from "../ec2/instanceTypes.ts"
 *   instanceType("m7i.large")   // { name: "m7i.large", vcpus: 2, memoryGiB: 8, ... }
 */

/** The guides' pages, for a setting's or a limit's source. */
export const SOURCES = {
  generalPurpose: "https://docs.aws.amazon.com/ec2/latest/instancetypes/gp.html",
  computeOptimized: "https://docs.aws.amazon.com/ec2/latest/instancetypes/co.html",
  memoryOptimized: "https://docs.aws.amazon.com/ec2/latest/instancetypes/mo.html"
} as const

/** One instance type. */
export interface InstanceType {
  /** `m7i.large`. */
  readonly name: string
  /** `m7i`. */
  readonly family: string
  /** Default vCPUs: a hyperthread on Intel types, a whole core on Graviton (arm64) ones. */
  readonly vcpus: number
  /** Memory in GiB. */
  readonly memoryGiB: number
  readonly architecture: "x86_64" | "arm64"
  readonly processor: string
  /** Burstable (T family): CPU credits, `unlimited` by default for T3. */
  readonly burstable: boolean
  /** The vCPU quota group it counts against: every type in this catalog is in the Standard group. */
  readonly quotaGroup: "standard"
  /** The guide page it was checked against. */
  readonly source: string
}

/** vCPUs by size, the same in every family here (`medium` exists only for Graviton types). */
const VCPUS = {
  medium: 1,
  large: 2,
  xlarge: 4,
  "2xlarge": 8,
  "4xlarge": 16,
  "8xlarge": 32,
  "12xlarge": 48,
  "16xlarge": 64,
  "24xlarge": 96,
  "32xlarge": 128,
  "48xlarge": 192
} as const
type Size = keyof typeof VCPUS

interface Family {
  readonly family: string
  readonly sizes: ReadonlyArray<Size>
  /** GiB per vCPU: 4 for M, 2 for C, 8 for R (the guide's tables, which these reproduce exactly). */
  readonly gibPerVcpu: number
  readonly architecture: "x86_64" | "arm64"
  readonly processor: string
  readonly source: string
}

const sized = (f: Family): ReadonlyArray<InstanceType> =>
  f.sizes.map((size) => ({
    name: `${f.family}.${size}`,
    family: f.family,
    vcpus: VCPUS[size],
    memoryGiB: VCPUS[size] * f.gibPerVcpu,
    architecture: f.architecture,
    processor: f.processor,
    burstable: false,
    quotaGroup: "standard" as const,
    source: f.source
  }))

/** T3 doesn't follow a ratio: every size up to large has 2 vCPUs, with memory doubling. */
const t3 = (name: string, vcpus: number, memoryGiB: number): InstanceType => ({
  name: `t3.${name}`,
  family: "t3",
  vcpus,
  memoryGiB,
  architecture: "x86_64",
  processor: "Intel Xeon Platinum 8175 (Skylake)",
  burstable: true,
  quotaGroup: "standard",
  source: SOURCES.generalPurpose
})

const INTEL_SIZES: ReadonlyArray<Size> = ["large", "xlarge", "2xlarge", "4xlarge", "8xlarge", "12xlarge", "16xlarge", "24xlarge", "32xlarge"]
const GRAVITON_SIZES: ReadonlyArray<Size> = ["medium", "large", "xlarge", "2xlarge", "4xlarge", "8xlarge", "12xlarge", "16xlarge"]
const M5_SIZES: ReadonlyArray<Size> = ["large", "xlarge", "2xlarge", "4xlarge", "8xlarge", "12xlarge", "16xlarge", "24xlarge"]
const SEVENTH_GEN_INTEL: ReadonlyArray<Size> = ["large", "xlarge", "2xlarge", "4xlarge", "8xlarge", "12xlarge", "16xlarge", "24xlarge", "48xlarge"]

/** Every type in the catalog, in palette order: burstable, general purpose, compute optimized, memory optimized. */
export const INSTANCE_TYPES: ReadonlyArray<InstanceType> = [
  t3("nano", 2, 0.5),
  t3("micro", 2, 1),
  t3("small", 2, 2),
  t3("medium", 2, 4),
  t3("large", 2, 8),
  t3("xlarge", 4, 16),
  t3("2xlarge", 8, 32),
  ...sized({ family: "m5", sizes: M5_SIZES, gibPerVcpu: 4, architecture: "x86_64", processor: "Intel Xeon Platinum 8175", source: SOURCES.generalPurpose }),
  ...sized({ family: "m6i", sizes: INTEL_SIZES, gibPerVcpu: 4, architecture: "x86_64", processor: "Intel Xeon Ice Lake", source: SOURCES.generalPurpose }),
  ...sized({ family: "m7i", sizes: SEVENTH_GEN_INTEL, gibPerVcpu: 4, architecture: "x86_64", processor: "Intel Xeon Sapphire Rapids", source: SOURCES.generalPurpose }),
  ...sized({ family: "m7g", sizes: GRAVITON_SIZES, gibPerVcpu: 4, architecture: "arm64", processor: "AWS Graviton3", source: SOURCES.generalPurpose }),
  ...sized({ family: "c6i", sizes: INTEL_SIZES, gibPerVcpu: 2, architecture: "x86_64", processor: "Intel Xeon Ice Lake", source: SOURCES.computeOptimized }),
  ...sized({ family: "c7i", sizes: SEVENTH_GEN_INTEL, gibPerVcpu: 2, architecture: "x86_64", processor: "Intel Xeon Sapphire Rapids", source: SOURCES.computeOptimized }),
  ...sized({ family: "c7g", sizes: GRAVITON_SIZES, gibPerVcpu: 2, architecture: "arm64", processor: "AWS Graviton3", source: SOURCES.computeOptimized }),
  ...sized({ family: "r6i", sizes: INTEL_SIZES, gibPerVcpu: 8, architecture: "x86_64", processor: "Intel Xeon Ice Lake", source: SOURCES.memoryOptimized })
]

const BY_NAME: ReadonlyMap<string, InstanceType> = new Map(INSTANCE_TYPES.map((t) => [t.name, t]))

/** The names, as a tuple for `Setting.choice`. */
export const INSTANCE_TYPE_NAMES = INSTANCE_TYPES.map((t) => t.name) as unknown as readonly [string, ...Array<string>]

/** The default for a web tier: two vCPUs and 8 GiB of the current Intel general-purpose generation. */
export const DEFAULT_INSTANCE_TYPE = "m7i.large"

/** A type by name. An unknown name (a design written for a type the catalog lacks) falls back to the default. */
export const instanceType = (name: string): InstanceType => BY_NAME.get(name) ?? BY_NAME.get(DEFAULT_INSTANCE_TYPE)!

/** Whether the catalog has it. */
export const isInstanceType = (name: string): boolean => BY_NAME.has(name)
