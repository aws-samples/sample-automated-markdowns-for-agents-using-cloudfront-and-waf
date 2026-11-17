// The signal origin: a Fastify server on a Lambda Web Function, behind CloudFront OAC.
// The CloudFront Functions cf.beacon their signals here; no cache behavior points at it, so
// viewers cannot reach it, and its IamAuth endpoint answers only this distribution.
//
//   POST /signals {signal, uri, format, expired?}
//     signal: format_needed (viewer-request, KVS miss or expired marker)
//             object_missing (viewer-response, the formats bucket had no object)
//     -> 202 {queued: true}: one SQS FIFO message {uri, format, requestedAt, source},
//        MessageGroupId and MessageDeduplicationId = uri (a burst of agents is one generation)
//     -> 400 {error} for anything else
import Fastify from 'fastify';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

export const SIGNALS = ['format_needed', 'object_missing'];
const MAX_URI_LENGTH = 1024;

/** A signal the queue accepts, or the reason it does not. */
export function validateSignal(body, formats) {
  if (!body || typeof body !== 'object') return { error: 'body must be a JSON object' };
  if (!SIGNALS.includes(body.signal)) return { error: `signal must be one of ${SIGNALS.join(', ')}` };
  const { uri, format } = body;
  if (typeof uri !== 'string' || !uri.startsWith('/') || uri.length > MAX_URI_LENGTH || /[\s\0]/.test(uri)) {
    return { error: 'uri must be a path starting with /' };
  }
  if (!formats.includes(format)) return { error: `format must be one of ${formats.join(', ')}` };
  return { signal: body.signal, uri, format };
}

export function buildApp(options = {}) {
  const queueUrl = options.queueUrl ?? process.env.QUEUE_URL;
  const formats = options.formats ?? (process.env.FORMATS || 'markdown').split(',');
  const sqs = options.sqs ?? new SQSClient({});
  const now = options.now ?? Date.now;
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 10 * 1024 });

  app.post('/signals', async (request, reply) => {
    const signal = validateSignal(request.body, formats);
    if (signal.error) return reply.code(400).send({ error: signal.error });
    const { uri, format } = signal;
    await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({ uri, format, requestedAt: now(), source: signal.signal }),
      MessageGroupId: uri,
      MessageDeduplicationId: uri,
    }));
    request.log.info({ metric: 'SignalQueued', uri, format, source: signal.signal });
    return reply.code(202).send({ queued: true, uri, format });
  });

  return app;
}
