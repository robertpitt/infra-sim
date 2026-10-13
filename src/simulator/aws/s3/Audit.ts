import type { Diagnostic } from "../../Diagnostic.ts"
import type { Account } from "../internal/account.ts"
import { type Audit, fmt } from "../internal/service.ts"

/**
 * The buckets a design creates in a region, against the account's bucket quotas. The quotas are account-wide, so a
 * design spread over several regions can only be checked per region here; a warning means this region alone is over.
 */
export const audit: Audit = (region, members, quotas) => {
  const account = quotas as Account
  const out: Array<Diagnostic> = []
  const buckets = members.filter((m) => m.type === "aws.s3")
  const directory = buckets.filter((m) => (m.config as { bucketType?: string }).bucketType === "directory").length
  const general = buckets.length - directory
  if (general > account.s3GeneralPurposeBuckets) {
    out.push({
      level: "warning",
      code: "s3-general-purpose-buckets",
      message: `${fmt(general)} general purpose S3 buckets in ${region}; the account allows ${fmt(account.s3GeneralPurposeBuckets)}. Ask for a quota increase.`
    })
  }
  if (directory > account.s3DirectoryBuckets) {
    out.push({
      level: "warning",
      code: "s3-directory-buckets",
      message: `${fmt(directory)} S3 directory buckets in ${region}; the account allows ${fmt(account.s3DirectoryBuckets)}. Ask for a quota increase.`
    })
  }
  return out
}
