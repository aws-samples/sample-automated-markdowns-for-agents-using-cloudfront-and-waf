import * as cdk from 'aws-cdk-lib/core';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as path from 'path';
import { Construct } from 'constructs';
import { OriginLayer } from './constructs/origin-layer';
import { EdgeLayer } from './constructs/edge-layer';
import { GenerationPipeline, GenerationQueue } from './constructs/generation-pipeline';
import { OperationalDashboard } from './constructs/dashboard';

export class MarkdownGenerationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- Origin Layer (customer's content + formats bucket) ---
    const originLayer = new OriginLayer(this, 'OriginLayer');

    // --- Generation queue (the signal API writes, the Generator reads) ---
    const generationQueue = new GenerationQueue(this, 'GenerationQueue');

    // --- Edge Layer (CloudFront + WAF + CFF + KVS + signal API) ---
    const edgeLayer = new EdgeLayer(this, 'EdgeLayer', {
      contentOrigin: originLayer.contentOrigin,
      formatsBucket: originLayer.formatsBucket,
      queue: generationQueue.queue,
    });

    // --- Generation Pipeline (SQS → Generator → S3 + DDB → KVS) ---
    const pipeline = new GenerationPipeline(this, 'GenerationPipeline', {
      formatsBucket: originLayer.formatsBucket,
      distributionDomainName: edgeLayer.distribution.distributionDomainName,
      kvsStore: edgeLayer.kvsStore,
      queue: generationQueue.queue,
    });

    // --- Deploy sample content with CloudFront cache invalidation ---
    new s3deploy.BucketDeployment(this, 'DeploySampleContent', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../sample-content'))],
      destinationBucket: originLayer.contentBucket,
      distribution: edgeLayer.distribution,
      distributionPaths: ['/*'],
    });

    // --- Operational Dashboard ---
    new OperationalDashboard(this, 'OperationalDashboard', {
      distribution: edgeLayer.distribution,
      webAcl: edgeLayer.webAcl,
      signalApi: edgeLayer.signalApi,
      generatorFunction: pipeline.generatorFunction,
      kvsSyncFunction: pipeline.kvsSyncFunction,
      queue: pipeline.queue,
      markersTable: pipeline.markersTable,
      requestCffLogGroup: edgeLayer.requestCffLogGroup,
    });

    // --- Stack Outputs ---
    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: edgeLayer.distribution.distributionDomainName,
      description: 'CloudFront distribution domain name',
    });

    new cdk.CfnOutput(this, 'ContentBucketName', {
      value: originLayer.contentBucket.bucketName,
      description: 'S3 content bucket name (customer origin)',
    });

    new cdk.CfnOutput(this, 'FormatsBucketName', {
      value: originLayer.formatsBucket.bucketName,
      description: 'S3 formats bucket name (generated outputs)',
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: edgeLayer.distribution.distributionId,
      description: 'CloudFront distribution ID',
    });
  }
}
