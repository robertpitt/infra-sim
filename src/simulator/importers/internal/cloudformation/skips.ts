/**
 * What the import says about resources that did not become a component (or a setting of one).
 *
 * `quiet` ones don't change how a system behaves under load; the rest are things the simulator has no component for
 * (or no way to carry), and the report lists them loudly so nobody mistakes the design for the whole system.
 */

/** Types that change nothing about how a system behaves under load. */
const QUIET = [
  "AWS::IAM::", "AWS::Logs::", "AWS::KMS::", "AWS::SSM::", "AWS::SecretsManager::", "AWS::CloudWatch::", "AWS::CDK::Metadata",
  "AWS::Lambda::Permission", "AWS::Lambda::LayerVersion", "AWS::SQS::QueuePolicy", "AWS::SNS::TopicPolicy", "AWS::S3::BucketPolicy",
  "AWS::ApiGateway::Deployment", "AWS::ApiGateway::Account", "AWS::ApiGateway::ApiKey", "AWS::ApiGateway::UsagePlanKey",
  "AWS::ApiGateway::Model", "AWS::ApiGateway::Resource", "AWS::ApiGateway::RequestValidator", "AWS::ApiGateway::GatewayResponse", "AWS::ApiGateway::DomainName",
  "AWS::ApiGateway::BasePathMapping", "AWS::ApiGatewayV2::Deployment", "AWS::ApiGatewayV2::Model",
  "AWS::ApiGatewayV2::DomainName", "AWS::ApiGatewayV2::ApiMapping", "AWS::ApiGatewayV2::VpcLink",
  // Networking that wires a VPC together: the simulator's VPC is a boundary, and routes aren't read.
  "AWS::EC2::SecurityGroup", "AWS::EC2::Route", "AWS::EC2::RouteTable", "AWS::EC2::InternetGateway", "AWS::EC2::VPCGatewayAttachment",
  "AWS::EC2::SubnetRouteTableAssociation", "AWS::EC2::EIP", "AWS::EC2::NetworkAcl", "AWS::EC2::SubnetNetworkAclAssociation", "AWS::EC2::VPCCidrBlock",
  "AWS::EC2::DHCPOptions", "AWS::EC2::VPCDHCPOptionsAssociation",
  "AWS::CloudFormation::", "Custom::", "AWS::Events::EventBus", "AWS::Events::EventBusPolicy", "AWS::Cognito::", "AWS::WAFv2::", "AWS::Route53::", "AWS::CertificateManager::",
  // CloudFront objects a distribution refers to: identities and policies that shape requests, not load.
  "AWS::CloudFront::OriginAccessControl", "AWS::CloudFront::CloudFrontOriginAccessIdentity", "AWS::CloudFront::OriginRequestPolicy",
  "AWS::CloudFront::ResponseHeadersPolicy", "AWS::CloudFront::KeyGroup", "AWS::CloudFront::PublicKey", "AWS::CloudFront::RealtimeLogConfig", "AWS::CloudFront::Function"
]

/** SES resources with no behaviour in the simulator: what matters under load is the configuration set and who sends. */
const SES_NO_BEHAVIOUR: Record<string, string> = {
  "AWS::SES::EmailIdentity": "a verified identity doesn't change how sending behaves under load (the sandbox is an account setting)",
  "AWS::SES::Template": "a template doesn't change how sending behaves under load",
  "AWS::SES::ContactList": "a contact list has no behaviour in the simulator",
  "AWS::SES::DedicatedIpPool": "dedicated IP pools aren't simulated: sending uses the account's rate and reputation",
  "AWS::SES::ReceiptRuleSet": "receiving email isn't simulated: the SES component sends",
  "AWS::SES::ReceiptRule": "receiving email isn't simulated: the SES component sends",
  "AWS::SES::ReceiptFilter": "receiving email isn't simulated: the SES component sends"
}

/** The service a resource type belongs to, for a readable "not modelled yet" note. */
const serviceOf = (type: string): string => (type.startsWith("Custom::") ? "A custom resource" : (type.split("::")[1] ?? type))

/** Why a resource that nothing consumed was left out. */
export const reasonFor = (type: string): { readonly reason: string; readonly quiet: boolean } => {
  const ses = SES_NO_BEHAVIOUR[type]
  if (ses !== undefined) return { reason: ses, quiet: true }
  const quiet = QUIET.some((q) => type.startsWith(q))
  return quiet
    ? { reason: "permissions, logging and configuration don't change how a system behaves under load", quiet: true }
    : { reason: `${serviceOf(type)} has no simulator component yet`, quiet: false }
}
