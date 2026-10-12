/**
 * Engines and DB instance classes, and the `max_connections` each default parameter group derives from them.
 *
 * vCPUs and memory are AWS's hardware table (Concepts.DBInstanceClass.Summary). The default `max_connections` formulas
 * are AWS's (CHAP_Limits for RDS, AuroraPostgreSQL.Managing for Aurora PostgreSQL); Aurora MySQL's are the published
 * table (AuroraMySQL.Managing.Performance), since the page gives the table rather than the formula.
 */

export const ENGINES = ["postgres", "mysql", "mariadb", "aurora-postgres", "aurora-mysql"] as const
export type Engine = (typeof ENGINES)[number]

export const ENGINE_LABELS: Record<Engine, string> = {
  postgres: "RDS for PostgreSQL",
  mysql: "RDS for MySQL",
  mariadb: "RDS for MariaDB",
  "aurora-postgres": "Aurora PostgreSQL",
  "aurora-mysql": "Aurora MySQL"
}

export const isAurora = (engine: Engine): boolean => engine === "aurora-postgres" || engine === "aurora-mysql"
export const isMysqlFamily = (engine: Engine): boolean => engine === "mysql" || engine === "mariadb" || engine === "aurora-mysql"

export interface InstanceClass {
  readonly vcpu: number
  readonly memoryGiB: number
  /** Aurora MySQL's default `max_connections` for the class, from AWS's table. Absent: Aurora doesn't offer the class. */
  readonly auroraMysql?: number
  /** Aurora PostgreSQL offers the class (AuroraPostgreSQL.Managing lists its classes). */
  readonly auroraPostgres?: true
  /** A class a Multi-AZ DB cluster runs on: only instance-store ("d") classes (multi-az-db-clusters-concepts). */
  readonly multiAzCluster?: true
}

/** A handful of common classes, small to large: burstable (t), general purpose (m), memory optimised (r). */
export const CLASSES = {
  "db.t3.micro": { vcpu: 2, memoryGiB: 1 },
  "db.t3.medium": { vcpu: 2, memoryGiB: 4, auroraMysql: 90, auroraPostgres: true },
  "db.t4g.micro": { vcpu: 2, memoryGiB: 1 },
  "db.t4g.medium": { vcpu: 2, memoryGiB: 4, auroraMysql: 90, auroraPostgres: true },
  "db.t4g.large": { vcpu: 2, memoryGiB: 8, auroraMysql: 135, auroraPostgres: true },
  "db.m5.large": { vcpu: 2, memoryGiB: 8 },
  "db.m6g.large": { vcpu: 2, memoryGiB: 8 },
  "db.m6gd.large": { vcpu: 2, memoryGiB: 8, multiAzCluster: true },
  "db.m6gd.xlarge": { vcpu: 4, memoryGiB: 16, multiAzCluster: true },
  "db.m7g.large": { vcpu: 2, memoryGiB: 8 },
  "db.m7g.xlarge": { vcpu: 4, memoryGiB: 16 },
  "db.m7g.2xlarge": { vcpu: 8, memoryGiB: 32 },
  "db.m7g.4xlarge": { vcpu: 16, memoryGiB: 64 },
  "db.r6g.large": { vcpu: 2, memoryGiB: 16, auroraMysql: 1_000, auroraPostgres: true },
  "db.r6g.xlarge": { vcpu: 4, memoryGiB: 32, auroraMysql: 2_000, auroraPostgres: true },
  "db.r6gd.large": { vcpu: 2, memoryGiB: 16, multiAzCluster: true },
  "db.r6gd.xlarge": { vcpu: 4, memoryGiB: 32, multiAzCluster: true },
  "db.r6gd.2xlarge": { vcpu: 8, memoryGiB: 64, multiAzCluster: true },
  "db.r7g.large": { vcpu: 2, memoryGiB: 16, auroraMysql: 1_000, auroraPostgres: true },
  "db.r7g.xlarge": { vcpu: 4, memoryGiB: 32, auroraMysql: 2_000, auroraPostgres: true },
  "db.r7g.2xlarge": { vcpu: 8, memoryGiB: 64, auroraMysql: 3_000, auroraPostgres: true },
  "db.r7g.4xlarge": { vcpu: 16, memoryGiB: 128, auroraMysql: 4_000, auroraPostgres: true },
  "db.r7g.8xlarge": { vcpu: 32, memoryGiB: 256, auroraMysql: 5_000, auroraPostgres: true },
  "db.r7g.16xlarge": { vcpu: 64, memoryGiB: 512, auroraMysql: 6_000, auroraPostgres: true }
} as const satisfies Record<string, InstanceClass>

