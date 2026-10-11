import { asString, isUnresolved, referencesIn } from "../Intrinsics.ts"
import { type Bag, type Draft, type Handler, nameOf, type Resource, type Run, SOURCE } from "./model.ts"

/**
 * `AWS::EC2::VPC` is a box in the region; its subnets are not nodes but a plan inside the box (how many per zone, how
 * big); a NAT gateway and a VPC endpoint are components inside it; and a function with `VpcConfig` sits in the box of
 * the VPC that owns its subnets. Route tables, security groups and internet gateways say nothing the simulator uses.
 */

/** The prefix length of `10.0.1.0/24`. */
const prefixOf = (cidr: unknown): number | undefined => {
  const match = /\/(\d{1,2})$/.exec(asString(cidr) ?? "")
  return match === null ? undefined : Number(match[1])
}

/** The VPC a subnet belongs to, by following its `VpcId` to a VPC resource of the template. */
const vpcOfSubnet = (run: Run, subnet: Resource): Draft | undefined => run.target(subnet.props.VpcId, "aws.vpc")

/** A zone's letter, from `eu-west-1a` (or a local zone such as `us-west-2-lax-1a`). */
const zoneLetter = (az: unknown): string | undefined => {
  const letter = asString(az)?.slice(-1)
  return letter !== undefined && /^[a-f]$/.test(letter) ? letter : undefined
}

export const vpc: Handler = (run, r) => {
  const d = run.draft(r.id, nameOf(r), "aws.vpc", { source: SOURCE, ref: r.id, type: r.type })
  // An address pool (IPAM) allocates the block at deploy time; then the template has nothing to read.
  run.set(d, ["cidrPrefix"], r.props.CidrBlock === undefined ? undefined : isUnresolved(r.props.CidrBlock) ? r.props.CidrBlock : prefixOf(r.props.CidrBlock), "CidrBlock")
  run.later(() => subnetPlan(run, d))
}

/**
 * The VPC's subnets as the plan the component has: the same number in each zone, all the same size. A template whose
 * subnets differ is approximated and says so.
 */
const subnetPlan = (run: Run, d: Draft): void => {
  const subnets = [...run.resources.values()].filter((r) => r.type === "AWS::EC2::Subnet" && vpcOfSubnet(run, r) === d)
  if (subnets.length === 0) return
  const perZone = new Map<string, number>()
  const sizes = new Map<number, number>()
  for (const s of subnets) {
    // A zone the template can't name is told apart from the others only by being unnamed, so they share one.
    const az = asString(s.props.AvailabilityZone) ?? "?"
    perZone.set(az, (perZone.get(az) ?? 0) + 1)
    const prefix = prefixOf(s.props.CidrBlock)
    if (prefix !== undefined) sizes.set(prefix, (sizes.get(prefix) ?? 0) + 1)
    else if (isUnresolved(s.props.CidrBlock)) run.unresolved.push(`${d.name}: subnet ${s.id} CidrBlock (${s.props.CidrBlock.reason})`)
    run.consumed(s, d)
  }
  run.set(d, ["subnets", "enabled"], true, "AWS::EC2::Subnet")
  run.set(d, ["subnets", "availabilityZones"], perZone.size, "AWS::EC2::Subnet.AvailabilityZone")
  const most = Math.max(...perZone.values())
  run.set(d, ["subnets", "subnetsPerZone"], most, "AWS::EC2::Subnet")
  if (new Set(perZone.values()).size > 1) run.warn(`${d.name}: its subnets aren't the same number in each zone, but the plan has one number per zone; it uses the most (${most}).`)
  if (sizes.size > 0) {
    const [prefix] = [...sizes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]!
    run.set(d, ["subnets", "prefix"], prefix, "AWS::EC2::Subnet.CidrBlock")
    if (sizes.size > 1) run.warn(`${d.name}: its subnets differ in size, but the plan has one size; it uses the most common (/${prefix}).`)
  }
}

/** A subnet becomes part of its VPC's plan, which `subnetPlan` writes; one whose VPC isn't in the template has no plan to join. */
export const subnet = (run: Run, r: Resource): void => {
  if (vpcOfSubnet(run, r) === undefined) run.skip(r, "its VPC isn't in this template, so it can't be added to a subnet plan")
}

