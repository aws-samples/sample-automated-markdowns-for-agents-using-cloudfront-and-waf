import { Construct } from 'constructs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';
import {
  BotControlWaf,
  OriginVerifyWaf,
  RoutingFunctions,
  FormatMissingDistribution,
} from './edge';
import {
  DEFAULT_ROOT_OBJECT,
  FORMATS_ORIGIN_ID,
  STATIC_PATH_PATTERN,
  FORMATS_PATH_PATTERN,
  ORIGIN_GROUP_FAILOVER_STATUS_CODES,
  WAF_HEADER_FORMAT_CONVERT,
} from '../constants';

export interface EdgeLayerProps {
  /** The primary content origin (customer's S3, ALB, or any IOrigin) */
  contentOrigin: cloudfront.IOrigin;
  /** S3 bucket for generated format outputs (markdown, etc.) */
  formatsBucket: s3.IBucket;
}

export class EdgeLayer extends Construct {
  public readonly distribution: cloudfront.Distribution;
  public readonly kvsStore: cloudfront.KeyValueStore;
  public readonly primaryCffLogGroup: logs.LogGroup;
  public readonly failoverCffLogGroup: logs.LogGroup;
  public readonly webAcl: wafv2.CfnWebACL;

  constructor(scope: Construct, id: string, props: EdgeLayerProps) {
    super(scope, id);

    // --- Bot Control AWS WAF ---
    const botControlWaf = new BotControlWaf(this, 'BotControl');
    this.webAcl = botControlWaf.webAcl;

    // --- Routing Functions + KVS ---
    const routingFunctions = new RoutingFunctions(this, 'Routing');
    this.kvsStore = routingFunctions.kvsStore;
    this.primaryCffLogGroup = routingFunctions.primaryCffLogGroup;
    this.failoverCffLogGroup = routingFunctions.failoverCffLogGroup;

    // --- Origin Verify AWS WAF ---
    const originVerifyWaf = new OriginVerifyWaf(this, 'OriginVerify');

    // --- Format-Missing Distribution ---
    const formatMissing = new FormatMissingDistribution(this, 'FormatMissing', {
      contentOrigin: props.contentOrigin,
      webAclArn: originVerifyWaf.webAcl.attrArn,
      originSecret: originVerifyWaf.originSecret,
      failoverCff: routingFunctions.failoverCff,
    });

    // --- Formats S3 origin (registered via /formats/* behavior for CFF to reference) ---
    const formatsOrigin = origins.S3BucketOrigin.withOriginAccessControl(props.formatsBucket, {
      originId: FORMATS_ORIGIN_ID,
    });

    // --- Cache Policy: includes WAF bot header in cache key ---
    const formatAwareCachePolicy = new cloudfront.CachePolicy(this, 'FormatAwareCachePolicy', {
      cachePolicyName: `FormatAwareCache-${cdk.Names.uniqueId(this)}`.substring(0, 64),
      comment: 'Like CachingOptimized but includes AWS WAF format-convert header in cache key',
      defaultTtl: cdk.Duration.hours(1),
      maxTtl: cdk.Duration.days(365),
      minTtl: cdk.Duration.seconds(1),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList(
        `x-amzn-waf-${WAF_HEADER_FORMAT_CONVERT}`
      ),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    // --- Response Headers Policy: Vary: Accept ---
    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'VaryAcceptPolicy', {
      responseHeadersPolicyName: `VaryAccept-${cdk.Names.uniqueId(this)}`.substring(0, 64),
      comment: 'Adds Vary: Accept header for content negotiation',
      customHeadersBehavior: {
        customHeaders: [
          {
            header: 'Vary',
            value: 'Accept',
            override: true,
          },
        ],
      },
    });

    // --- Primary Distribution ---
    this.distribution = new cloudfront.Distribution(this, 'PrimaryDistribution', {
      comment: 'Primary: Content S3 default, CFF dynamically routes bots via createRequestOriginGroup',
      webAclId: this.webAcl.attrArn,
      defaultRootObject: DEFAULT_ROOT_OBJECT,
      defaultBehavior: {
        origin: props.contentOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [
          {
            function: routingFunctions.primaryCff,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
        cachePolicy: formatAwareCachePolicy,
        responseHeadersPolicy,
      },
      additionalBehaviors: {
        [STATIC_PATH_PATTERN]: {
          origin: props.contentOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
        [FORMATS_PATH_PATTERN]: {
          origin: new origins.OriginGroup({
            primaryOrigin: formatsOrigin,
            fallbackOrigin: formatMissing.fallbackOrigin,
            fallbackStatusCodes: ORIGIN_GROUP_FAILOVER_STATUS_CODES,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
      },
    });
  }
}
