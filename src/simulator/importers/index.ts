import { CloudFormation } from "./CloudFormation.ts"
import type { Importer } from "./Importer.ts"

export { CloudFormation } from "./CloudFormation.ts"
export { ImportError, type Importer, type ImportOptions, type ImportReport, type ImportResult } from "./Importer.ts"

/** Every importer, in the order they are offered. Terraform and others plug in here. */
export const importers: ReadonlyArray<Importer> = [CloudFormation]

/** The importer that recognises this text, if any. */
export const detect = (text: string): Importer | undefined => importers.find((i) => i.detect(text))
