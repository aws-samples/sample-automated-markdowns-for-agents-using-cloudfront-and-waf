import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { MarkdownGenerationStack } from '../lib/markdown-generation-stack';

describe('MarkdownGenerationStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new MarkdownGenerationStack(app, 'TestStack', {
      env: { region: 'us-east-1' },
    });
    template = Template.fromStack(stack);
  });

  // --- S3 Buckets ---
  test('creates two S3 buckets (content + formats) with DESTROY removal policy', () => {
    const buckets = template.findResources('AWS::S3::Bucket', {
      UpdateReplacePolicy: 'Delete',
      DeletionPolicy: 'Delete',
    });
    expect(Object.keys(buckets).length).toBe(2);
  });

  // --- WAF WebACL ---
  test('creates WAF WebACL with CLOUDFRONT scope', () => {
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'CLOUDFRONT',
    });
  });

  test('WAF WebACL has Bot Control managed rule group', () => {
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'AWSBotControl',
          Statement: {
            ManagedRuleGroupStatement: {
              VendorName: 'AWS',
              Name: 'AWSManagedRulesBotControlRuleSet',
            },
          },
        }),
      ]),
    });
  });

  test('WAF has format conversion header injection rule with Accept header condition', () => {
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'FormatConvertHeaderInjection',
          Statement: {
            AndStatement: {
              Statements: Match.arrayWith([
                Match.objectLike({
                  LabelMatchStatement: {
                    Scope: 'LABEL',
                    Key: 'awswaf:managed:aws:bot-control:bot:category:ai',
                  },
                }),
                Match.objectLike({
                  ByteMatchStatement: {
                    SearchString: 'text/markdown',
                    FieldToMatch: { SingleHeader: { name: 'accept' } },
                    PositionalConstraint: 'CONTAINS',
                  },
                }),
              ]),
            },
          },
          Action: {
            Count: {
              CustomRequestHandling: {
                InsertHeaders: Match.arrayWith([
                  Match.objectLike({
                    Name: 'format-convert-needed',
                    Value: 'markdown',
                  }),
                ]),
              },
            },
          },
        }),
      ]),
    });
  });

  test('WAF has do-not-convert rule', () => {
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'DoNotConvert',
        }),
      ]),
    });
  });

  // --- WAF Regex Pattern Set ---
  test('creates regex pattern set for do-not-convert URIs', () => {
    template.hasResourceProperties('AWS::WAFv2::RegexPatternSet', {
      Scope: 'CLOUDFRONT',
      RegularExpressionList: ['/static/.*'],
    });
  });

  // --- CloudFront ---
  test('creates CloudFront distributions', () => {
    // Primary + Formats = 2 distributions
    template.resourceCountIs('AWS::CloudFront::Distribution', 2);
  });

  test('creates CloudFront KeyValueStore', () => {
    template.resourceCountIs('AWS::CloudFront::KeyValueStore', 1);
  });

  test('creates CloudFront Functions with JS_2_0 runtime', () => {
    template.hasResourceProperties('AWS::CloudFront::Function', {
      FunctionConfig: Match.objectLike({
        Runtime: 'cloudfront-js-2.0',
      }),
    });
  });

  test('creates Response Headers Policy with Vary: Accept', () => {
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        CustomHeadersConfig: {
          Items: Match.arrayWith([
            Match.objectLike({
              Header: 'Vary',
              Value: 'Accept',
              Override: true,
            }),
          ]),
        },
      }),
    });
  });

  // --- SQS FIFO Queue ---
  test('creates SQS FIFO queue', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      FifoQueue: true,
    });
  });

  // --- DynamoDB Table ---
  test('creates DynamoDB table with URI partition key and stream', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'uri', KeyType: 'HASH' },
      ],
      StreamSpecification: {
        StreamViewType: 'NEW_AND_OLD_IMAGES',
      },
    });
  });

  // --- Lambda Functions ---
  test('creates Lambda functions with Node.js 24 runtime', () => {
    const lambdas = template.findResources('AWS::Lambda::Function', {
      Properties: {
        Runtime: 'nodejs24.x',
      },
    });
    // Parser + Generator + KVS Sync = 3 functions (+ BucketDeployment custom resource handler)
    expect(Object.keys(lambdas).length).toBeGreaterThanOrEqual(3);
  });

  test('Generator Lambda has required environment variables', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          BUCKET_NAME: Match.anyValue(),
          DISTRIBUTION_DOMAIN: Match.anyValue(),
          TABLE_NAME: Match.anyValue(),
          FORMAT_TTL_SECONDS: '86400',
        }),
      },
    });
  });

  test('KVS Sync Lambda has KVS_ARN environment variable', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          KVS_ARN: Match.anyValue(),
        }),
      },
    });
  });

  // --- CloudWatch Dashboard ---
  test('creates CloudWatch dashboard', () => {
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
  });

  // --- Log Groups ---
  test('creates CFF log groups for subscription filters', () => {
    template.resourcePropertiesCountIs('AWS::Logs::LogGroup', {
      LogGroupName: Match.stringLikeRegexp('/aws/cloudfront/function/'),
    }, 2);
  });

  // --- Subscription Filters ---
  test('creates subscription filters on CFF log groups', () => {
    template.resourceCountIs('AWS::Logs::SubscriptionFilter', 2);
  });

  // --- Outputs ---
  test('has stack outputs for distribution domain and bucket name', () => {
    template.hasOutput('DistributionDomainName', {});
    template.hasOutput('ContentBucketName', {});
    template.hasOutput('FormatsBucketName', {});
    template.hasOutput('DistributionId', {});
  });
});
