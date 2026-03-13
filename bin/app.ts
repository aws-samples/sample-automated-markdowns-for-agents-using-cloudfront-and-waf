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
    reason: 'Wildcard permissions are scoped to specific S3 buckets and are required by CDK L2 grant methods (grantReadWrite, grantRead). Resource::* is used for CloudFront invalidation which requires it.',
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
    id: 'AwsSolutions-DDB3',
    reason: 'Sample project — DynamoDB PITR not required for transient format markers that can be regenerated.',
  },
  {
    id: 'AwsSolutions-L1',
    reason: 'BucketDeployment Lambda runtime is managed by the CDK construct and cannot be overridden.',
  },
], true);
