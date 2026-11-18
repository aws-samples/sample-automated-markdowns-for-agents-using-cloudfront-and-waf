import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
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
  SIGNAL_PASSTHROUGH,
  METRIC_NAMESPACE,
  DASHBOARD_NAME,
} from '../constants';

export interface DashboardProps {
  distribution: cloudfront.Distribution;
  webAcl: wafv2.CfnWebACL;
  signalApi: apigateway.RestApi;
  generatorFunction: lambdaNodejs.NodejsFunction;
  kvsSyncFunction: lambda.Function;
  queue: sqs.Queue;
  markersTable: dynamodb.Table;
  /** The viewer-request function's log group: its DEBUG lines (format_served, passthrough) */
  requestCffLogGroup: logs.LogGroup;
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

    const passthroughFilter = new logs.MetricFilter(this, 'PassthroughFilter', {
      logGroup: props.requestCffLogGroup,
      filterPattern: logs.FilterPattern.stringValue('$.signal', '=', SIGNAL_PASSTHROUGH),
      metricNamespace: METRIC_NAMESPACE,
      metricName: 'Passthrough',
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
    // Signals: what the functions beaconed (the API's requests) and what reached the queue
    const signalsSent = props.signalApi.metricCount({ statistic: 'Sum', label: 'Signals (API requests)' });
    const messagesQueued = props.queue.metricNumberOfMessagesSent({ statistic: 'Sum', label: 'Queued (SQS messages sent)' });
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
          // Agent requests the format was served to, of all the requests AWS WAF marked for a format
          expression: 'IF(b > 0, s/b*100, 0)',
          usingMetrics: { s: formatServed, b: formatConvert },
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
        left: [formatConvert, formatServed, signalsSent, messagesQueued],
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

    // Pipeline row — SQS + Generator + signal API (even thirds)
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
        title: 'Signal API (cf.beacon target) and queue',
        width: 8,
        height: 6,
        left: [
          signalsSent,
          props.signalApi.metricClientError({ statistic: 'Sum', label: '4xx (rejected signals)' }),
          props.signalApi.metricServerError({ statistic: 'Sum', label: '5xx' }),
        ],
        right: [messagesQueued],
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
