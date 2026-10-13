# AWS limits used by the simulator

Every number the simulator takes from AWS is written down, with its source, in the README of the service it belongs to.
This page is the index and says how to read them.

| Service | Limits and sources |
| --- | --- |
| API Gateway | [`apigateway/README.md`](../src/simulator/aws/apigateway/README.md#limits) |
| CloudFront | [`cloudfront/README.md`](../src/simulator/aws/cloudfront/README.md#limits) |
| DynamoDB | [`dynamodb/README.md`](../src/simulator/aws/dynamodb/README.md#limits) |
| EC2 Auto Scaling | [`ec2/README.md`](../src/simulator/aws/ec2/README.md#limits) |
| ECS (Fargate and EC2) | [`ecs/README.md`](../src/simulator/aws/ecs/README.md#limits) |
| EKS | [`eks/README.md`](../src/simulator/aws/eks/README.md#limits) |
| Elastic Load Balancing (ALB, NLB) | [`elb/README.md`](../src/simulator/aws/elb/README.md#limits) |
| ElastiCache | [`elasticache/README.md`](../src/simulator/aws/elasticache/README.md#limits) |
| EventBridge | [`eventbridge/README.md`](../src/simulator/aws/eventbridge/README.md#limits) |
| EventBridge Scheduler | [`scheduler/README.md`](../src/simulator/aws/scheduler/README.md#limits) |
| Data Firehose | [`firehose/README.md`](../src/simulator/aws/firehose/README.md#limits) |
| Kinesis Data Streams | [`kinesis/README.md`](../src/simulator/aws/kinesis/README.md#limits) |
| Lambda | [`lambda/README.md`](../src/simulator/aws/lambda/README.md#limits) |
| OpenSearch Service | [`opensearch/README.md`](../src/simulator/aws/opensearch/README.md#limits) |
| RDS, Aurora and RDS Proxy | [`rds/README.md`](../src/simulator/aws/rds/README.md#limits) |
| Route 53 | [`route53/README.md`](../src/simulator/aws/route53/README.md#limits) |
| S3 | [`s3/README.md`](../src/simulator/aws/s3/README.md#limits) |
| SES | [`ses/README.md`](../src/simulator/aws/ses/README.md#limits) |
| SNS | [`sns/README.md`](../src/simulator/aws/sns/README.md#limits) |
| SQS | [`sqs/README.md`](../src/simulator/aws/sqs/README.md#limits) |
| Step Functions | [`stepfunctions/README.md`](../src/simulator/aws/stepfunctions/README.md#limits) |
| WAF | [`waf/README.md`](../src/simulator/aws/waf/README.md#limits) |
| Regions and availability zones | [`region/README.md`](../src/simulator/aws/region/README.md#limits) |
| VPC, NAT gateway, VPC endpoints | [`vpc/README.md`](../src/simulator/aws/vpc/README.md#limits) |

## How a limit is classified

- **hard**: the service enforces it and nobody can change it. It is the `min`/`max` of the setting that exposes it, or a
  read-only entry in the component's service limits, and shows as a `hard` pill in the app and in
  `infra-sim describe <type>`.
- **quota**: an adjustable default that AWS raises on request. It is an editable setting whose default is AWS's published
  number for the region. Quotas shared by everything in an account and region (Lambda's regional concurrency, API Gateway's
  regional throttle, SES's sending rate...) are account-level settings, edited per region in a Region box's "Account quotas".
- **assumed**: AWS doesn't publish it (a latency distribution, an idle timeout, a retry cadence). It is still a setting, its
  help says it is an assumption, and each README's Assumptions section lists them with the reason for the value.

## How the numbers were checked

Each service README was written against the AWS documentation fetched at the time, citing the page for every row. Where two AWS
pages disagree the README says so and which one the simulator follows. Disagreements found so far:

- SQS FIFO high-throughput quota for Ohio and Frankfurt: 19,000 (developer guide) vs 18,000 (general reference); the guide is used.
- Lambda provisioned-mode SQS poller maximum: 2,000 vs 10,000 across two pages; 10,000 is used.
- API Gateway reduced-throttle regions: the developer guide lists the UAE, the Service Quotas page omits it and adds
  `ap-east-2` and `ap-southeast-6`; the union is used.
- SES: the enforcement FAQ says a bounce rate under 2% is best, the reputation page says under 5%; 5% is the review threshold.
- S3 maximum object size: 48.8 TiB in current documentation (older pages say 5 TB).
- SNS: the FIFO delivery targets are SQS only in current documentation.

To check a number yourself, open the README row's source link. To change one for a design, change the setting (or the
account quota); to change one for everyone, change the default in the service's `internal/config.ts` or `Quotas.ts` and update its row.
