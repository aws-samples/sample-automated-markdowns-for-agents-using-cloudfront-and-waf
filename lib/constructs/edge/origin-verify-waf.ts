import { Construct } from 'constructs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as crypto from 'crypto';
import {
  ORIGIN_SECRET_HEADER,
  WAF_FORMAT_MISSING_ACL_METRIC,
  WAF_RULE_ORIGIN_VERIFY,
  WAF_METRIC_ORIGIN_VERIFY,
} from '../../constants';

export class OriginVerifyWaf extends Construct {
  public readonly webAcl: wafv2.CfnWebACL;
  public readonly originSecret: string;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.originSecret = crypto.randomUUID();

    this.webAcl = new wafv2.CfnWebACL(this, 'FormatMissingAcl', {
      scope: 'CLOUDFRONT',
      defaultAction: { block: {} },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: WAF_FORMAT_MISSING_ACL_METRIC,
      },
      rules: [
        {
          name: WAF_RULE_ORIGIN_VERIFY,
          priority: 0,
          statement: {
            byteMatchStatement: {
              searchString: this.originSecret,
              fieldToMatch: {
                singleHeader: { name: ORIGIN_SECRET_HEADER },
              },
              positionalConstraint: 'EXACTLY',
              textTransformations: [{ priority: 0, type: 'NONE' }],
            },
          },
          action: { allow: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: WAF_METRIC_ORIGIN_VERIFY,
          },
        },
      ],
    });
  }
}
