import type { ServiceMap } from "../map.ts"

/**
 * SES: outbound email, per recipient (every To, CC and BCC address of a message), and the data sent as attachments.
 * https://aws.amazon.com/ses/pricing/
 *
 * Usage types (after the region prefix): `Recipients` (operation `Send`) and `AttachmentsSize-Bytes`. In us-east-1 each
 * is listed twice, with and without the `USE1-` prefix, at one price.
 * Left out: dedicated IPs (standard and managed) and Virtual Deliverability Manager (not modelled), sending from EC2
 * (`Recipients-EC2`, the same price), receiving email and Mail Manager (not modelled), the Essentials, Pro and Enterprise
 * plans, and the free tier (12 months for new accounts, not in the price list).
 */
export const ses: ServiceMap = {
  id: "ses",
  title: "Amazon SES",
  offers: ["AmazonSES"],
  dimensions: {
    recipients: {
      unit: "recipient",
      description: "Outbound email, per recipient"
    },
    attachments: {
      unit: "GB",
      description: "Data sent as attachments"
    }
  },
  classify: (row) => {
    if (row.usage === "Recipients" && row.operation === "Send") return { dimension: "recipients" }
    if (row.usage === "AttachmentsSize-Bytes") return { dimension: "attachments" }
    return undefined
  }
}
