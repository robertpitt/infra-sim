import type { ServiceMap } from "../map.ts"

/**
 * Elastic Load Balancing: an Application or Network Load Balancer by the hour, plus its capacity units by the hour
 * (LCUs for an ALB, NLCUs for an NLB: the highest of new connections, active connections, bytes and rule evaluations
 * that hour, which the simulator already counts), and an ALB's LCU reservation.
 * https://aws.amazon.com/elasticloadbalancing/pricing/
 *
 * Usage types (after the region prefix), told apart by `operation` (`LoadBalancing:Application`, `LoadBalancing:Network`):
 * `LoadBalancerUsage`, `LCUUsage`, `ReservedLCUUsage` (ALB only in most regions).
 * Left out: Classic Load Balancers (`LoadBalancing`: their hours and `DataProcessing-Bytes`), Gateway Load Balancers,
 * Outposts, ALB trust stores (`TS-LoadBalancerUsage`) and NLB reservations: none of them is modelled.
 */
const KINDS: Readonly<Record<string, string>> = {
  "LoadBalancing:Application": "alb",
  "LoadBalancing:Network": "nlb"
}

export const elb: ServiceMap = {
  id: "elb",
  title: "Elastic Load Balancing",
  offers: ["AWSELB"],
  dimensions: {
    "alb/hour": {
      unit: "hour",
      description: "Application Load Balancer, per load balancer-hour (or partial hour)"
    },
    "alb/lcu": {
      unit: "LCU-hour",
      description: "Application Load Balancer capacity units used, per LCU-hour"
    },
    "alb/reserved-lcu": {
      unit: "LCU-hour",
      description: "Application Load Balancer capacity units reserved (LCU reservation), per LCU-hour"
    },
    "nlb/hour": {
      unit: "hour",
      description: "Network Load Balancer, per load balancer-hour (or partial hour)"
    },
    "nlb/nlcu": {
      unit: "NLCU-hour",
      description: "Network Load Balancer capacity units used, per NLCU-hour"
    }
  },
  classify: (row) => {
    const kind = KINDS[row.operation]
    if (kind === undefined) return undefined
    switch (row.usage) {
      case "LoadBalancerUsage":
        return { dimension: `${kind}/hour` }
      case "LCUUsage":
        return { dimension: kind === "alb" ? "alb/lcu" : "nlb/nlcu" }
      case "ReservedLCUUsage":
        return kind === "alb" ? { dimension: "alb/reserved-lcu" } : undefined
      default:
        return undefined
    }
  }
}
