# VPC (`aws.vpc`, `aws.nat-gateway`, `aws.vpc-endpoint`)

Amazon VPC is a private network in a Region. A function attached to one reaches private resources through it, and
reaches everything else (the internet, AWS services) only through what the VPC provides: a NAT gateway for the
internet, VPC endpoints for AWS services. The simulator has three components. The **VPC** is a box inside a Region that
holds the resources attached to it and the address plan. The **NAT gateway** and the **VPC endpoint** are traffic
nodes you wire between a function and what it calls, and they carry the limits that matter in practice: 55,000
simultaneous connections per address and destination, port allocation errors, and bandwidth. What you can learn: how
fast a design runs out of NAT ports, whether the address plan fits, which VPC quotas a design hits, and that a NAT
gateway in one zone is a single point of failure for everything routed through it.

## Coverage

| Feature | Status | Notes |
| --- | --- | --- |
| **The VPC box** | | |
| Sits in a Region, inherits its placement | ✅ | `within: aws.region`; no nesting |
| Holds only VPC resources | ✅ | Those in `IN_VPC` (`Vpc.ts`): Lambda, NAT gateway, VPC endpoint, RDS and RDS Proxy, ElastiCache, OpenSearch. S3, DynamoDB, SQS, SNS, SES, API Gateway and CloudFront are regional services outside any VPC and are refused |
| IPv4 block /16 to /28, address counts | ✅ | `cidrPrefix`; the probe reports addresses and usable addresses |
| Subnet plan (zones x subnets, size, 5 reserved addresses) | 🟡 | Optional, audit-only: fit in the block, subnets per VPC quota, zones the Region has. No subnet exists as a node and no function is assigned to one |
| Secondary CIDR blocks, IPv6, route tables, security groups, NACLs, peering, transit gateway | ❌ | Not modelled |
| Latency between components in a VPC | 🟡 | Same-Region edge latency (1 ms estimate); a VPC adds none |
| **Account quotas** (editable in the Region box) | | |
| VPCs per Region, subnets per VPC, NAT gateways per AZ, addresses per NAT gateway, Elastic IPs, gateway endpoints per Region, interface endpoints per VPC | ✅ | `quotas.ts`; checked by `audit.ts` (some per Region, see Behaviour) |
| **NAT gateway** | | |
| Connection limit: 55,000 per address per destination | ✅ | Per wired destination; each address adds 55,000; refusals are `ErrorPortAllocation` |
| Up to 8 IPv4 addresses, quota of 2 by default | ✅ | Setting is hard-capped at 8; the audit warns above the account quota |
| Bandwidth 5 Gbps scaling to 100 Gbps | 🟡 | Enforced as a per-second byte bucket at the configured value. The scaling itself is not modelled (AWS publishes no schedule) |
| Packets per second (1 M, scaling to 10 M) | ❌ | Bandwidth binds first for all but tiny packets. Needs a packet size model |
| Idle connection timeout (350 s) and keep-alive reuse | ❌ | Only calls in flight count as connections |
| Zonal: one zone, outage takes it down | 🟡 | `zone` setting, per-zone quota, zone must exist in the Region; zone failure is a node outage fault on the gateway. No zone fault target |
| Regional NAT gateway (automatic multi-AZ) | ❌ | Newer AWS mode; see backlog |
| Private NAT gateway | ❌ | Public only |
| **VPC endpoints** | | |
| Gateway endpoint (S3, DynamoDB): free, no hop, no published limit | ✅ | Adds no latency or limit |
| Interface endpoint (PrivateLink): hop, 10 Gbps per zone scaling to 100 | 🟡 | Added hop latency (assumed) and per-zone bandwidth; the scaling is not modelled |
| Endpoint policies, private DNS, MTU 8,500 | ❌ | |
| **Lambda in a VPC** | | |
| Which functions are in a VPC | ✅ | A function inside the box |
| Hyperplane ENIs: IP and connection capacity | ❌ | See Behaviour and backlog |
| Cold start effect | ✅ (none) | AWS: the network interface is created when the function is configured, not per invocation. Nothing is added to a cold start |
| A function in a VPC cannot reach the internet without a NAT gateway | ❌ | Not enforced: see backlog for the engine change |
| **Failure modes** | | |
| Outage, errors, slowness on a NAT gateway or endpoint | ✅ | Ordinary node faults |
| Single Availability Zone failure | ❌ | Needs zones in the engine: see Region README |

## Settings

### `aws.vpc`

