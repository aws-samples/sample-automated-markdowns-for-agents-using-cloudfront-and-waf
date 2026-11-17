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
    // The CDK-managed Web Function asset bucket is not ours to count
    expect(Object.keys(buckets).filter((id) => id.startsWith('OriginLayer')).length).toBe(2);
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
  test('creates one CloudFront distribution (no format-missing distribution)', () => {
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    // Only the Bot Control web ACL: the origin-verify web ACL went with the second distribution
    template.resourceCountIs('AWS::WAFv2::WebACL', 1);
  });

  test('distribution has the content, formats and signal origins', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Origins: Match.arrayWith([
          Match.objectLike({ Id: 'content' }),
          Match.objectLike({ Id: 'formats-markdown', OriginPath: '/formats/markdown' }),
          Match.objectLike({ Id: 'signal', DomainName: { 'Fn::GetAtt': [Match.stringLikeRegexp('SignalFunctionEndpoint'), 'DomainName'] } }),
        ]),
      }),
    });
  });

  test('no cache behavior reaches the formats or signal origins directly', () => {
    const [dist] = Object.values(template.findResources('AWS::CloudFront::Distribution'));
    const config = dist.Properties.DistributionConfig;
    const targets = [config.DefaultCacheBehavior, ...(config.CacheBehaviors ?? [])].map((b: any) => b.TargetOriginId);
    expect(new Set(targets)).toEqual(new Set(['content']));
  });

  test('default behavior runs a viewer-request and a viewer-response function', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          FunctionAssociations: [
            Match.objectLike({ EventType: 'viewer-request' }),
            Match.objectLike({ EventType: 'viewer-response' }),
          ],
        }),
      }),
    });
  });

  test('format-aware cache policy keys on the WAF header and the format version', () => {
    template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: Match.objectLike({
        ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
          HeadersConfig: {
            HeaderBehavior: 'whitelist',
            Headers: ['x-amzn-waf-format-convert-needed', 'x-format-version'],
          },
        }),
      }),
    });
  });

  // --- Signal Web Function (cf.beacon target) ---
  test('signal origin is a Lambda Web Function with an IamAuth endpoint', () => {
    template.resourceCountIs('AWS::Lambda::WebFunction', 1);
    template.hasResourceProperties('AWS::Lambda::WebFunctionEndpoint', { AuthType: 'IamAuth' });
  });

  test('signal Web Function: only this distribution may invoke the endpoint', () => {
    template.hasResourceProperties('AWS::Lambda::ResourcePolicy', {
      PolicyDocument: Match.objectLike({
        Statement: [Match.objectLike({
          Action: 'lambda:InvokeWebFunctionEndpoint',
          Principal: { Service: 'cloudfront.amazonaws.com' },
          Condition: { StringEquals: { 'aws:SourceArn': Match.anyValue() } },
        })],
      }),
    });
  });

  test('signal origin uses a lambda OAC that always signs', () => {
    template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({
        OriginAccessControlOriginType: 'lambda',
        SigningBehavior: 'always-amz-auth',
        SigningProtocol: 'sigv4',
      }),
    });
  });

  test('signal Web Function can send to the FIFO queue', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([Match.objectLike({
          Action: Match.arrayWith(['sqs:SendMessage']),
          Resource: { 'Fn::GetAtt': [Match.stringLikeRegexp('GenerationQueue'), 'Arn'] },
        })]),
      }),
    });
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
    // Generator + KVS Sync (+ CDK custom resource handlers); the Parser Lambda is gone
    expect(Object.keys(lambdas).length).toBeGreaterThanOrEqual(2);
    const handlers = Object.keys(lambdas).join(' ');
    expect(handlers).not.toMatch(/Parser/);
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

  test('KVS Sync Lambda no longer invalidates the cache', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const kvsSync = Object.entries(policies).filter(([id]) => id.includes('KvsSync'));
    expect(kvsSync.length).toBe(1);
    expect(JSON.stringify(kvsSync[0][1])).not.toContain('cloudfront:CreateInvalidation');
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ KVS_ARN: Match.anyValue(), DISTRIBUTION_ID: Match.absent() }) },
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
  test('creates log groups for both CloudFront Functions (dashboard metric filters)', () => {
    template.resourcePropertiesCountIs('AWS::Logs::LogGroup', {
      LogGroupName: Match.stringLikeRegexp('/aws/cloudfront/function/'),
    }, 2);
  });

  // --- No log-based signal path ---
  test('signals travel by cf.beacon: no subscription filters', () => {
    template.resourceCountIs('AWS::Logs::SubscriptionFilter', 0);
  });

  // --- Outputs ---
  test('has stack outputs for distribution domain and bucket name', () => {
    template.hasOutput('DistributionDomainName', {});
    template.hasOutput('ContentBucketName', {});
    template.hasOutput('FormatsBucketName', {});
    template.hasOutput('DistributionId', {});
  });
});
