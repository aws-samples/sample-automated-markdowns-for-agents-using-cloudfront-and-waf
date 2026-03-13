import { Construct } from 'constructs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';
import * as path from 'path';
import { buildCffCode } from './cff-code';
import {
  CFF_NAME_MAX_LENGTH,
  HEADER_SKIP_CONVERSION,
  WAF_HEADER_NO_CONVERT,
  WAF_HEADER_FORMAT_CONVERT,
  FORMATS_ORIGIN_ID,
  FORMAT_MISSING_ORIGIN_ID,
  ORIGIN_GROUP_FAILOVER_STATUS_CODES,
  ACTION_REWRITE,
  SIGNAL_PASSTHROUGH,
  SIGNAL_FORMAT_SERVED,
  SIGNAL_FORMAT_NEEDED,
  SIGNAL_OBJECT_MISSING,
} from '../../constants';

export class RoutingFunctions extends Construct {
  public readonly kvsStore: cloudfront.KeyValueStore;
  public readonly primaryCff: cloudfront.Function;
  public readonly failoverCff: cloudfront.Function;
  public readonly primaryCffLogGroup: logs.LogGroup;
  public readonly failoverCffLogGroup: logs.LogGroup;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.kvsStore = new cloudfront.KeyValueStore(this, 'MarkerKvs', {
      comment: 'URI-to-format marker store for CFF routing decisions',
    });

    const primaryCode = buildCffCode(
      path.join(__dirname, '../../../functions/cloudfront/viewer-request.js'),
      {
        HEADER_SKIP_CONVERSION,
        HEADER_NO_CONVERT: `x-amzn-waf-${WAF_HEADER_NO_CONVERT}`,
        HEADER_FORMAT_CONVERT: `x-amzn-waf-${WAF_HEADER_FORMAT_CONVERT}`,
        FORMATS_ORIGIN_ID,
        FORMAT_MISSING_ORIGIN_ID,
        FAILOVER_STATUS_CODES: JSON.stringify(ORIGIN_GROUP_FAILOVER_STATUS_CODES),
        ACTION_REWRITE,
        SIGNAL_PASSTHROUGH,
        SIGNAL_FORMAT_SERVED,
        SIGNAL_FORMAT_NEEDED,
      },
    );

    this.primaryCff = new cloudfront.Function(this, 'ViewerRequestCff', {
      code: primaryCode,
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'Bot detection + KVS marker routing',
      keyValueStore: this.kvsStore,
      functionName: `viewer-request-${cdk.Names.uniqueId(this)}`.substring(0, CFF_NAME_MAX_LENGTH),
    });

    const failoverCode = buildCffCode(
      path.join(__dirname, '../../../functions/cloudfront/failover-request.js'),
      { SIGNAL_OBJECT_MISSING },
    );

    this.failoverCff = new cloudfront.Function(this, 'FailoverRequestCff', {
      code: failoverCode,
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'Format-Missing: strip /formats/<format>/ prefix, log object_missing',
      functionName: `failover-request-${cdk.Names.uniqueId(this)}`.substring(0, CFF_NAME_MAX_LENGTH),
    });

    this.primaryCffLogGroup = new logs.LogGroup(this, 'PrimaryCffLogGroup', {
      logGroupName: `/aws/cloudfront/function/${this.primaryCff.functionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.failoverCffLogGroup = new logs.LogGroup(this, 'FailoverCffLogGroup', {
      logGroupName: `/aws/cloudfront/function/${this.failoverCff.functionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }
}