| Setting | Default | Range | Kind | Models |
| --- | --- | --- | --- | --- |
| `cidrPrefix` | 16 | 16 to 28 | hard | The VPC's IPv4 block: /16 is 65,536 addresses, /28 is 16 |
| `subnets.enabled` | off | | | Turns the subnet plan on. Off leaves the VPC a plain boundary, as before |
| `subnets.availabilityZones` | 2 | 1 to 6 | assumed | Zones the subnets are spread over; checked against the Region's zone count |
| `subnets.subnetsPerZone` | 2 | 1 to 200 | assumed | For example one public, one private |
| `subnets.prefix` | 24 | 16 to 28 | hard | Size of every subnet; 5 addresses are reserved in each |

### `aws.nat-gateway`

| Setting | Default | Range | Kind | Models |
| --- | --- | --- | --- | --- |
| `zone` | a | a to f | hard (zones are lettered; no Region has more than 6) | The zone the gateway is in; counted against the per-zone quota |
| `addresses` | 1 | 1 to 8 | hard | IPv4 addresses: 1 primary and up to 7 secondary |
| `connectionsPerDestination` | 55,000 | 1 to 55,000 | hard | Simultaneous connections one address supports to one destination. Lowering it is a modelling aid |
| `bandwidth` | 5 Gbps | 5 to 100 | hard | What the gateway carries now; raise it to model one that has scaled |
| `routing` | weighted | weighted, sequential, parallel | modelling | How a call chooses among several wired destinations (a call carries no address) |
| `latency` | 0.3 ms, cv 0.3 | | assumed | Time the gateway adds to a call |

### `aws.vpc-endpoint`

| Setting | Default | Range | Kind | Models |
| --- | --- | --- | --- | --- |
| `type` | gateway | gateway, interface | | A route to S3/DynamoDB, or a PrivateLink network interface |
| `availabilityZones` | 2 | 1 to 6 | assumed | Interface only: zones with an interface; bandwidth is per zone |
| `bandwidth` | 10 Gbps per zone | 10 to 100 | hard | Interface only |
| `latency` | 0.5 ms, cv 0.3 | | assumed | Interface only: the extra hop. A gateway endpoint adds none |

### Account quotas (in the Region box)

| Field | Default | Kind | Used by |
| --- | --- | --- | --- |
| `vpcPerRegion` | 5 | quota | VPC boxes in the Region |
| `vpcSubnetsPerVpc` | 200 | quota | A VPC's subnet plan |
| `vpcNatGatewaysPerAz` | 5 | quota | NAT gateways with the same `zone` |
| `vpcNatAddressesPerGateway` | 2 | quota (up to 8) | A gateway's `addresses` |
| `vpcElasticIpsPerRegion` | 5 | quota | Sum of the NAT gateways' addresses |
| `vpcGatewayEndpointsPerRegion` | 20 | quota | Gateway endpoints in the Region |
| `vpcInterfaceEndpointsPerVpc` | 50 | quota | Interface endpoints, against the number of VPCs |

## Limits

