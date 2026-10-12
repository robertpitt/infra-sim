import { CLASS_NAMES, type Engine, ENGINES } from "../../../src/simulator/aws/rds/catalog.ts"
import type { Row } from "../bulk.ts"
import type { Match, ServiceMap } from "../map.ts"
import { attr } from "../map.ts"

/**
 * RDS and Aurora: DB instance hours by engine, deployment and class; RDS storage (GB-months) and provisioned IOPS
 * (IOPS-months) by volume type and deployment; Aurora's cluster volume (GB-months) and its I/O requests; RDS Proxy, by
 * the vCPUs of the databases behind it (vCPU-hours).
 * https://aws.amazon.com/rds/pricing/ (and /rds/aurora/pricing/, /rds/proxy/pricing/)
 *
 * Usage types (after the region prefix): `InstanceUsage:<class>`, `Multi-AZUsage:<class>` (a Multi-AZ DB instance, the
 * standby included) and `Multi-AZClusterUsage:<class>` (a Multi-AZ DB cluster: the writer and its two readable
 * standbys), read by the `Database Engine` and `Instance Type` columns since the cluster's usage types abbreviate the
 * class (`db.m6gd.xl`); `RDS:[Multi-AZ-|Multi-AZCluster-]GP3-Storage` and `...GP3-PIOPS`, `...PIOPS-Storage` and
 * `...PIOPS` (io1), `...PIOPS-Storage-IO2` and `...IO2-PIOPS`; `Aurora:StorageUsage`, `Aurora:StorageIOUsage`;
 * `RDS:ProxyUsage`. Storage, Aurora I/O and Proxy rows are listed per engine at one price, so their dimensions aren't
 * by engine. Only the engines and classes the simulator offers (`src/simulator/aws/rds/catalog.ts`).
 * Left out: Aurora I/O-Optimized and Aurora Serverless (the simulator models neither), gp3 throughput (not modelled),
 * gp2 and magnetic storage, backups and snapshot export, Extended Support, CPU credits of burstable classes in unlimited
 * mode, Aurora global database replicated writes, Backtrack, Limitless, RDS Custom, Outposts, and the other engines
 * (Oracle, SQL Server, Db2).
 */

const ENGINE_NAMES: Record<Engine, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  mariadb: "MariaDB",
  "aurora-postgres": "Aurora PostgreSQL",
  "aurora-mysql": "Aurora MySQL"
}
const ENGINE_OF = new Map(ENGINES.map((e) => [ENGINE_NAMES[e], e] as const))
const CLASSES = new Set<string>(CLASS_NAMES)

/** The deployment in a usage type: `Multi-AZ-` in `RDS:Multi-AZ-GP3-Storage`, `Multi-AZCluster` in `Multi-AZClusterUsage`. */
const DEPLOYMENT = { "": "single-az", "Multi-AZ": "multi-az", "Multi-AZCluster": "multi-az-cluster" } as const
type Deployment = (typeof DEPLOYMENT)[keyof typeof DEPLOYMENT]
const DEPLOYMENT_LABEL: Record<Deployment, string> = {
  "single-az": "Single-AZ",
  "multi-az": "Multi-AZ DB instance (the standby included)",
  "multi-az-cluster": "Multi-AZ DB cluster (the writer and two readable standbys)"
}

/** RDS storage usage types, without the deployment: what they price. */
const STORAGE: Record<string, string> = {
  "GP3-Storage": "storage/gp3",
  "GP3-PIOPS": "iops/gp3",
  "PIOPS-Storage": "storage/io1",
  PIOPS: "iops/io1",
  "PIOPS-Storage-IO2": "storage/io2",
  "IO2-PIOPS": "iops/io2"
}

const VOLUME = { gp3: "General Purpose (gp3)", io1: "Provisioned IOPS (io1)", io2: "Provisioned IOPS (io2 Block Express)" } as const

const storageDimensions = Object.fromEntries(
  Object.entries(VOLUME).flatMap(([v, name]) =>
    Object.values(DEPLOYMENT).flatMap((d) => [
      [`storage/${v}/${d}`, { unit: "GB-month", description: `${name} storage allocated, ${DEPLOYMENT_LABEL[d]}` }],
      [
        `iops/${v}/${d}`,
        {
          unit: "IOPS-month",
          description: `${name} IOPS provisioned${v === "gp3" ? " above the baseline (3,000, or 12,000 from 400 GiB)" : ""}, ${DEPLOYMENT_LABEL[d]}`
        }
      ]
    ])
  )
)

/**
 * A row for one of the simulator's engines, in an AWS Region (not Outposts, not RDS Custom). Storage and Proxy prices
 * are also listed once for engine `Any`, which is left out: in some regions it is rounded differently from every
 * engine's own row (ap-southeast-5's Multi-AZ gp3 IOPS: 0.044 for `Any`, 0.043 for each engine).
 */
const ours = (row: Row): boolean =>
  attr(row, "Location Type") === "AWS Region" && attr(row, "Deployment Model") === "" && ENGINE_OF.has(attr(row, "Database Engine"))

const instance = (row: Row, deployment: Deployment): Match | undefined => {
  const engine = ENGINE_OF.get(attr(row, "Database Engine"))
  const type = attr(row, "Instance Type")
  if (engine === undefined || !CLASSES.has(type)) return undefined
  // Aurora has no deployment option of its own: availability comes from its readers, each billed as an instance.
  if (engine === "aurora-mysql" || engine === "aurora-postgres") return deployment === "single-az" ? { dimension: `instance/${engine}/${type}` } : undefined
  return { dimension: `instance/${engine}/${deployment}/${type}` }
}

export const rds: ServiceMap = {
  id: "rds",
  title: "Amazon RDS and Aurora",
  offers: ["AmazonRDS"],
  dimensions: {
    "instance/*": {
      unit: "hour",
      description:
        "DB instance hours: instance/<engine>/<single-az|multi-az|multi-az-cluster>/<class> for RDS; " +
        "instance/<aurora-mysql|aurora-postgres>/<class> per Aurora instance, writer or reader"
    },
    ...storageDimensions,
    "aurora/storage": { unit: "GB-month", description: "Aurora cluster volume storage used (Aurora Standard)" },
    "aurora/io": { unit: "request", description: "Aurora cluster volume I/O requests, reads and writes (Aurora Standard)" },
    proxy: { unit: "vCPU-hour", description: "RDS Proxy: per vCPU of the DB instances behind it, per hour" }
  },
  classify: (row) => {
    if (!ours(row)) return undefined
    const usage = row.usage.replace(/^[A-Z]{2,4}[0-9]-/, "")
    let m: RegExpExecArray | null
    if ((m = /^(InstanceUsage|Multi-AZUsage|Multi-AZClusterUsage):db\./.exec(usage)))
      return instance(row, m[1] === "InstanceUsage" ? "single-az" : m[1] === "Multi-AZUsage" ? "multi-az" : "multi-az-cluster")
    if ((m = /^RDS:(?:(Multi-AZ|Multi-AZCluster)-)?(.+)$/.exec(usage)) && STORAGE[m[2]!] !== undefined)
      return { dimension: `${STORAGE[m[2]!]}/${DEPLOYMENT[(m[1] ?? "") as keyof typeof DEPLOYMENT]}` }
    if (usage === "Aurora:StorageUsage") return { dimension: "aurora/storage" }
    if (usage === "Aurora:StorageIOUsage") return { dimension: "aurora/io" }
    if (usage === "RDS:ProxyUsage") return { dimension: "proxy" }
    return undefined
  }
}