export type ClassName = keyof typeof CLASSES
export const CLASS_NAMES = Object.keys(CLASSES) as [ClassName, ...Array<ClassName>]

export const classOf = (name: ClassName): InstanceClass => CLASSES[name]

/** Whether the engine runs on the class: Aurora offers only some. */
export const offers = (engine: Engine, name: ClassName): boolean => {
  const c: InstanceClass = CLASSES[name]
  if (engine === "aurora-mysql") return c.auroraMysql !== undefined
  if (engine === "aurora-postgres") return c.auroraPostgres === true
  return true
}

const GiB = 1024 ** 3

/** The divisors of the default formulas: `{DBInstanceClassMemory/n}`. (CHAP_Limits, AuroraPostgreSQL.Managing) */
const DIVISOR = { mysql: 12_582_880, mariadb: 25_165_760, postgres: 9_531_392 } as const
/** Caps in the default formulas: `LEAST(..., 5000)` for PostgreSQL, `LEAST(..., 12000)` for MariaDB 10.5 and later. */
const CAP = { mariadb: 12_000, postgres: 5_000 } as const

/**
 * `DBInstanceClassMemory` is the class's memory less what the operating system and RDS's own processes reserve, and AWS
 * doesn't publish the reservation ("the exact value depends on a combination of factors", USER_ParamValuesRef). It does
 * give two worked examples for MySQL (CHAP_Limits): about 60 connections on a db.t3.micro (1 GiB) and about 630 on a
 * class with 8 GiB. A reservation of a fixed part plus a share of memory, fitted through those two points, reproduces
 * both; it is an assumption between and beyond them.
 */
const EXAMPLES = [
  { memory: 1 * GiB, connections: 60 },
  { memory: 8 * GiB, connections: 630 }
] as const
const reservedIn = (e: (typeof EXAMPLES)[number]): number => e.memory - e.connections * DIVISOR.mysql
const RESERVED_SHARE = (reservedIn(EXAMPLES[1]) - reservedIn(EXAMPLES[0])) / (EXAMPLES[1].memory - EXAMPLES[0].memory)
const RESERVED_FIXED = reservedIn(EXAMPLES[0]) - RESERVED_SHARE * EXAMPLES[0].memory

/** `DBInstanceClassMemory` for a class with `memoryGiB`, in bytes (see above: an assumption fitted to AWS's examples). */
export const instanceClassMemory = (memoryGiB: number): number => {
  const memory = memoryGiB * GiB
  return Math.max(0, memory - (RESERVED_FIXED + RESERVED_SHARE * memory))
}

/** A formula's integer division truncates (USER_ParamValuesRef); the nudge keeps a value that is whole in exact arithmetic whole. */
const divide = (bytes: number, divisor: number): number => Math.floor(bytes / divisor + 1e-9)

/** The `max_connections` the engine's default parameter group gives an instance of this class. */
export const defaultMaxConnections = (engine: Engine, name: ClassName): number => {
  const c: InstanceClass = CLASSES[name]
  const memory = instanceClassMemory(c.memoryGiB)
  switch (engine) {
    case "mysql":
      return Math.max(1, divide(memory, DIVISOR.mysql))
    case "mariadb":
      return Math.max(1, Math.min(divide(memory, DIVISOR.mariadb), CAP.mariadb))
    case "postgres":
    case "aurora-postgres":
      return Math.max(6, Math.min(divide(memory, DIVISOR.postgres), CAP.postgres))
    case "aurora-mysql":
      // A class Aurora doesn't offer (the audit says so) falls back to the RDS for MySQL formula.
      return c.auroraMysql ?? Math.max(1, divide(memory, DIVISOR.mysql))
  }
}
