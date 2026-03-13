import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as logsDestinations from 'aws-cdk-lib/aws-logs-destinations';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib/core';
import * as path from 'path';
import {
  SIGNAL_FORMAT_NEEDED,
  SIGNAL_OBJECT_MISSING,
  FORMAT_TTL_SECONDS,
  GENERATOR_MEMORY_SIZE_MB,
  GENERATOR_TIMEOUT_MINUTES,
  PARSER_TIMEOUT_SECONDS,
  KVS_SYNC_TIMEOUT_SECONDS,
  QUEUE_VISIBILITY_TIMEOUT_MINUTES,
  QUEUE_RETENTION_DAYS,
  KVS_SYNC_BATCH_SIZE,
  KVS_SYNC_RETRY_ATTEMPTS,
  SQS_GENERATOR_BATCH_SIZE,
  DDB_PARTITION_KEY,
  DDB_TTL_ATTRIBUTE,
} from '../constants';

export interface GenerationPipelineProps {
  /** S3 bucket for writing generated format outputs */
  formatsBucket: s3.IBucket;
  distributionDomainName: string;
  distributionId: string;
  kvsStore: cloudfront.KeyValueStore;
  primaryCffLogGroup: logs.LogGroup;
  failoverCffLogGroup: logs.LogGroup;
}

export class GenerationPipeline extends Construct {
  public readonly queue: sqs.Queue;
  public readonly parserFunction: lambdaNodejs.NodejsFunction;
  public readonly generatorFunction: lambdaNodejs.NodejsFunction;
  public readonly kvsSyncFunction: lambdaNodejs.NodejsFunction;
  public readonly markersTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: GenerationPipelineProps) {
    super(scope, id);

    // --- SQS FIFO Queue ---
    this.queue = new sqs.Queue(this, 'GenerationQueue', {
      fifo: true,
      contentBasedDeduplication: false,
      visibilityTimeout: cdk.Duration.minutes(QUEUE_VISIBILITY_TIMEOUT_MINUTES),
      retentionPeriod: cdk.Duration.days(QUEUE_RETENTION_DAYS),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });

    // --- Parser Lambda ---
    this.parserFunction = new lambdaNodejs.NodejsFunction(this, 'ParserFunction', {
      entry: path.join(__dirname, '../../functions/parser/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      environment: {
        QUEUE_URL: this.queue.queueUrl,
      },
      timeout: cdk.Duration.seconds(PARSER_TIMEOUT_SECONDS),
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
    });
    this.queue.grantSendMessages(this.parserFunction);

    // --- DynamoDB Markers Table ---
    this.markersTable = new dynamodb.Table(this, 'MarkersTable', {
      partitionKey: { name: DDB_PARTITION_KEY, type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      timeToLiveAttribute: DDB_TTL_ATTRIBUTE,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    // --- Generator Lambda (NodejsFunction for esbuild bundling of turndown) ---
    this.generatorFunction = new lambdaNodejs.NodejsFunction(this, 'GeneratorFunction', {
      entry: path.join(__dirname, '../../functions/generator/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: cdk.Duration.minutes(GENERATOR_TIMEOUT_MINUTES),
      memorySize: GENERATOR_MEMORY_SIZE_MB,
      environment: {
        BUCKET_NAME: props.formatsBucket.bucketName,
        DISTRIBUTION_DOMAIN: props.distributionDomainName,
        TABLE_NAME: this.markersTable.tableName,
        FORMAT_TTL_SECONDS: String(FORMAT_TTL_SECONDS),
      },
      bundling: {
        externalModules: ['@aws-sdk/client-s3', '@aws-sdk/client-dynamodb'],
      },
    });

    // Grant permissions — generator only writes (PutObject) to the formats bucket
    props.formatsBucket.grantPut(this.generatorFunction);
    this.markersTable.grantWriteData(this.generatorFunction);

    // SQS trigger for Generator Lambda
    this.generatorFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(this.queue, {
        batchSize: SQS_GENERATOR_BATCH_SIZE,
      })
    );

    // --- KVS Sync Lambda ---
    // CloudFront KVS client requires SigV4a which is not in the Lambda runtime SDK.
    // Bundle the KVS client + signature-v4a; keep S3 client external (available in runtime).
    this.kvsSyncFunction = new lambdaNodejs.NodejsFunction(this, 'KvsSyncFunction', {
      entry: path.join(__dirname, '../../functions/kvs-sync/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      environment: {
        KVS_ARN: props.kvsStore.keyValueStoreArn,
        FORMATS_BUCKET: props.formatsBucket.bucketName,
        DISTRIBUTION_ID: props.distributionId,
      },
      timeout: cdk.Duration.seconds(KVS_SYNC_TIMEOUT_SECONDS),
      bundling: {
        externalModules: ['@aws-sdk/client-s3', '@aws-sdk/client-cloudfront'],
      },
    });

    // Grant S3 delete permission for format cleanup on marker expiry (explicit action, no wildcard)
    this.kvsSyncFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:DeleteObject'],
      resources: [props.formatsBucket.arnForObjects('*')],
    }));

    // Grant KVS permissions
    this.kvsSyncFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cloudfront-keyvaluestore:PutKey',
        'cloudfront-keyvaluestore:DeleteKey',
        'cloudfront-keyvaluestore:DescribeKeyValueStore',
      ],
      resources: [props.kvsStore.keyValueStoreArn],
    }));

    // Grant CloudFront invalidation permission (clear stale failover-cached HTML at formats path)
    this.kvsSyncFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudfront:CreateInvalidation'],
      resources: [`arn:aws:cloudfront::${cdk.Aws.ACCOUNT_ID}:distribution/${props.distributionId}`],
    }));

    // DynamoDB Stream trigger for KVS Sync Lambda (batchSize: 1 for strict ordering)
    this.kvsSyncFunction.addEventSource(
      new lambdaEventSources.DynamoEventSource(this.markersTable, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: KVS_SYNC_BATCH_SIZE,
        retryAttempts: KVS_SYNC_RETRY_ATTEMPTS,
      })
    );

    // --- CloudWatch Subscription Filters on both CFF log groups ---
    const filterPattern = logs.FilterPattern.any(
      logs.FilterPattern.stringValue('$.signal', '=', SIGNAL_FORMAT_NEEDED),
      logs.FilterPattern.stringValue('$.signal', '=', SIGNAL_OBJECT_MISSING)
    );

    new logs.SubscriptionFilter(this, 'PrimaryCffSubscription', {
      logGroup: props.primaryCffLogGroup,
      destination: new logsDestinations.LambdaDestination(this.parserFunction),
      filterPattern,
    });

    new logs.SubscriptionFilter(this, 'FailoverCffSubscription', {
      logGroup: props.failoverCffLogGroup,
      destination: new logsDestinations.LambdaDestination(this.parserFunction),
      filterPattern,
    });
  }
}
