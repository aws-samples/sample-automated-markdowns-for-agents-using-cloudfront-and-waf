#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { Aspects } from 'aws-cdk-lib/core';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { MarkdownGenerationStack } from '../lib/markdown-generation-stack';
import { STACK_REGION, STACK_DESCRIPTION } from '../lib/constants';

const app = new cdk.App();
const stack = new MarkdownGenerationStack(app, 'MarkdownGenerationStack', {
  env: {
    region: STACK_REGION,
  },
  description: STACK_DESCRIPTION,
});

// --- Optional tags from context, e.g. cdk.json or ~/.cdk.json: {"context": {"tags": {"team": "edge"}}} ---
const tags: Record<string, string> = app.node.tryGetContext('tags') ?? {};
for (const [key, value] of Object.entries(tags)) {
  cdk.Tags.of(app).add(key, String(value));
}

// --- CDK Nag: AWS Solutions compliance checks ---
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// --- CDK Nag suppressions for sample project ---
NagSuppressions.addStackSuppressions(stack, [
  {
    id: 'AwsSolutions-S1',
    reason: 'Sample project — S3 access logs omitted to reduce cost and complexity.',
  },
  {
    id: 'AwsSolutions-CFR1',
    reason: 'Sample project — geo restrictions not required for demo purposes.',
  },
  {
    id: 'AwsSolutions-CFR3',
    reason: 'Sample project — CloudFront access logging omitted to reduce cost. CFF logs are used for the generation pipeline.',
  },
  {
    id: 'AwsSolutions-CFR4',
    reason: 'Sample uses default CloudFront domain (*.cloudfront.net) which does not support custom TLS certificates.',
  },
  {
    id: 'AwsSolutions-SQS3',
    reason: 'SQS FIFO queue processes idempotent generation requests. Failed messages are retried via maxReceiveCount before being discarded. A DLQ can be added for production use.',
  },
  {
    id: 'AwsSolutions-IAM4',
    reason: 'AWSLambdaBasicExecutionRole is an AWS-managed policy for CloudWatch Logs access — standard for Lambda functions.',
    appliesTo: [
      'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
    ],
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'Wildcard permissions are scoped to specific S3 buckets and are required by CDK L2 grant methods (grantReadWrite, grantRead).',
    appliesTo: [
      'Action::s3:Abort*',
      'Action::s3:DeleteObject*',
      'Action::s3:GetBucket*',
      'Action::s3:GetObject*',
      'Action::s3:List*',
      'Resource::*',
      'Resource::<OriginLayerFormatsBucket4E44203B.Arn>/*',
      'Resource::<OriginLayerContentBucketED4C2888.Arn>/*',
      'Resource::arn:<AWS::Partition>:s3:::cdk-hnb659fds-assets-<AWS::AccountId>-us-east-1/*',
    ],
  },
  {
    id: 'AwsSolutions-SMG4',
    reason: 'The secret is the signal API key that CloudFront sends as an origin custom header; rotating it means updating the distribution too, which a redeploy does.',
  },
  {
    id: 'AwsSolutions-APIG1',
    reason: 'Sample project — signal API access logs omitted; the dashboard shows its request, 4xx and 5xx counts.',
  },
  {
    id: 'AwsSolutions-APIG6',
    reason: 'Sample project — signal API execution logs omitted (they need an account-level API Gateway CloudWatch role).',
  },
  {
    id: 'AwsSolutions-APIG4',
    reason: 'The signal API requires an API key that only CloudFront holds (an origin custom header); no viewer reaches it through a cache behavior.',
  },
  {
    id: 'AwsSolutions-COG4',
    reason: 'The signal API is called by CloudFront, not by users: it uses an API key, not a Cognito user pool.',
  },
  {
    id: 'AwsSolutions-APIG3',
    reason: 'The signal API is reached through the distribution, whose web ACL already inspects the viewer requests; a direct call without the API key gets 403.',
  },
  {
    id: 'AwsSolutions-DDB3',
    reason: 'Sample project — DynamoDB PITR not required for transient format markers that can be regenerated.',
  },
  {
    id: 'AwsSolutions-L1',
    reason: 'BucketDeployment Lambda runtime is managed by the CDK construct and cannot be overridden.',
  },
], true);