/** The VPC a resource with a `VpcId` sits in, or why it can't be placed. */
const vpcOf = (run: Run, r: Resource): Draft | undefined => run.target(r.props.VpcId, "aws.vpc")

/** `AWS::EC2::NatGateway`: a public gateway in the VPC of its subnet, in that subnet's zone, with its addresses. */
export const natGateway: Handler = (run, r) => {
  const p = r.props
  if (p.ConnectivityType === "private") {
    run.skip(r, "a private NAT gateway only connects networks, so the simulator's internet-facing gateway doesn't stand for it")
    return
  }
  const subnetRef = referencesIn(p.SubnetId).map((id) => run.resources.get(id)).find((s) => s?.type === "AWS::EC2::Subnet")
  const home = subnetRef === undefined ? undefined : vpcOfSubnet(run, subnetRef)
  if (subnetRef === undefined || home === undefined) {
    run.skip(r, "its subnet, and so its VPC, isn't in this template, and a NAT gateway has to sit inside a VPC")
    return
  }
  const d = run.draft(r.id, nameOf(r), "aws.nat-gateway", { source: SOURCE, ref: r.id, type: r.type })
  d.parent = home
  const zone = zoneLetter(subnetRef.props.AvailabilityZone)
  if (zone !== undefined) run.set(d, ["zone"], zone, "AvailabilityZone of its subnet")
  // One address from AllocationId, up to seven more from SecondaryAllocationIds; each is a bound on connections to one destination.
  const secondary = Array.isArray(p.SecondaryAllocationIds) ? p.SecondaryAllocationIds.length : 0
  run.set(d, ["addresses"], 1 + secondary, "AllocationId, SecondaryAllocationIds")
  run.warn(`${d.name}: the template's routes aren't read, so nothing is drawn through this NAT gateway. Connect the calls that leave the VPC to it.`)
}

/** `AWS::EC2::VPCEndpoint`: a gateway or interface endpoint in its VPC. */
export const vpcEndpoint: Handler = (run, r) => {
  const p = r.props
  const kind = asString(p.VpcEndpointType) ?? "Gateway"
  if (kind === "GatewayLoadBalancer") {
    run.skip(r, "Gateway Load Balancer endpoints have no simulator component (it models gateway and interface endpoints)")
    return
  }
  const home = vpcOf(run, r)
  if (home === undefined) {
    run.skip(r, "its VPC isn't in this template, and an endpoint has to sit inside a VPC")
    return
  }
  const d = run.draft(r.id, nameOf(r), "aws.vpc-endpoint", { source: SOURCE, ref: r.id, type: r.type })
  d.parent = home
  const interfaceType = kind === "Interface"
  run.set(d, ["type"], interfaceType ? "interface" : "gateway", "VpcEndpointType")
  if (interfaceType) {
    // An interface endpoint has a network interface in each subnet it is given; the zones those are in is what bandwidth scales with.
    const zones = new Set(referencesIn(p.SubnetIds).map((id) => asString(run.resources.get(id)?.props.AvailabilityZone)).filter((z): z is string => z !== undefined))
    if (zones.size > 0) run.set(d, ["availabilityZones"], zones.size, "SubnetIds")
  }
  run.warn(`${d.name}: the template's routes aren't read, so nothing is drawn through this endpoint. Connect the calls to ${asString(p.ServiceName)?.split(".").pop() ?? "the service"} that should use it.`)
}

/** A function with `VpcConfig` sits in the box of the VPC that owns its subnets. */
export const attachToVpc = (run: Run, fn: Draft, config: Bag): void => {
  const subnets = referencesIn(config.SubnetIds).map((id) => run.resources.get(id)).filter((r): r is Resource => r?.type === "AWS::EC2::Subnet")
  const vpcs = [...new Set(subnets.map((s) => vpcOfSubnet(run, s)).filter((v): v is Draft => v !== undefined))]
  if (vpcs.length === 0) {
    run.warn(`${fn.name} is attached to a VPC (VpcConfig), but its subnets aren't in this template, so it isn't drawn inside one.`)
    return
  }
  if (vpcs.length > 1) run.warn(`${fn.name}'s subnets are in ${vpcs.length} VPCs; it is drawn in ${vpcs[0]!.name}.`)
  fn.parent = vpcs[0]!
}
