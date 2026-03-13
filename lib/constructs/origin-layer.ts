import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cdk from 'aws-cdk-lib/core';

export class OriginLayer extends Construct {
  /** Sample content bucket (represents any customer origin) */
  public readonly contentBucket: s3.Bucket;
  /** CloudFront origin for the content bucket (customers could swap for ALB, API GW, etc.) */
  public readonly contentOrigin: cloudfront.IOrigin;
  /** Separate bucket for generated format outputs (markdown, etc.) */
  public readonly formatsBucket: s3.Bucket;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Content bucket — represents the customer's existing origin
    this.contentBucket = new s3.Bucket(this, 'ContentBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
    });

    this.contentOrigin = origins.S3BucketOrigin.withOriginAccessControl(this.contentBucket);

    // Sample content deployment is done in the main stack (needs distribution reference for cache invalidation)

    // Formats bucket — stores generated format outputs (/formats/<format>/...)
    this.formatsBucket = new s3.Bucket(this, 'FormatsBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
    });
  }
}
