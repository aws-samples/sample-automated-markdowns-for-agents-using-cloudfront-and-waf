import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { gunzipSync } from 'zlib';
import { logger } from '../shared/logger';
import { SIGNAL_FORMAT_NEEDED, SIGNAL_OBJECT_MISSING, DEFAULT_FORMAT } from '../../lib/constants';

const sqs = new SQSClient({});
const QUEUE_URL = process.env.QUEUE_URL!;

interface CloudWatchLogsEvent {
  awslogs: {
    data: string;
  };
}

interface LogEvent {
  timestamp: number;
  message: string;
}

interface DecodedLogData {
  logEvents: LogEvent[];
}

interface Signal {
  signal: string;
  uri: string;
  format?: string;
  expired?: boolean;
  original_uri?: string;
}

export const handler = async (event: CloudWatchLogsEvent): Promise<void> => {
  // Decode base64 + gzip CloudWatch Logs payload
  const compressedData = Buffer.from(event.awslogs.data, 'base64');
  const decompressed = gunzipSync(compressedData);
  const logData: DecodedLogData = JSON.parse(decompressed.toString());

  for (const logEvent of logData.logEvents) {
    let signal: Signal;
    try {
      // CFF log messages have format: "<request-id> <json>"
      // Extract JSON starting from the first '{' character
      const jsonStart = logEvent.message.indexOf('{');
      if (jsonStart === -1) continue;
      signal = JSON.parse(logEvent.message.slice(jsonStart));
    } catch {
      continue; // Not a structured log — skip
    }

    // Only process format_needed and object_missing signals
    if (signal.signal !== SIGNAL_FORMAT_NEEDED && signal.signal !== SIGNAL_OBJECT_MISSING) {
      continue;
    }

    // Determine the original URI
    const uri = signal.signal === SIGNAL_OBJECT_MISSING ? signal.original_uri! : signal.uri;

    const format = signal.format || DEFAULT_FORMAT;
    logger.info('SendingToSQS', { uri, format, source: signal.signal });
    await sqs.send(new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify({
        uri,
        format,
        requestedAt: logEvent.timestamp,
      }),
      MessageGroupId: uri,
      MessageDeduplicationId: uri,
    }));
  }
};
