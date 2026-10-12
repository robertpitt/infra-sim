import * as Setting from "../../Setting.ts"
import { docs } from "../docs.ts"

/** The quotas page of the EventBridge user guide (Custom Event Bus - Classic quotas); the general reference agrees. */
export const QUOTAS_PAGE = `${docs.eventbridge}eb-quota.html`

/**
 * `PutEvents` requests per second, per account and Region, by tier (Regions not listed get 400). The invocation quota
 * below is 1.875 times this in every tier.
 */
const PUT_EVENTS: ReadonlyArray<readonly [rate: number, regions: ReadonlyArray<string>]> = [
  [10_000, ["us-east-1", "us-west-2", "eu-west-1"]],
  [2_400, ["us-east-2", "eu-central-1", "eu-south-2"]],
  [1_200, ["us-west-1", "ap-northeast-1", "ap-southeast-1", "ap-southeast-2", "eu-west-2"]],
  [600, ["ap-east-1", "ap-northeast-2", "ap-south-1", "ca-central-1", "eu-north-1", "eu-west-3", "sa-east-1"]]
]
const PUT_EVENTS_DEFAULT = 400

/** Target invocations per second, per account and Region, by tier (Regions not listed get 750). */
const INVOCATIONS: ReadonlyArray<readonly [rate: number, regions: ReadonlyArray<string>]> = [
  [18_750, ["us-east-1", "us-west-2", "eu-west-1"]],
  [4_500, ["us-east-2", "eu-central-1", "eu-south-2"]],
  [2_250, ["us-west-1", "ap-northeast-1", "ap-southeast-1", "ap-southeast-2", "eu-west-2"]],
  [1_100, ["ap-east-1", "ap-northeast-2", "ap-south-1", "ca-central-1", "eu-north-1", "eu-west-3", "sa-east-1"]]
]
const INVOCATIONS_DEFAULT = 750

/** Rules per event bus: 300, except Cape Town and Milan, which have 100. */
const SMALL_RULE_REGIONS = new Set(["af-south-1", "eu-south-1"])

const tier = (table: ReadonlyArray<readonly [number, ReadonlyArray<string>]>, fallback: number) => (region: string): number =>
  table.find(([, regions]) => regions.includes(region))?.[0] ?? fallback

export const putEventsRate = tier(PUT_EVENTS, PUT_EVENTS_DEFAULT)
export const invocationRate = tier(INVOCATIONS, INVOCATIONS_DEFAULT)
export const rulesPerBus = (region: string): number => (SMALL_RULE_REGIONS.has(region) ? 100 : 300)
/** Event buses per account in a Region: 100, adjustable. AWS doesn't say whether the default bus counts; the audit counts the buses drawn. */
export const EVENT_BUSES = 100

/**
 * The account-level quotas the event bus contributes, each an editable setting whose default is AWS's number for the
 * Region. They are merged into the provider's account form (`../account.ts`).
 */
export const quotas = (region: string) => ({
  eventBridgePutEventsRate: Setting.int({
    default: putEventsRate(region),
    min: 1,
    max: 10_000_000,
    unit: "req/s",
    label: "EventBridge PutEvents rate",
    help: "PutEvents requests per second across every event bus in this region. AWS's quota counts requests, so a request of 10 entries uses one. Requests over it are throttled (ThrottlingException).",
    limit: Setting.quota(QUOTAS_PAGE)
  }),
  eventBridgeInvocationRate: Setting.int({
    default: invocationRate(region),
    min: 1,
    max: 10_000_000,
    unit: "inv/s",
    label: "EventBridge invocation rate",
    help: "Target invocations per second across every rule in this region: one per target per matched event. Invocations over it are delayed, not refused.",
    limit: Setting.quota(QUOTAS_PAGE)
  }),
  eventBridgeRulesPerBus: Setting.int({
    default: rulesPerBus(region),
    min: 1,
    max: 100_000,
    unit: "rules",
    label: "EventBridge rules per bus",
    help: "Rules one event bus may have. Rules wired past it are left out (AWS refuses to create them).",
    limit: Setting.quota(QUOTAS_PAGE)
  }),
  eventBridgeBuses: Setting.int({
    default: EVENT_BUSES,
    min: 1,
    max: 100_000,
    unit: "buses",
    label: "EventBridge event buses",
    help: "Event buses one account may have in this region.",
    limit: Setting.quota(QUOTAS_PAGE)
  })
})
