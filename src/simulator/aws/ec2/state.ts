import { Schema } from "effect"

/** One instance, as the probe reports it. */
export const InstanceReport = Schema.Struct({
  name: Schema.String,
  zone: Schema.optionalKey(Schema.String),
  state: Schema.String,
  phase: Schema.optionalKey(Schema.String),
  purchase: Schema.String,
  start: Schema.String,
  alive: Schema.Boolean,
  broken: Schema.Boolean,
  busy: Schema.Number,
  queued: Schema.Number
})

/** What the group's probe reports. */
export const State = Schema.Struct({
  desired: Schema.Number,
  inService: Schema.Number,
  pending: Schema.Number,
  draining: Schema.Number,
  onDemand: Schema.Number,
  spot: Schema.Number,
  /** vCPUs the group and its warm pool hold against the region's quotas. */
  vcpus: Schema.Number,
  warmPool: Schema.Struct({ ready: Schema.Number, preparing: Schema.Number, target: Schema.Number }),
  busy: Schema.Number,
  queued: Schema.Number,
  served: Schema.Number,
  errors: Schema.Number,
  refused: Schema.Number,
  /** Requests that failed because their instance was lost: terminated, cut off, its zone down. */
  lost: Schema.Number,
  launched: Schema.Number,
  warmStarts: Schema.Number,
  /** Launches EC2 refused: the vCPU quota, or no Spot capacity. */
  refusedLaunches: Schema.Number,
  replaced: Schema.Number,
  spotInterruptions: Schema.Number,
  instances: Schema.Array(InstanceReport)
})
