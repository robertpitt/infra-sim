import type * as Design from "../Design.ts"
import type { Components } from "../Registry.ts"

/**
 * An importer turns someone else's description of infrastructure (a CloudFormation template, later Terraform or CDK
 * output) into a design. It is a pure function from text to a `Doc` plus a `report` that says what happened to each
 * thing in the source: converted, adjusted, inferred, or left out and why. The report is what makes an import
 * trustworthy: nothing is dropped silently.
 */
export interface ImportOptions {
  /** The region to run everything in, for sources that don't say. Default `us-east-1`. */
  readonly region?: string
  /** The design's name. Defaults to the file's name. */
  readonly name?: string
  /** The file the text came from, for naming and provenance. */
  readonly fileName?: string
  /** Requests per second for the traffic sources added where the source has no traffic of its own. Default 20. */
  readonly rps?: number
}

export interface ImportReport {
  readonly importer: string
  /** Resources that became components. `id` is the source's own name for it, `node` the id it has in the design. */
  readonly converted: ReadonlyArray<{ readonly id: string; readonly type: string; readonly node: string }>
  /** Resources that did not. `quiet` ones (permissions, log groups) don't change how a system behaves under load. */
  readonly skipped: ReadonlyArray<{ readonly id: string; readonly type: string; readonly reason: string; readonly quiet: boolean }>
  /** What the importer added that the source did not have: a region box, traffic sources. */
  readonly added: ReadonlyArray<string>
  readonly settings: {
    /** Settings carried over from the source into the design. */
    readonly preserved: number
    /** Values that were outside what the simulator accepts and were changed to fit. */
    readonly adjusted: ReadonlyArray<string>
    /** Values the source computes at deploy time, so the component's default was kept. */
    readonly unresolved: ReadonlyArray<string>
  }
  readonly connections: {
    /** Wiring the source states outright: event source mappings, subscriptions, notifications. */
    readonly declared: number
    /** Wiring guessed from environment variables and permissions: worth a look. */
    readonly inferred: number
  }
  readonly warnings: ReadonlyArray<string>
}

export interface ImportResult {
  readonly doc: Design.Doc
  readonly report: ImportReport
}

/** The text isn't something this importer can read. */
export class ImportError extends Error {
  override readonly name = "ImportError"
}

export interface Importer {
  readonly id: string
  readonly title: string
  /** File extensions it usually reads, with the dot. */
  readonly extensions: ReadonlyArray<string>
  /** Whether text looks like something this importer reads, cheaply and without throwing. */
  readonly detect: (text: string) => boolean
  readonly run: (text: string, registry: Components, options?: ImportOptions) => ImportResult
}
