import { Construct } from 'constructs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import {
  DEFAULT_ROOT_OBJECT,
  FORMAT_MISSING_ORIGIN_ID,
  ORIGIN_SECRET_HEADER,
} from '../../constants';

export interface FormatMissingDistributionProps {
  contentOrigin: cloudfront.IOrigin;
  webAclArn: string;
  originSecret: string;
  failoverCff: cloudfront.Function;
}

export class FormatMissingDistribution extends Construct {
  public readonly fallbackOrigin: origins.HttpOrigin;

  constructor(scope: Construct, id: string, props: FormatMissingDistributionProps) {
    super(scope, id);

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Format-Missing: strips /formats/ prefix, logs object_missing, serves original content',
      webAclId: props.webAclArn,
      defaultRootObject: DEFAULT_ROOT_OBJECT,
      defaultBehavior: {
        origin: props.contentOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [
          {
            function: props.failoverCff,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
    });

    this.fallbackOrigin = new origins.HttpOrigin(distribution.distributionDomainName, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      originId: FORMAT_MISSING_ORIGIN_ID,
      customHeaders: {
        [ORIGIN_SECRET_HEADER]: props.originSecret,
      },
    });
  }
}
