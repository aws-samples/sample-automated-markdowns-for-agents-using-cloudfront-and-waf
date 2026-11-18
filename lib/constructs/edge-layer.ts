import { Construct } from 'constructs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';
import { BotControlWaf, RoutingFunctions } from './edge';
import { formatOriginIds } from './edge/routing-functions';
import { SignalApi } from './signal-api';
import {
  DEFAULT_ROOT_OBJECT,
  CONTENT_ORIGIN_ID,
  STATIC_PATH_PATTERN,
  HEADER_FORMAT_VERSION,
  WAF_HEADER_FORMAT_CONVERT,
} from '../constants';

export interface EdgeLayerProps {
  /** The primary content origin (customer's S3, ALB, or any IOrigin). Its origin id must be CONTENT_ORIGIN_ID. */
  contentOrigin: cloudfront.IOrigin;
  /** S3 bucket for generated format outputs (markdown, etc.) */
  formatsBucket: s3.IBucket;
  /** The generation queue the signal API writes to */
  queue: sqs.IQueue;
}

export class EdgeLayer extends Construct {
  public readonly distribution: cloudfront.Distribution;
  public readonly kvsStore: cloudfront.KeyValueStore;
  public readonly requestCffLogGroup: logs.LogGroup;
  public readonly responseCffLogGroup: logs.LogGroup;
  public readonly signalApi: apigateway.RestApi;
  public readonly webAcl: wafv2.CfnWebACL;

  constructor(scope: Construct, id: string, props: EdgeLayerProps) {
    super(scope, id);

    // --- Bot Control AWS WAF ---
    const botControlWaf = new BotControlWaf(this, 'BotControl');
    this.webAcl = botControlWaf.webAcl;

    // --- Routing Functions + KVS ---
    const routingFunctions = new RoutingFunctions(this, 'Routing');
    this.kvsStore = routingFunctions.kvsStore;
    this.requestCffLogGroup = routingFunctions.requestCffLogGroup;
    this.responseCffLogGroup = routingFunctions.responseCffLogGroup;

    // --- Signal origin: an API Gateway REST API that sends the functions' cf.beacon signals to SQS ---
    const signal = new SignalApi(this, 'Signal', { queue: props.queue });
    this.signalApi = signal.api;

    // --- Formats origins: one per format, origin path /formats/<format>, no cache behavior ---
    // The request function puts one in a dynamic origin group with the content origin as the
    // failover, so the URI is never rewritten and a missing object falls back to the original.
    const formatsOrigins = Object.entries(formatOriginIds()).map(([format, originId]) =>
      origins.S3BucketOrigin.withOriginAccessControl(props.formatsBucket, {
        originId,
        originPath: `/formats/${format}`,
      }));

    // --- Cache Policy: WAF format header + format version in the cache key ---
    const formatAwareCachePolicy = new cloudfront.CachePolicy(this, 'FormatAwareCachePolicy', {
      cachePolicyName: `FormatAwareCache-${cdk.Names.uniqueId(this)}`.substring(0, 64),
      comment: 'Like CachingOptimized, keyed on the AWS WAF format header and the format version',
      defaultTtl: cdk.Duration.hours(1),
      maxTtl: cdk.Duration.days(365),
      minTtl: cdk.Duration.seconds(1),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList(
        `x-amzn-waf-${WAF_HEADER_FORMAT_CONVERT}`,
        HEADER_FORMAT_VERSION,
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

    // --- Distribution ---
    this.distribution = new cloudfront.Distribution(this, 'PrimaryDistribution', {
      comment: 'Markdown for AI agents: KVS routing, dynamic origin group, cf.beacon signals',
      webAclId: this.webAcl.attrArn,
      defaultRootObject: DEFAULT_ROOT_OBJECT,
      defaultBehavior: {
        origin: props.contentOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [
          {
            function: routingFunctions.requestCff,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
          {
            function: routingFunctions.responseCff,
            eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE,
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
      },
    });

    // Origins only the functions use: no cache behavior, so viewers never reach them directly.
    const contentOriginId = addStandaloneOrigin(this.distribution, props.contentOrigin);
    if (contentOriginId !== CONTENT_ORIGIN_ID) {
      throw new Error(`the content origin must be created with originId: '${CONTENT_ORIGIN_ID}' (got "${contentOriginId}")`);
    }
    for (const origin of formatsOrigins) addStandaloneOrigin(this.distribution, origin);
    addStandaloneOrigin(this.distribution, signal.origin);
  }
}

/**
 * Add an origin that has no cache behavior (a target for a dynamic origin group or cf.beacon).
 *
 * The Distribution L2 only exposes origins through behaviors, so this calls its private
 * `addOrigin`, the same code path behaviors use, which also binds OAC origins (bucket policy)
 * for this distribution. An origin already added by a behavior
 * is returned as is. Returns the origin id.
 */
function addStandaloneOrigin(distribution: cloudfront.Distribution, origin: cloudfront.IOrigin): string {
  const d = distribution as unknown as { addOrigin?: (origin: cloudfront.IOrigin) => string };
  if (typeof d.addOrigin !== 'function') {
    throw new Error('cloudfront.Distribution no longer has addOrigin(); update addStandaloneOrigin in lib/constructs/edge-layer.ts');
  }
  return d.addOrigin(origin);
}
