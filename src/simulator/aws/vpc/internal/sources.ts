/** The AWS pages the VPC folder's numbers come from, so a value in the simulator can be checked against its source. */
export const D = "https://docs.aws.amazon.com/vpc/latest/userguide/"
export const PRIVATELINK = "https://docs.aws.amazon.com/vpc/latest/privatelink/"
export const LAMBDA_VPC = "https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc.html"

export const source = {
  quotas: `${D}amazon-vpc-limits.html`,
  cidr: `${D}vpc-cidr-blocks.html`,
  subnets: `${D}subnet-sizing.html`,
  natBasics: `${D}nat-gateway-basics.html`,
  natRegional: `${D}nat-gateways-regional.html`,
  natTroubleshooting: `${D}nat-gateway-troubleshooting.html`,
  endpointQuotas: `${PRIVATELINK}vpc-limits-endpoints.html`,
  gatewayEndpointsS3: `${PRIVATELINK}vpc-endpoints-s3.html`,
  lambdaVpc: LAMBDA_VPC,
  lambdaInternet: "https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc-internet.html"
} as const
