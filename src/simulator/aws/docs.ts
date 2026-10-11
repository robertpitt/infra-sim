/**
 * Where AWS documents each service. Components link their limits and settings to these, so a number in the simulator
 * can be checked against its source.
 */
export const docs = {
  lambda: "https://docs.aws.amazon.com/lambda/latest/dg/",
  sqs: "https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/",
  sns: "https://docs.aws.amazon.com/sns/latest/dg/",
  snsQuotas: "https://docs.aws.amazon.com/general/latest/gr/sns.html",
  dynamodb: "https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/",
  apigateway: "https://docs.aws.amazon.com/apigateway/latest/developerguide/",
  cloudfront: "https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/",
  ses: "https://docs.aws.amazon.com/ses/latest/dg/"
} as const
