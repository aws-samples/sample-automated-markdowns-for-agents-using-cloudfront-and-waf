import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib/core';
import * as path from 'path';
import {
  FORMAT_TTL_SECONDS,
  GENERATOR_MEMORY_SIZE_MB,
  GENERATOR_TIMEOUT_MINUTES,
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
  kvsStore: cloudfront.KeyValueStore;
  /** The FIFO queue the signal API fills (see GenerationQueue) */
  queue: sqs.Queue;
}

/**
 * The SQS FIFO queue between the edge and the generator. Created before the distribution:
 * the signal API (an origin) writes to it, the Generator Lambda reads it.
 */
export class GenerationQueue extends Construct {
  public readonly queue: sqs.Queue;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.queue = new sqs.Queue(this, 'GenerationQueue', {
      fifo: true,
      contentBasedDeduplication: false,
      visibilityTimeout: cdk.Duration.minutes(QUEUE_VISIBILITY_TIMEOUT_MINUTES),
      retentionPeriod: cdk.Duration.days(QUEUE_RETENTION_DAYS),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });
  }
}

export class GenerationPipeline extends Construct {
  public readonly queue: sqs.Queue;
  public readonly generatorFunction: lambdaNodejs.NodejsFunction;
  public readonly kvsSyncFunction: lambdaNodejs.NodejsFunction;
  public readonly markersTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: GenerationPipelineProps) {
    super(scope, id);

    this.queue = props.queue;

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
      },
      timeout: cdk.Duration.seconds(KVS_SYNC_TIMEOUT_SECONDS),
      bundling: {
        externalModules: ['@aws-sdk/client-s3'],
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

    // DynamoDB Stream trigger for KVS Sync Lambda (batchSize: 1 for strict ordering)
    this.kvsSyncFunction.addEventSource(
      new lambdaEventSources.DynamoEventSource(this.markersTable, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: KVS_SYNC_BATCH_SIZE,
        retryAttempts: KVS_SYNC_RETRY_ATTEMPTS,
      })
    );
  }
}
