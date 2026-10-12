# Region (`aws.region`)

An AWS Region is a physical location with several isolated Availability Zones, and the unit AWS uses for almost
everything that matters to a design: where a service runs, whose quotas it counts against, what a regional outage takes
down. In the simulator a Region is a **box drawn round other components**. Dropping a component into the box places it
in that Region, and the box's own panel holds the account quotas that everything inside shares. It has no ports and
takes no part in traffic. What you can learn from it: how far apart two Regions are (and so what a cross-Region call
costs), which quotas you are sharing, and what a regional outage does to a multi-Region design.

## Coverage

| Feature | Status | Notes |
| --- | --- | --- |
| **Placement** | | |
| Region list | ✅ | The 34 commercial-partition Regions of the AWS table, in `catalog.ts`. The provider's own list (`../regions.ts`) is missing two of them: see Not yet simulated |
| Box decides the Region of its contents | ✅ | Nested containers (a VPC) inherit it. A node whose own Region disagrees is a `region-mismatch` error |
| Only AWS components fit; not another Region | ✅ | A component that must sit in a VPC (NAT gateway, VPC endpoint) is refused straight in the box |
| Default Region (`us-east-1`) for a component with no box | ✅ | Engine behaviour |
| **Network** | | |
| Latency between Regions from distance | 🟡 | Engine estimate (great-circle distance, 200 km/ms, x1.35 route factor); AWS publishes no inter-Region latency. Editable per edge |
| Latency inside a Region | 🟡 | 1 ms, an estimate; 0.5 ms more between two nodes placed in different zones (assumed: AWS says zones are up to ~100 km apart with single-digit millisecond latency) |
| **Availability Zones** | | |
| Zones of each Region | ✅ | Named `us-east-1a`... as AWS names them, as many as the Regions table lists (`catalog.ts`, engine `Region.zones`) |
| A node in one zone | ✅ | `zone: us-east-1a` on the node (engine). No AWS component uses it yet; the NAT gateway still has its own `zone` setting |
| **Quotas** | | |
| Account quotas shown and edited in the box | ✅ | Each service contributes its own (`../<service>/quotas.ts`); the box is where the panel lives |
| Quotas differ by Region | 🟡 | Only where a service supplies per-Region defaults (Lambda, API Gateway). Others are one number everywhere |
| **Failure modes** | | |
| Regional outage, slowdown, errors | ✅ | Inject a fault on `aws:<region>`: every node inside is affected (engine, `Fault.ts`) |
| Single Availability Zone failure | ✅ | Inject a fault on `zone:aws:<region>:<zone>` (`zone:aws:us-east-1:us-east-1a`) (the box's Faults panel, "Where"): nodes placed in that zone and the units fleets run there are affected (engine) |
| **Account** | | |
| Opt-in Regions | 🟡 | A design using one of the 17 opt-in Regions gets an info note that the account must enable it. Not enforced |
| Several accounts, GovCloud, China partitions | ❌ | One account per Region; the other partitions are separate AWS accounts and not offered |

## Settings

| Setting | Default | Range | Kind | Models |
| --- | --- | --- | --- | --- |
| `region` | `us-east-1` | one of the provider's Regions | hard (the Region list is AWS's) | Which Region the box is. Everything inside runs there |

The box's panel also shows the account quotas (one set per Region): see each service's README, and the VPC README for
the VPC ones.

## Limits

| Limit | Value | Kind | Source |
| --- | --- | --- | --- |
| Regions in the commercial partition | 34 | hard | [AWS Regions](https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html) |
| Availability Zones | 3 in most; 6 in us-east-1; 4 in us-west-2, ap-northeast-1, ap-northeast-2. us-west-1 shows 3 but newer accounts get 2 | hard | same page |
| Regions disabled by default | 17: every Region launched after 20 March 2019 | hard | same page |
| Latency between Regions | derived from distance | assumed | engine, `Provider.ts` |

The 17 Regions that need enabling are af-south-1, ap-east-1, ap-east-2, ap-south-2, ap-southeast-3, -4, -5, -6, -7,
ca-west-1, eu-central-2, eu-south-1, eu-south-2, il-central-1, me-central-1, me-south-1, mx-central-1.

## Behaviour

The box itself does nothing at run time. The engine applies a Region in three places:

1. **Placement.** `Design.resolve` gives every node a `placement` of provider and Region: the nearest container above
   it that decides a Region (this box), else the node's own `region`, else the provider default. A container inside a
   Region (a VPC) inherits it. A node that names a different Region than its box is rejected with `region-mismatch`.
2. **Latency.** An edge's default network latency is `1 ms` inside a Region and `1 + distance / 200 km/ms * 1.35`
   between Regions (plus transit when crossing providers). The distance uses the coordinates in `catalog.ts`; they are
   the main city of each Region, not a data-centre address, so two Regions in the same country differ by a few
   milliseconds at most. Any edge can override it.
3. **Quotas and faults.** Nodes in the same placement share one account's quotas and are hit together by a regional
   fault. Two boxes for the same Region are one set of quotas, which is why the duplicate gets a warning.

## Connections

None. A Region box has no ports and cannot be wired. Its `container.accepts` takes any AWS component that can sit
straight in a Region; the CloudFormation importer places a stack's resources in a box for the stack's Region, and adds a box for each other Region a global table has a replica in.

## Metrics and state

None: the box is not a traffic node. Diagnostics it contributes (through the audit that runs with the VPC folder's):

| Code | Level | When |
| --- | --- | --- |
| `region-opt-in` | info | Something runs in a Region that is disabled by default |
| `region-duplicate-box` | warning | Two Region boxes name the same Region |

## Not yet simulated

1. **Availability Zones in the AWS components.** The engine has zones now (a node's `zone`, zone faults, fleets that spread
   over zones: see `SIMULATOR.md`). What is left is using them: a NAT gateway's `zone` setting (a letter) should become the
   node's zone, an interface endpoint should have a network interface per zone, a function in a VPC should run in the
   zones of its subnets, and `Member` in `Provider.ts` should carry the zone and the parent container so audits can count
   per zone and per VPC.
2. **Two newer Regions in the provider's list.** `../regions.ts` (outside this folder) lacks `ap-east-2` (Taipei) and
   `ap-southeast-6` (New Zealand). `catalog.ts` has all 34 and exports `regions` in the provider's shape: replacing the
   body of `../regions.ts` with `export { regions } from "./region/catalog.ts"` fixes it and makes the catalog the one
   source. `Region.test.ts` allows the two to be missing there today and passes either way once they appear (its allowance can then be deleted).
3. **Inter-Region latency from measurement.** AWS publishes none; the distance model is an estimate. Per-pair
   overrides would need a table in the provider.
4. **Region-scoped service availability** (a service not offered in a Region, such as a newer Lambda feature). AWS has
   a per-Region service list; nothing here checks it.
5. **Account-level facts per Region** that are not quotas: opt-in status is a note, not a gate.

## Assumptions

- Coordinates are the main city of each Region (an approximation; AWS does not publish data-centre locations).
- The names ("N. Virginia", "Ohio", ...) are the shorthand the simulator has always used, kept so saved designs and the
  UI read the same. AWS's long names differ ("US East (N. Virginia)").
- Latency between Regions is the engine's distance estimate, not an AWS figure.

## References

- [AWS Regions](https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html): the list, zones, opt-in status
- [AWS Global Infrastructure: Regions and Availability Zones](https://aws.amazon.com/about-aws/global-infrastructure/regions_az/)
