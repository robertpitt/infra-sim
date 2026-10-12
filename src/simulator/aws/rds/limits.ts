import { docs } from "../docs.ts"

/**
 * The AWS pages every RDS number comes from, and the numbers themselves, named. The README's Limits table cites the same
 * pages; a setting or limit that quotes one of these constants cites its source here.
 */

const RDS = docs.rds
const AURORA = docs.aurora

export const SOURCES = {
  quotas: `${RDS}CHAP_Limits.html`,
  maxConnections: `${RDS}CHAP_Limits.html#RDS_Limits.MaxConnections`,
  formulas: `${RDS}USER_ParamValuesRef.html`,
  classes: `${RDS}Concepts.DBInstanceClass.Summary.html`,
  auroraMysqlConnections: `${AURORA}AuroraMySQL.Managing.Performance.html#AuroraMySQL.Managing.MaxConnections`,
  auroraPostgresConnections: `${AURORA}AuroraPostgreSQL.Managing.html#AuroraPostgreSQL.Managing.MaxConnections`,
  multiAzInstance: `${RDS}Concepts.MultiAZSingleStandby.html`,
  multiAzInstanceFailover: `${RDS}Concepts.MultiAZ.Failover.html`,
  multiAzCluster: `${RDS}multi-az-db-clusters-concepts.html`,
  multiAzClusterFailover: `${RDS}multi-az-db-clusters-concepts-failover.html`,
  auroraAvailability: `${AURORA}Concepts.AuroraHighAvailability.html`,
  auroraReplicas: `${AURORA}Aurora.Replication.html`,
  readReplicas: `${RDS}USER_ReadRepl.html`,
  storage: `${RDS}CHAP_Storage.html`,
  proxy: `${RDS}rds-proxy.html`,
  proxyConcepts: `${RDS}rds-proxy.howitworks.html`,
  proxyConnections: `${RDS}rds-proxy-connections.html`,
  proxyPinning: `${RDS}rds-proxy-pinning.html`,
  proxyCreating: `${RDS}rds-proxy-creating.html`,
  proxyErrors: `${RDS}rds-proxy.troubleshooting.html`,
  proxyNetwork: `${RDS}rds-proxy-network-prereqs.html`,
  proxyPool: "https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_ConnectionPoolConfiguration.html"
} as const

/** Aurora Replicas per cluster (hard), and RDS read replicas per primary (a quota, 15 by default). (Aurora.Replication, CHAP_Limits) */
export const MAX_READERS = 15

/** A Multi-AZ DB cluster has a writer and two readable standbys, in three zones. (multi-az-db-clusters-concepts) */
export const CLUSTER_STANDBYS = 2

/**
 * RDS Proxy treats a database connection as idle after five minutes without activity, and closes idle ones beyond
 * `MaxIdleConnectionsPercent`. (rds-proxy-connections, MaxIdleConnectionsPercent)
 */
export const PROXY_IDLE_AFTER_MS = 5 * 60_000

/** `ConnectionBorrowTimeout` must be between 0 and 300 seconds; the default is 120. (API_ConnectionPoolConfiguration) */
export const PROXY_BORROW_TIMEOUT_MAX = "300 seconds"

/** RDS Proxy ends a client connection after 24 hours, whatever it is doing; not configurable. (rds-proxy-connections) */
export const PROXY_CLIENT_MAX_LIFE = "24 hours"

/**
 * Storage, per volume, for MariaDB, MySQL and PostgreSQL (CHAP_Storage). gp3 gives a baseline of 3,000 IOPS below 400 GiB
 * and, striped over four volumes, 12,000 from 400 GiB, where 12,000 to 64,000 can be provisioned; io1 takes 1,000 to
 * 19,950 IOPS below 400 GiB and up to 256,000 from it, at 0.5 to 50 IOPS per GiB; io2 Block Express 1,000 to 256,000 at
 * 0.5 to 1,000 per GiB, from 100 GiB.
 */
export const STORAGE = {
  minGiB: { gp3: 20, io1: 100, io2: 100 },
  maxGiB: 65_536,
  stripedFromGiB: 400,
  gp3: { baseline: 3_000, stripedBaseline: 12_000, maxIops: 64_000, maxPerGiB: 500 },
  io1: { minIops: 1_000, smallMaxIops: 19_950, maxIops: 256_000, minPerGiB: 0.5, maxPerGiB: 50 },
  io2: { minIops: 1_000, maxIops: 256_000, minPerGiB: 0.5, maxPerGiB: 1_000 }
} as const

/** `max_connections` the engine accepts in a parameter group. (CHAP_Limits; Aurora MySQL: AuroraMySQL.Managing.Performance) */
export const MAX_CONNECTIONS_RANGE = {
  mysql: { min: 1, max: 100_000 },
  mariadb: { min: 1, max: 100_000 },
  postgres: { min: 6, max: 262_143 },
  "aurora-mysql": { min: 1, max: 16_000 },
  "aurora-postgres": { min: 6, max: 262_143 }
} as const
