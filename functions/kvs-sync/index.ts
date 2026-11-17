import {
  CloudFrontKeyValueStoreClient,
  PutKeyCommand,
  DeleteKeyCommand,
  DescribeKeyValueStoreCommand,
} from '@aws-sdk/client-cloudfront-keyvaluestore';
import '@aws-sdk/signature-v4a'; // Required for SigV4a signing used by CloudFront KVS
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { logger } from '../shared/logger';
import { ACTION_REWRITE } from '../../lib/constants';

const kvsClient = new CloudFrontKeyValueStoreClient({});
const s3Client = new S3Client({});
const KVS_ARN = process.env.KVS_ARN!;
const FORMATS_BUCKET = process.env.FORMATS_BUCKET!;

interface KvsMarker {
  action: string;
  path: string;
  ttl: number;
  headers?: Record<string, string>;
}

async function getKvsEtag(): Promise<string> {
  const response = await kvsClient.send(
    new DescribeKeyValueStoreCommand({ KvsARN: KVS_ARN })
  );
  return response.ETag!;
}

async function deleteKvsKey(uri: string, etag: string): Promise<void> {
  await kvsClient.send(new DeleteKeyCommand({
    KvsARN: KVS_ARN,
    Key: uri,
    IfMatch: etag,
  }));
  logger.info('KvsDeleteSuccess', { uri });
}

async function deleteFormatFromS3(uri: string, path: string): Promise<void> {
  const s3Key = path.startsWith('/') ? path.slice(1) : path;
  await s3Client.send(new DeleteObjectCommand({
    Bucket: FORMATS_BUCKET,
    Key: s3Key,
  }));
  logger.info('S3DeleteSuccess', { uri, s3Key });
}

async function putKvsMarker(uri: string, marker: KvsMarker, etag: string): Promise<void> {
  await kvsClient.send(new PutKeyCommand({
    KvsARN: KVS_ARN,
    Key: uri,
    Value: JSON.stringify(marker),
    IfMatch: etag,
  }));
  logger.info('KvsPutSuccess', { uri });
}

async function handleRemove(record: DynamoDBStreamEvent['Records'][number], etag: string): Promise<void> {
  const uri = record.dynamodb?.Keys?.uri?.S;
  if (!uri) return;

  await deleteKvsKey(uri, etag);

  const oldPath = record.dynamodb?.OldImage?.path?.S;
  if (oldPath) {
    await deleteFormatFromS3(uri, oldPath);
  }
}

async function handleUpsert(record: DynamoDBStreamEvent['Records'][number], etag: string): Promise<void> {
  const newImage = record.dynamodb?.NewImage;
  if (!newImage) return;

  const uri = newImage.uri?.S;
  if (!uri) return;

  const marker: KvsMarker = {
    action: newImage.action?.S ?? ACTION_REWRITE,
    path: newImage.path?.S ?? '',
    ttl: parseInt(newImage.ttl?.N ?? '0', 10),
  };

  if (newImage.headers?.S) {
    try {
      marker.headers = JSON.parse(newImage.headers.S);
    } catch {
      logger.error('KvsHeaderParseError', { uri, raw: newImage.headers.S });
    }
  }

  await putKvsMarker(uri, marker, etag);

  // No invalidation: the viewer-request function puts the marker's TTL in the cache key
  // (x-format-version), so a new marker is a new cache entry at every edge.

  const requestedAt = newImage.requestedAt?.N ? parseInt(newImage.requestedAt.N, 10) : null;
  if (requestedAt) {
    logger.info('PipelineToKvs', { uri, duration: Date.now() - requestedAt });
  }
}

async function processRecord(record: DynamoDBStreamEvent['Records'][number]): Promise<void> {
  const etag = await getKvsEtag();

  if (record.eventName === 'REMOVE') {
    await handleRemove(record, etag);
  } else {
    await handleUpsert(record, etag);
  }
}

export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (error) {
      logger.error('KvsSyncError', { error: String(error), record: JSON.stringify(record) });
      throw error; // Rethrow to retry via DDB stream
    }
  }
};
