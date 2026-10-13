/**
 * Where AWS documents the things the SES component models. Settings, limits and the README link to these so a number
 * can be checked against its source. (The shared `../docs.ts` has no SES entry and is not ours to edit.)
 */
const DG = "https://docs.aws.amazon.com/ses/latest/dg/"
const API_V2 = "https://docs.aws.amazon.com/ses/latest/APIReference-V2/"

export const sources = {
  quotas: `${DG}quotas.html`,
  sendingQuotas: `${DG}manage-sending-quotas.html`,
  quotaErrors: `${DG}manage-sending-quotas-errors.html`,
  sandbox: `${DG}request-production-access.html`,
  reputation: `${DG}reputationdashboardmessages.html`,
  reputationDashboard: `${DG}reputation-dashboard-dg.html`,
  enforcement: `${DG}faqs-enforcement.html`,
  sendProcess: `${DG}send-email-concepts-process.html`,
  suppression: `${DG}sending-email-suppression-list.html`,
  eventPublishing: `${DG}monitor-using-event-publishing.html`,
  eventContents: `${DG}event-publishing-retrieving-sns-contents.html`,
  cloudWatchMetrics: `${DG}event-publishing-retrieving-cloudwatch.html`,
  warmup: `${DG}dedicated-ip-warming.html`,
  sendEmail: `${API_V2}API_SendEmail.html`,
  sendBulkEmail: `${API_V2}API_SendBulkEmail.html`,
  deliveryOptions: `${API_V2}API_DeliveryOptions.html`
} as const
