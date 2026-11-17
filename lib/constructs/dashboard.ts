import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import {
  WAF_ACL_METRIC_NAME,
  WAF_METRIC_FORMAT_CONVERT,
  WAF_METRIC_DO_NOT_CONVERT,
  SIGNAL_FORMAT_SERVED,
  SIGNAL_FORMAT_NEEDED,
  SIGNAL_OBJECT_MISSING,
  SIGNAL_PASSTHROUGH,
  METRIC_NAMESPACE,
  DASHBOARD_NAME,
} from '../constants';

export interface DashboardProps {
  distribution: cloudfront.Distribution;
  webAcl: wafv2.CfnWebACL;
  signalFunction: lambda.WebFunction;
  generatorFunction: lambdaNodejs.NodejsFunction;
  kvsSyncFunction: lambda.Function;
  queue: sqs.Queue;
  markersTable: dynamodb.Table;
  requestCffLogGroup: logs.LogGroup;
  responseCffLogGroup: logs.LogGroup;
}

export class OperationalDashboard extends Construct {
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: DashboardProps) {
    super(scope, id);

    const cfDims = { DistributionId: props.distribution.distributionId, Region: 'Global' };
    const wafDims = (rule: string) => ({ WebACL: WAF_ACL_METRIC_NAME, Rule: rule });

    // --- Metric Filters ---
    const formatServedFilter = new logs.MetricFilter(this, 'FormatServedFilter', {
      logGroup: props.requestCffLogGroup,
      filterPattern: logs.FilterPattern.stringValue('$.signal', '=', SIGNAL_FORMAT_SERVED),
      metricNamespace: METRIC_NAMESPACE,
      metricName: 'FormatServed',
      metricValue: '1',
    });

    const formatNeededFilter = new logs.MetricFilter(this, 'FormatNeededFilter', {
      logGroup: props.requestCffLogGroup,
      filterPattern: logs.FilterPattern.stringValue('$.signal', '=', SIGNAL_FORMAT_NEEDED),
      metricNamespace: METRIC_NAMESPACE,
      metricName: 'FormatNeeded',
      metricValue: '1',
    });

    const passthroughFilter = new logs.MetricFilter(this, 'PassthroughFilter', {
      logGroup: props.requestCffLogGroup,
      filterPattern: logs.FilterPattern.stringValue('$.signal', '=', SIGNAL_PASSTHROUGH),
      metricNamespace: METRIC_NAMESPACE,
      metricName: 'Passthrough',
      metricValue: '1',
    });

    // object_missing comes from the viewer-response function
    const objectMissingFilter = new logs.MetricFilter(this, 'ObjectMissingFilter', {
      logGroup: props.responseCffLogGroup,
      filterPattern: logs.FilterPattern.stringValue('$.signal', '=', SIGNAL_OBJECT_MISSING),
      metricNamespace: METRIC_NAMESPACE,
      metricName: 'ObjectMissing',
      metricValue: '1',
    });

    // --- Pipeline latency metric filters (from Generator & KVS Sync log groups) ---
    const pipelineToS3Filter = new logs.MetricFilter(this, 'PipelineToS3Filter', {
      logGroup: props.generatorFunction.logGroup,
      filterPattern: logs.FilterPattern.stringValue('$.metric', '=', 'PipelineToS3'),
      metricNamespace: METRIC_NAMESPACE,
      metricName: 'PipelineToS3',
      metricValue: '$.duration',
    });

    const pipelineToKvsFilter = new logs.MetricFilter(this, 'PipelineToKvsFilter', {
      logGroup: props.kvsSyncFunction.logGroup,
      filterPattern: logs.FilterPattern.stringValue('$.metric', '=', 'PipelineToKvs'),
      metricNamespace: METRIC_NAMESPACE,
      metricName: 'PipelineToKvs',
      metricValue: '$.duration',
    });

    // --- Reusable metrics ---
    const formatServed = formatServedFilter.metric({ statistic: 'Sum', label: 'Format Served' });
    const formatNeeded = formatNeededFilter.metric({ statistic: 'Sum', label: 'Format Needed' });
    const objectMissing = objectMissingFilter.metric({ statistic: 'Sum', label: 'Object Missing' });
    const passthrough = passthroughFilter.metric({ statistic: 'Sum', label: 'Passthrough' });

    const formatConvert = new cloudwatch.Metric({
      namespace: 'AWS/WAFV2', metricName: 'CountedRequests',
      dimensionsMap: wafDims(WAF_METRIC_FORMAT_CONVERT), statistic: 'Sum', label: 'Format Convert Needed',
    });

    const totalRequests = new cloudwatch.Metric({
      namespace: 'AWS/CloudFront', metricName: 'Requests',
      dimensionsMap: cfDims, statistic: 'Sum', label: 'Total Requests',
    });

    // --- Dashboard ---
    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: DASHBOARD_NAME,
    });

    // =====================================================================
    //  BUSINESS METRICS
    // =====================================================================
    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({ markdown: '# Business Metrics', width: 24, height: 1 }),
    );

    // KPI row — four evenly-spaced single-value cards
    this.dashboard.addWidgets(
      new cloudwatch.SingleValueWidget({
        title: 'Format Hit Rate',
        width: 6,
        height: 4,
        metrics: [new cloudwatch.MathExpression({
          expression: 'IF(s+n+m > 0, s/(s+n+m)*100, 0)',
          usingMetrics: { s: formatServed, n: formatNeeded, m: objectMissing },
          label: '%',
        })],
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Format Conversion Traffic',
        width: 6,
        height: 4,
        metrics: [new cloudwatch.MathExpression({
          expression: 'IF(t > 0, b/t*100, 0)',
          usingMetrics: { b: formatConvert, t: totalRequests },
          label: '%',
        })],
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Passthrough / Do-Not-Convert',
        width: 6,
        height: 4,
        metrics: [
          passthrough,
          new cloudwatch.Metric({
            namespace: 'AWS/WAFV2', metricName: 'CountedRequests',
            dimensionsMap: wafDims(WAF_METRIC_DO_NOT_CONVERT), statistic: 'Sum', label: 'Do-Not-Convert',
          }),
        ],
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Cache Hit Rate',
        width: 6,
        height: 4,
        metrics: [new cloudwatch.Metric({
          namespace: 'AWS/CloudFront', metricName: 'CacheHitRate',
          dimensionsMap: cfDims, statistic: 'Average', label: '%',
        })],
      }),
    );

    // Funnel + Traffic graphs — two clean half-width panels
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Format Conversion Funnel',
        width: 12,
        height: 8,
        stacked: true,
        left: [formatConvert, formatServed, formatNeeded, objectMissing],
      }),
      new cloudwatch.GraphWidget({
        title: 'Total vs Format Conversion Traffic',
        width: 12,
        height: 8,
        left: [
          totalRequests,
          new cloudwatch.Metric({
            namespace: 'AWS/WAFV2', metricName: 'AllowedRequests',
            dimensionsMap: wafDims('ALL'), statistic: 'Sum', label: 'WAF Allowed',
          }),
          formatConvert,
        ],
      }),
    );

    // =====================================================================
    //  PIPELINE & INFRASTRUCTURE
    // =====================================================================
    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({ markdown: '# Pipeline & Infrastructure', width: 24, height: 1 }),
    );

    // Pipeline latency — end-to-end time from CFF signal to S3 write and KVS sync
    const s3AvgMs = pipelineToS3Filter.metric({ statistic: 'Average' });
    const kvsAvgMs = pipelineToKvsFilter.metric({ statistic: 'Average' });
    const s3P99Ms = pipelineToS3Filter.metric({ statistic: 'p99' });
    const kvsP99Ms = pipelineToKvsFilter.metric({ statistic: 'p99' });

    const toSeconds = (id: string, src: cloudwatch.Metric, label: string) =>
      new cloudwatch.MathExpression({
        expression: `${id}_raw / 1000`,
        usingMetrics: { [`${id}_raw`]: src },
        label,
      });

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Pipeline Latency (CFF signal to S3 / KVS)',
        width: 12,
        height: 6,
        left: [
          toSeconds('s3avg', s3AvgMs, 'Avg to S3 (s)'),
          toSeconds('kvsavg', kvsAvgMs, 'Avg to KVS (s)'),
        ],
        right: [
          toSeconds('s3p99', s3P99Ms, 'p99 to S3 (s)'),
          toSeconds('kvsp99', kvsP99Ms, 'p99 to KVS (s)'),
        ],
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Current Pipeline Latency',
        width: 12,
        height: 6,
        metrics: [
          toSeconds('csv_s3avg', s3AvgMs, 'Avg to S3 (s)'),
          toSeconds('csv_kvsavg', kvsAvgMs, 'Avg to KVS (s)'),
          toSeconds('csv_s3p99', s3P99Ms, 'p99 to S3 (s)'),
          toSeconds('csv_kvsp99', kvsP99Ms, 'p99 to KVS (s)'),
        ],
      }),
    );

    // A Web Function publishes its own metrics in AWS/Lambda/Web, by function name
    const signalMetric = (metricName: string, statistic: string, label: string) => new cloudwatch.Metric({
      namespace: 'AWS/Lambda/Web', metricName, statistic, label,
      dimensionsMap: { FunctionName: props.signalFunction.webFunctionName },
    });

    // Pipeline row — SQS + Generator + Signal Web Function (even thirds)
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'SQS Queue Health',
        width: 8,
        height: 6,
        left: [
          props.queue.metricApproximateNumberOfMessagesVisible({ label: 'Backlog' }),
          props.queue.metricApproximateNumberOfMessagesNotVisible({ label: 'In Flight' }),
        ],
        right: [
          props.queue.metric('ApproximateAgeOfOldestMessage', { statistic: 'Maximum', label: 'Oldest Msg Age (s)' }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Generator Lambda',
        width: 8,
        height: 6,
        left: [
          props.generatorFunction.metricInvocations({ label: 'Invocations' }),
          props.generatorFunction.metricErrors({ label: 'Errors' }),
        ],
        right: [props.generatorFunction.metricDuration({ label: 'Duration (ms)' })],
      }),
      new cloudwatch.GraphWidget({
        title: 'Signal Web Function (cf.beacon target)',
        width: 8,
        height: 6,
        left: [
          signalMetric('ExecutedRequests', 'Sum', 'Requests'),
          signalMetric('HTTPResponseStatusClass4XX', 'Sum', '4xx (rejected signals)'),
          signalMetric('HTTPResponseStatusClass5XX', 'Sum', '5xx'),
        ],
        right: [signalMetric('EnvironmentConcurrentRequests', 'Maximum', 'Concurrent requests')],
      }),
    );

    // KVS Sync + DDB row (even thirds)
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'KVS Sync Lambda',
        width: 8,
        height: 6,
        left: [
          props.kvsSyncFunction.metricInvocations({ label: 'Invocations' }),
          props.kvsSyncFunction.metricErrors({ label: 'Errors' }),
        ],
        right: [props.kvsSyncFunction.metricDuration({ label: 'Duration (ms)' })],
      }),
      new cloudwatch.GraphWidget({
        title: 'DDB Stream Iterator Age',
        width: 8,
        height: 6,
        left: [new cloudwatch.Metric({
          namespace: 'AWS/Lambda', metricName: 'IteratorAge',
          dimensionsMap: { FunctionName: props.kvsSyncFunction.functionName },
          statistic: 'Maximum', label: 'Iterator Age (ms)',
        })],
      }),
      new cloudwatch.SingleValueWidget({
        title: 'DynamoDB Capacity',
        width: 8,
        height: 6,
        metrics: [
          props.markersTable.metricConsumedWriteCapacityUnits({ label: 'Write CU', statistic: 'Sum' }),
          props.markersTable.metricConsumedReadCapacityUnits({ label: 'Read CU', statistic: 'Sum' }),
        ],
      }),
    );

    // =====================================================================
    //  ERRORS & HEALTH
    // =====================================================================
    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({ markdown: '# Errors & Health', width: 24, height: 1 }),
    );

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'CloudFront Error Rates',
        width: 12,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/CloudFront', metricName: '4xxErrorRate',
            dimensionsMap: cfDims, statistic: 'Average', label: '4xx Error Rate',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/CloudFront', metricName: '5xxErrorRate',
            dimensionsMap: cfDims, statistic: 'Average', label: '5xx Error Rate',
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'WAF Blocked Requests',
        width: 12,
        height: 6,
        left: [new cloudwatch.Metric({
          namespace: 'AWS/WAFV2', metricName: 'BlockedRequests',
          dimensionsMap: wafDims('ALL'), statistic: 'Sum', label: 'Blocked',
        })],
      }),
    );
  }
}
