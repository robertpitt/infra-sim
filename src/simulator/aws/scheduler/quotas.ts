import * as Setting from "../../Setting.ts"
import { docs } from "../docs.ts"

export const QUOTAS_PAGE = `${docs.scheduler}scheduler-quotas.html`

/** The Regions whose Scheduler invocation quota is 1,000 a second; every other Region gets 500. */
const LARGE = new Set(["us-east-1", "us-east-2", "us-west-2", "ap-northeast-1", "ap-south-1", "ap-southeast-1", "ap-southeast-2", "eu-central-1", "eu-west-1", "eu-west-2", "sa-east-1"])

/** Schedule invocations per second, per account and Region. */
export const schedulerInvocationRate = (region: string): number => (LARGE.has(region) ? 1_000 : 500)
/** Schedules per account and Region, whatever the Region: 10,000,000 (one-time schedules that have run still count). */
export const SCHEDULES = 10_000_000

/**
 * The account-level quotas EventBridge Scheduler contributes, each an editable setting whose default is AWS's number
 * for the Region. They are merged into the provider's account form (`../account.ts`).
 */
export const quotas = (region: string) => ({
  schedulerInvocationRate: Setting.int({
    default: schedulerInvocationRate(region),
    min: 1,
    max: 10_000_000,
    unit: "inv/s",
    label: "Scheduler invocation rate",
    help: "Target invocations per second across every schedule in this region. Invocations over it are delayed, not refused (InvocationThrottleCount).",
    limit: Setting.quota(QUOTAS_PAGE)
  }),
  schedulerSchedules: Setting.int({
    default: SCHEDULES,
    min: 1,
    max: 1_000_000_000,
    unit: "schedules",
    label: "Scheduler schedules",
    help: "Schedules one account may have in this region.",
    limit: Setting.quota(QUOTAS_PAGE)
  })
})
