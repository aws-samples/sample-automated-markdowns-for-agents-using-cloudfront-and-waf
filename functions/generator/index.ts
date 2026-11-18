import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import type { SQSEvent } from 'aws-lambda';
import { converters, Converter, ConvertResult } from './converters';
import { logger } from '../shared/logger';
import { HEADER_SKIP_CONVERSION, ACTION_REWRITE, DEFAULT_ROOT_OBJECT } from '../../lib/constants';

const s3 = new S3Client({});
const ddb = new DynamoDBClient({});

const BUCKET_NAME = process.env.BUCKET_NAME!;
const DISTRIBUTION_DOMAIN = process.env.DISTRIBUTION_DOMAIN!;
const TABLE_NAME = process.env.TABLE_NAME!;
const FORMAT_TTL_SECONDS = parseInt(process.env.FORMAT_TTL_SECONDS || '86400', 10);

interface SQSMessage {
  uri: string;
  format: string;
  requestedAt?: number;
}

async function fetchOriginalHtml(uri: string): Promise<string | null> {
  const htmlUrl = `https://${DISTRIBUTION_DOMAIN}${uri}`;
  const response = await fetch(htmlUrl, {
    headers: { [HEADER_SKIP_CONVERSION]: 'true' },
  });

  if (!response.ok) {
    logger.error('GenerationError', { uri, status: response.status });
    return null;
  }

  return response.text();
}

async function storeConvertedContent(
  uri: string,
  format: string,
  result: ConvertResult,
  converter: Converter,
): Promise<string> {
  // The formats origin has origin path /formats/<format>, and CloudFront asks it for the
  // default root object when the viewer asks for "/".
  const objectPath = uri === '/' ? `/${DEFAULT_ROOT_OBJECT}` : uri;
  const formatKey = `formats/${format}${objectPath}`;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: formatKey,
    Body: result.content,
    ContentType: `${converter.contentType}; charset=utf-8`,
    Metadata: result.metadata,
  }));
  return formatKey;
}

async function writeMarker(
  uri: string,
  format: string,
  formatKey: string,
  metadata: Record<string, string>,
  requestedAt?: number,
): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + FORMAT_TTL_SECONDS;
  const ddbItem: Record<string, { S: string } | { N: string }> = {
    uri: { S: uri },
    action: { S: ACTION_REWRITE },
    path: { S: `/${formatKey}` },
    format: { S: format },
    ttl: { N: String(ttl) },
  };
  const headers = Object.fromEntries(
    Object.entries(metadata).map(([k, v]) => [`x-amz-meta-${k}`, v])
  );
  if (Object.keys(headers).length > 0) {
    ddbItem.headers = { S: JSON.stringify(headers) };
  }
  if (requestedAt) {
    ddbItem.requestedAt = { N: String(requestedAt) };
  }
  await ddb.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: ddbItem,
  }));
}

function emitMetrics(uri: string, startTime: number, requestedAt?: number): void {
  logger.info('GenerationDuration', { uri, duration: Date.now() - startTime });
  if (requestedAt) {
    logger.info('PipelineToS3', { uri, duration: Date.now() - requestedAt });
  }
  logger.info('GenerationSuccess', { uri });
}

async function processMessage(message: SQSMessage): Promise<void> {
  const { uri, format, requestedAt } = message;

  const converter = converters[format];
  if (!converter) {
    logger.error('GenerationError', { uri, error: `Unsupported format: ${format}` });
    return;
  }

  const startTime = Date.now();

  try {
    const html = await fetchOriginalHtml(uri);
    if (html === null) return;

    const result = converter.convert(html);
    const formatKey = await storeConvertedContent(uri, format, result, converter);
    await writeMarker(uri, format, formatKey, result.metadata, requestedAt);
    emitMetrics(uri, startTime, requestedAt);
  } catch (error) {
    logger.error('GenerationError', { uri, error: String(error) });
  }
}

export const handler = async (event: SQSEvent): Promise<void> => {
  for (const record of event.Records) {
    const message: SQSMessage = JSON.parse(record.body);
    await processMessage(message);
  }
};