| Limit | Value | Kind | Source |
| --- | --- | --- | --- |
| IPv4 VPC and subnet block size | /16 (65,536) to /28 (16) | hard | [VPC CIDR blocks](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-cidr-blocks.html), [Subnet CIDR blocks](https://docs.aws.amazon.com/vpc/latest/userguide/subnet-sizing.html) |
| Reserved addresses per subnet | 5: first four and the last | hard | [Subnet CIDR blocks](https://docs.aws.amazon.com/vpc/latest/userguide/subnet-sizing.html) |
| VPCs per Region | 5, adjustable | quota | [VPC quotas](https://docs.aws.amazon.com/vpc/latest/userguide/amazon-vpc-limits.html) |
| Subnets per VPC | 200, adjustable | quota | same |
| NAT gateways per Availability Zone | 5, adjustable | quota | same |
| Elastic IP addresses per public NAT gateway | 2, adjustable to 8 | quota | same |
| Elastic IP addresses per Region | 5, adjustable | quota | same |
| Gateway endpoints per Region | 20, adjustable; up to 255 per VPC | quota | [PrivateLink quotas](https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-limits-endpoints.html) |
| Interface and Gateway Load Balancer endpoints per VPC | 50, adjustable | quota | same |
| NAT gateway bandwidth | 5 Gbps, scales to 100 Gbps | hard | [NAT gateway basics](https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateway-basics.html) |
| NAT gateway packets per second | 1 million, scales to 10 million; beyond it packets are dropped | hard (not simulated) | same |
| NAT simultaneous connections | 55,000 per IPv4 address per unique destination (IP, port, protocol) | hard | same |
| IPv4 addresses per NAT gateway | 8 (1 primary + 7 secondary) | hard | same |
| NAT gateway idle timeout | 350 seconds, then RST (not simulated) | hard | [NAT troubleshooting](https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateway-troubleshooting.html) |
| Endpoint bandwidth | 10 Gbps per zone, scales to 100 Gbps | hard | [PrivateLink quotas](https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-limits-endpoints.html) |
| Endpoint and NAT MTU | 8,500 bytes (not simulated) | hard | same, NAT basics |
| Hyperplane ENI | up to 65,000 connections/ports each; shared by functions with the same subnet and security group combination | hard (not simulated) | [Lambda VPC](https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc.html) |
| Network interfaces per Region | 5,000 per zone, adjustable | quota (not simulated) | VPC quotas |

AWS publishes the VPC defaults as one number for all Regions; the page's own caveat is that a quota raised "per
resource" is raised for every resource in the Region.

## Behaviour

**Containment.** A VPC sits in a Region box (`within: aws.region`) and accepts the VPC resources listed in `IN_VPC`:
Lambda functions, NAT gateways, VPC endpoints, databases (RDS, RDS Proxy), caches (ElastiCache) and search domains
(OpenSearch). Those last ones may also sit straight in the Region box, for a design that doesn't draw the VPC. Everything
else is a regional service with public endpoints, reached from inside a VPC through a NAT gateway or an endpoint, and
cannot be dropped in. The VPC inherits its Region from the box; so does everything in it.

**Address plan.** A block of prefix `p` holds `2^(32-p)` addresses. Every subnet loses five (the first four and the
last), so a /24 subnet offers 251 and a /28 offers 11. With the subnet plan on, equal-size subnets pack a
power-of-two block exactly, so the plan fits when `zones x subnetsPerZone x 2^(32-subnetPrefix)` does not exceed the
VPC's block. The audit reports a plan that does not fit, more subnets than the quota, and more zones than the Region has.
The probe returns `addresses`, `usablePerSubnet`, `subnets` and `usableAddresses`.

**NAT gateway.** Per call, in order:

1. Bandwidth: the call's bytes are taken from a bucket refilling at `bandwidth` Gbps (a one second burst). If it is
   empty the call fails `Throttled` ("out of bandwidth: packets dropped") and counts in `drops`. AWS has no 429: a real
   gateway drops packets and the client sees retransmits then timeouts. `Throttled` is the closest tag that makes
   retry policy behave like a capacity problem.
2. Wait the gateway's processing latency (assumed 0.3 ms).
3. Pick the destination (by edge weight, or all of them in sequence or in parallel) and take a connection to it. Each
   wired edge is a unique destination. The limit is `connectionsPerDestination x addresses`. When the destination has
   that many connections open, the new one fails `Throttled` ("ErrorPortAllocation") and counts in the
   `ErrorPortAllocation` rate, named after the CloudWatch metric.
4. The connection is held until the call finishes, fails, times out or is cancelled, then released.

A call carries no destination address, so which edge a call uses is a modelling choice (`routing`). Connections held
by an idle keep-alive socket are not tracked: only in-flight calls count, which makes the limit harder to reach than
in reality and so understates the risk.

**VPC endpoint.** A gateway endpoint is a route: no latency, no limit. An interface endpoint adds a hop (assumed
0.5 ms) and carries `bandwidth x availabilityZones` Gbps, dropping beyond it like the NAT gateway. It has no connection
limit because AWS publishes none for endpoints.

**Lambda in a VPC.** AWS attaches a function through Hyperplane network interfaces: one per distinct subnet and
security group combination, shared by every function that uses it, each good for 65,000 connections and scaled by
Lambda as traffic and concurrency need. They are created when the function is created or updated (the function is
`Pending` for up to minutes), not on invoke, and Lambda reclaims them after 14 idle days. So the simulator adds
**nothing** to a function's cold start for being in a VPC, which matches the current documentation. What a VPC does
change is the way out: see the backlog.

**Audits** (`audit.ts`) run for each Region over everything in it. Members do not say which VPC a node is in, so a
quota counted per VPC is checked per VPC only where a VPC's own settings decide it (its subnet plan). Interface
endpoints per VPC use the strongest check that is certain without that knowledge: more than quota times the number
of VPCs. NAT gateways per zone are counted per Region and zone, which is how AWS counts them for an account.

| Code | Level | When |
| --- | --- | --- |
| `vpc-quota` | warning | More VPC boxes in a Region than `vpcPerRegion` |
| `vpc-subnets-do-not-fit` | warning | The subnet plan needs more addresses than the block has |
| `vpc-subnet-quota` | warning | The plan has more subnets than `vpcSubnetsPerVpc` |
| `vpc-zones` | warning | The plan or a NAT gateway names a zone the Region does not have |
| `vpc-nat-zone` | warning | A NAT gateway's `zone` is beyond the Region's zones |
| `vpc-nat-quota` | warning | More than `vpcNatGatewaysPerAz` gateways in one zone |
| `vpc-nat-addresses` | warning | A gateway's `addresses` exceed `vpcNatAddressesPerGateway` |
| `vpc-elastic-ips` | warning | The gateways' addresses add up to more than `vpcElasticIpsPerRegion` |
| `vpc-gateway-endpoint-quota` | warning | More gateway endpoints than `vpcGatewayEndpointsPerRegion` |
| `vpc-interface-endpoint-quota` | warning | More interface endpoints than fit even spread across the VPCs |
| `region-opt-in`, `region-duplicate-box` | info, warning | See the Region README |

They are warnings, not errors: the design still runs, the numbers AWS would refuse are simply exceeded.

## Connections

- **VPC**: no ports. Place its resources in it (see Containment). A resource's Region comes from the box.
- **NAT gateway**: one input (call it), one output `out` ("Destinations": the external things it reaches). The
  output's edge settings are the usual ones (network latency, timeout, retry); each edge is one destination for the
  connection limit.
- **VPC endpoint**: the same, with the output "Service" pointing at the AWS service (S3, DynamoDB, SQS, ...).
- **Typical wiring**: Lambda -> NAT gateway -> HTTP endpoint (the internet); Lambda -> gateway endpoint -> S3.
- **CloudFormation import** (`importers/cloudformation/vpc.ts`): `AWS::EC2::VPC` -> `aws.vpc` with `cidrPrefix` from
  `CidrBlock` (an IPAM-allocated block, unknown until deploy, keeps the default and is listed under unresolved), inside
  the stack's Region box. `AWS::EC2::Subnet` -> not a node: it joins its VPC's subnet plan and `subnets` is enabled,
  with `availabilityZones` the number of distinct `AvailabilityZone` values, `subnetsPerZone` the most in any zone, and
  `prefix` the most common `CidrBlock` prefix. Subnets that differ in number per zone or in size are approximated and
  reported; a subnet whose VPC isn't in the template is skipped. `AWS::EC2::NatGateway` -> `aws.nat-gateway` inside the
  VPC of its subnet, with `zone` from the subnet's `AvailabilityZone` and `addresses` = `AllocationId` plus
  `SecondaryAllocationIds`; a `ConnectivityType: private` gateway, or one whose subnet or VPC isn't in the template, is
  reported as having no component. `AWS::EC2::VPCEndpoint` -> `aws.vpc-endpoint` with `type` from `VpcEndpointType`
  (Gateway or Interface) and, for an interface endpoint, `availabilityZones` from the zones of its `SubnetIds`;
  GatewayLoadBalancer endpoints are reported as having no component. `AWS::Lambda::Function` with `VpcConfig.SubnetIds`
  is drawn inside the VPC that owns those subnets (the first, with a report, if they span several VPCs; left in the
  Region, with a report, if the subnets aren't in the template). Route tables, security groups, internet gateways,
  attachments, EIPs and network ACLs are skipped quietly. **Routes are not read**, so nothing is drawn through a NAT
  gateway or endpoint: the report says so, and you connect the calls that should use them.

## Metrics and state

| Name | Component | Kind | Meaning |
| --- | --- | --- | --- |
| `connections` | NAT gateway | gauge | Connections open now, summed over destinations (ActiveConnectionCount) |
| `connectionAttempts` | NAT gateway | rate | New connections asked for, one per call to a destination (ConnectionAttemptCount) |
| `connectionsEstablished` | NAT gateway | rate | Of those, the ones given a source port (ConnectionEstablishedCount) |
| `ErrorPortAllocation` | NAT gateway | rate | New connections refused for want of a free port (ErrorPortAllocation) |
| `busiestDestination` | NAT gateway | gauge | Connections open to the destination with the most |
| `portLimit` | NAT gateway | gauge | Simultaneous connections the addresses allow to one destination |
| `drops` | NAT gateway, interface endpoint | rate | Calls dropped for want of bandwidth (PacketsDropCount, PacketsDropped: calls, not packets) |
| `bytes` | NAT gateway, endpoint | rate | Bytes carried, requests only (BytesOutToDestination and BytesInFromSource; BytesProcessed) |

The endpoint's `in` and `inflight` (the framework's) stand for an interface endpoint's NewConnections and ActiveConnections.
AWS publishes no metrics for gateway endpoints. The dashboards (`dashboard.ts`) chart these as CloudWatch does, with the
NAT gateway's ports used to its busiest destination (`busiestDestination` over `portLimit`) to read them against.

Probe state: **VPC**: `addresses`, `usablePerSubnet`, `subnets`, `usableAddresses`. **NAT gateway**: `connections`,
`busiest` (the most open to one destination), `limit`, `portAllocationErrors`, `drops`, `bytes`. **VPC endpoint**:
`bytes`, `drops`. The framework also records `in`, `ok`, `fail`, `fail.<Tag>` and `latency` for the NAT gateway and
endpoint.

## Not yet simulated

1. **Availability Zones** (first, and the most valuable). Needs the engine: a zone in `Placement`, a `zone` fault
   target beside `region` in `Fault.ts`, and zone plus parent container on `Member` in `Provider.ts`. Then a zone
   failure takes down that zone's NAT gateway, endpoint interfaces and functions together; a design with one NAT gateway
   shows the cross-zone loss of internet AWS describes; subnets in a zone become real. Today only an outage on the NAT
   gateway node stands in for it.
2. **A function in a VPC cannot reach the internet without a NAT gateway; AWS services need an endpoint or a NAT.**
   Today a Lambda in a VPC wired straight to an external endpoint works. Enforcing it needs the engine to tell a
   component which container it is in (a `parent` or `container` on `Component.Node`) and the destination's placement
   or kind, so `Lambda.call` (or the edge layer, from a container `route` hook on `Component.Container`) can refuse a
   call that leaves the VPC without passing a NAT gateway or endpoint, as a connection timeout like AWS's. Short of
   that, a diagnostic needs the design's edges and parents in the `Provider.audit` arguments.
3. **Hyperplane ENIs and IP capacity.** The limits (65,000 connections per ENI, one ENI per subnet and security group
   combination, an IP address per ENI taken from the subnet) are known; modelling them needs the function-to-subnet
   assignment, so a function's subnets and their usable addresses can be counted. A subnet running out of addresses is
   then a diagnostic. Needs item 1's engine work (parent on `Member`) and a subnet assignment on the function.
4. **Regional NAT gateway** (automatic multi-AZ, up to 32 addresses per zone, up to 60 minutes to expand to a new
   zone): a mode on the NAT gateway once zones exist.
5. **NAT packets per second** and **idle connection timeout / keep-alive reuse**: needs a packet size and a
   connection-reuse model on the caller.
6. **Interface endpoint connection details**, private DNS, endpoint policies; **VPC peering, transit gateway,
   Site-to-Site VPN, Direct Connect**; **secondary CIDR blocks and IPv6**: no component for them yet.
7. **Network interfaces per Region quota** (5,000 per zone): counts every ENI in the account, which depends on item 3.
8. **Scaling of NAT and endpoint bandwidth over time**: AWS publishes only the start and end values.

## Assumptions

- NAT gateway processing latency 0.3 ms and interface endpoint hop latency 0.5 ms (AWS publishes none; both
  are well under the 1 ms intra-Region estimate in the edge).
- A NAT gateway and an endpoint stay at the configured bandwidth; no scaling schedule is published.
- Only in-flight calls hold NAT connections (no idle keep-alive connections).
- A call crossing a NAT gateway counts its bytes once toward bandwidth (the request), not the response.
- Default subnet plan of 2 zones x 2 subnets of /24 is a common layout (public and private per zone), not an AWS figure.
- The Region's zone count comes from the AWS table; it ignores that newer us-west-1 accounts have 2.

## References

- [VPC quotas](https://docs.aws.amazon.com/vpc/latest/userguide/amazon-vpc-limits.html)
- [VPC CIDR blocks](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-cidr-blocks.html)
- [Subnet CIDR blocks](https://docs.aws.amazon.com/vpc/latest/userguide/subnet-sizing.html)
- [NAT gateways](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html), [basics](https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateway-basics.html), [Regional NAT gateways](https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateways-regional.html), [troubleshooting](https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateway-troubleshooting.html)
- [AWS PrivateLink quotas](https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-limits-endpoints.html), [S3 gateway endpoints](https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-s3.html)
- [Lambda: giving functions access to a VPC](https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc.html), [internet access for VPC-connected functions](https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc-internet.html)
