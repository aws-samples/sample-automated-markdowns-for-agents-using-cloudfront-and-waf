import { Construct } from 'constructs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';
import * as path from 'path';
import { buildCffCode } from './cff-code';
import {
  CFF_NAME_MAX_LENGTH,
  HEADER_SKIP_CONVERSION,
  HEADER_FORMAT_VERSION,
  HEADER_FORMAT_SERVED,
  HEADER_FORMAT_STATUS,
  WAF_HEADER_NO_CONVERT,
  WAF_HEADER_FORMAT_CONVERT,
  CONTENT_ORIGIN_ID,
  FORMATS_ORIGIN_ID_PREFIX,
  FORMAT_CONTENT_TYPES,
  SIGNAL_ORIGIN_ID,
  SIGNAL_PATH,
  ORIGIN_GROUP_FAILOVER_STATUS_CODES,
  ACTION_REWRITE,
  SIGNAL_PASSTHROUGH,
  SIGNAL_FORMAT_SERVED,
  SIGNAL_FORMAT_NEEDED,
  SIGNAL_OBJECT_MISSING,
} from '../../constants';

const FUNCTIONS_DIR = path.join(__dirname, '../../../functions/cloudfront');

/** The origin id of each format's origin on the distribution: `formats-<format>`. */
export function formatOriginIds(): Record<string, string> {
  return Object.fromEntries(
    Object.keys(FORMAT_CONTENT_TYPES).map((format) => [format, `${FORMATS_ORIGIN_ID_PREFIX}${format}`]),
  );
}

/** The placeholders each CloudFront Function's source expects (shared with the unit tests). */
export function viewerRequestReplacements(): Record<string, string> {
  return {
    HEADER_SKIP_CONVERSION,
    HEADER_NO_CONVERT: `x-amzn-waf-${WAF_HEADER_NO_CONVERT}`,
    HEADER_FORMAT_CONVERT: `x-amzn-waf-${WAF_HEADER_FORMAT_CONVERT}`,
    HEADER_FORMAT_VERSION,
    HEADER_FORMAT_SERVED,
    HEADER_FORMAT_STATUS,
    CONTENT_ORIGIN_ID,
    FORMAT_ORIGIN_IDS: JSON.stringify(formatOriginIds()),
    FAILOVER_STATUS_CODES: JSON.stringify(ORIGIN_GROUP_FAILOVER_STATUS_CODES),
    SIGNAL_ORIGIN_ID,
    SIGNAL_PATH,
    ACTION_REWRITE,
    SIGNAL_PASSTHROUGH,
    SIGNAL_FORMAT_SERVED,
    SIGNAL_FORMAT_NEEDED,
  };
}

export function viewerResponseReplacements(): Record<string, string> {
  return {
    HEADER_FORMAT_SERVED,
    HEADER_FORMAT_STATUS,
    FORMAT_CONTENT_TYPES: JSON.stringify(FORMAT_CONTENT_TYPES),
    SIGNAL_ORIGIN_ID,
    SIGNAL_PATH,
    SIGNAL_OBJECT_MISSING,
  };
}

export class RoutingFunctions extends Construct {
  public readonly kvsStore: cloudfront.KeyValueStore;
  public readonly requestCff: cloudfront.Function;
  public readonly responseCff: cloudfront.Function;
  public readonly requestCffLogGroup: logs.LogGroup;
  public readonly responseCffLogGroup: logs.LogGroup;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.kvsStore = new cloudfront.KeyValueStore(this, 'MarkerKvs', {
      comment: 'URI-to-format marker store for CFF routing decisions',
    });

    this.requestCff = new cloudfront.Function(this, 'ViewerRequestCff', {
      code: buildCffCode(path.join(FUNCTIONS_DIR, 'viewer-request.js'), viewerRequestReplacements()),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'Bot detection + KVS marker routing; cf.beacon format_needed',
      keyValueStore: this.kvsStore,
      functionName: `viewer-request-${cdk.Names.uniqueId(this)}`.substring(0, CFF_NAME_MAX_LENGTH),
    });

    this.responseCff = new cloudfront.Function(this, 'ViewerResponseCff', {
      code: buildCffCode(path.join(FUNCTIONS_DIR, 'viewer-response.js'), viewerResponseReplacements()),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'Format status header; cf.beacon object_missing',
      functionName: `viewer-response-${cdk.Names.uniqueId(this)}`.substring(0, CFF_NAME_MAX_LENGTH),
    });

    // CloudFront Functions log to us-east-1 under /aws/cloudfront/function/<name>. The stack owns
    // the groups so the dashboard's metric filters have a target and `cdk destroy` removes them.
    this.requestCffLogGroup = new logs.LogGroup(this, 'RequestCffLogGroup', {
      logGroupName: `/aws/cloudfront/function/${this.requestCff.functionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.responseCffLogGroup = new logs.LogGroup(this, 'ResponseCffLogGroup', {
      logGroupName: `/aws/cloudfront/function/${this.responseCff.functionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }
}
