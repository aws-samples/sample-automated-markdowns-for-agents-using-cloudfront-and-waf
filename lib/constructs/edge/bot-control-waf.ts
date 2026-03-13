import { Construct } from 'constructs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import {
  WAF_ACL_METRIC_NAME,
  WAF_AI_BOT_LABEL,
  WAF_BOT_CONTROL_RULESET,
  WAF_BOT_CONTROL_VERSION,
  WAF_BOT_CONTROL_INSPECTION_LEVEL,
  WAF_RULE_BOT_CONTROL,
  WAF_METRIC_BOT_CONTROL,
  WAF_RULE_FORMAT_CONVERT_INJECTION,
  WAF_METRIC_FORMAT_CONVERT,
  WAF_RULE_DO_NOT_CONVERT,
  WAF_METRIC_DO_NOT_CONVERT,
  WAF_HEADER_FORMAT_CONVERT,
  WAF_HEADER_FORMAT_CONVERT_VALUE,
  WAF_HEADER_NO_CONVERT,
  WAF_ACCEPT_HEADER_SEARCH_STRING,
  DO_NOT_CONVERT_PATTERNS,
} from '../../constants';

export class BotControlWaf extends Construct {
  public readonly webAcl: wafv2.CfnWebACL;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const doNotConvertPatternSet = new wafv2.CfnRegexPatternSet(this, 'DoNotConvertPatterns', {
      scope: 'CLOUDFRONT',
      regularExpressionList: DO_NOT_CONVERT_PATTERNS,
      description: 'URI patterns excluded from format conversion',
    });

    this.webAcl = new wafv2.CfnWebACL(this, 'BotControlAcl', {
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: WAF_ACL_METRIC_NAME,
      },
      rules: [
        {
          name: WAF_RULE_BOT_CONTROL,
          priority: 0,
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: WAF_BOT_CONTROL_RULESET,
              managedRuleGroupConfigs: [
                {
                  awsManagedRulesBotControlRuleSet: {
                    inspectionLevel: WAF_BOT_CONTROL_INSPECTION_LEVEL,
                  },
                },
              ],
              version: WAF_BOT_CONTROL_VERSION,
            },
          },
          overrideAction: { count: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: WAF_METRIC_BOT_CONTROL,
          },
        },
        {
          name: WAF_RULE_FORMAT_CONVERT_INJECTION,
          priority: 1,
          statement: {
            andStatement: {
              statements: [
                {
                  labelMatchStatement: {
                    scope: 'LABEL',
                    key: WAF_AI_BOT_LABEL,
                  },
                },
                {
                  byteMatchStatement: {
                    searchString: WAF_ACCEPT_HEADER_SEARCH_STRING,
                    fieldToMatch: { singleHeader: { name: 'accept' } },
                    positionalConstraint: 'CONTAINS',
                    textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
                  },
                },
              ],
            },
          },
          action: {
            count: {
              customRequestHandling: {
                insertHeaders: [
                  {
                    name: WAF_HEADER_FORMAT_CONVERT,
                    value: WAF_HEADER_FORMAT_CONVERT_VALUE,
                  },
                ],
              },
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: WAF_METRIC_FORMAT_CONVERT,
          },
        },
        {
          name: WAF_RULE_DO_NOT_CONVERT,
          priority: 2,
          statement: {
            regexPatternSetReferenceStatement: {
              arn: doNotConvertPatternSet.attrArn,
              fieldToMatch: { uriPath: {} },
              textTransformations: [{ priority: 0, type: 'NONE' }],
            },
          },
          action: {
            count: {
              customRequestHandling: {
                insertHeaders: [
                  {
                    name: WAF_HEADER_NO_CONVERT,
                    value: 'true',
                  },
                ],
              },
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: WAF_METRIC_DO_NOT_CONVERT,
          },
        },
      ],
    });
  }
}
