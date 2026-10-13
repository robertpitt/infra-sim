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
  elasticache: "https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/",
  apigateway: "https://docs.aws.amazon.com/apigateway/latest/developerguide/",
  cloudfront: "https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/",
  ses: "https://docs.aws.amazon.com/ses/latest/dg/",
  rds: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/",
  aurora: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/",
  route53: "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/",
  waf: "https://docs.aws.amazon.com/waf/latest/developerguide/",
  ec2AutoScaling: "https://docs.aws.amazon.com/autoscaling/ec2/userguide/",
  stepfunctions: "https://docs.aws.amazon.com/step-functions/latest/dg/",
  eventbridge: "https://docs.aws.amazon.com/eventbridge/latest/userguide/",
  scheduler: "https://docs.aws.amazon.com/scheduler/latest/UserGuide/",
  opensearch: "https://docs.aws.amazon.com/opensearch-service/latest/developerguide/",
  kinesis: "https://docs.aws.amazon.com/streams/latest/dev/",
  kinesisApi: "https://docs.aws.amazon.com/kinesis/latest/APIReference/",
  firehose: "https://docs.aws.amazon.com/firehose/latest/dev/",
  firehoseApi: "https://docs.aws.amazon.com/firehose/latest/APIReference/",
  elb: "https://docs.aws.amazon.com/elasticloadbalancing/latest/",
  ecs: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/",
  eks: "https://docs.aws.amazon.com/eks/latest/userguide/"
} as const
