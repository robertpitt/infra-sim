/**
 * The simulator: a pure-Effect engine for architecture simulations. No DOM, no React.
 *
 * Hosts talk to `Engine`. Everything else is here for components, tools and tests.
 */
export * as Builder from "./Builder.ts"
export * as Component from "./Component.ts"
export * as Describe from "./Describe.ts"
export * as Design from "./Design.ts"
export * as Diagnostics from "./Diagnostics.ts"
export * as Distribution from "./Distribution.ts"
export * as Edge from "./Edge.ts"
export * as Engine from "./Engine.ts"
export * as Fault from "./Fault.ts"
export * as Limiter from "./Limiter.ts"
export * as Provider from "./Provider.ts"
export * as Layout from "./Layout.ts"
export * as Message from "./Message.ts"
export * as Registry from "./Registry.ts"
export * as SeededRandom from "./SeededRandom.ts"
export * as Setting from "./Setting.ts"
export * as Simulation from "./Simulation.ts"
export * as Telemetry from "./Telemetry.ts"
export * as Topology from "./Topology.ts"
export * as VirtualTime from "./VirtualTime.ts"
export type { Diagnostic } from "./Diagnostic.ts"
export { builtins, layer as builtinLayer, providers, registry } from "./components/index.ts"
