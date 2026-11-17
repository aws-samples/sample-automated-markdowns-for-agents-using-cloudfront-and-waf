// node --test test/signal-origin.test.mjs
// The signal Web Function (Fastify), exercised with app.inject and a fake SQS client.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp, validateSignal } from '../functions/signal/app.mjs';

function setup() {
  const sent = [];
  const sqs = { send: async (command) => { sent.push(command.input); return { MessageId: 'm-1' }; } };
  const app = buildApp({ queueUrl: 'https://sqs.example/queue.fifo', formats: ['markdown'], sqs, now: () => 1234567 });
  return { app, sent };
}
const post = (app, payload) => app.inject({ method: 'POST', url: '/signals', headers: { 'content-type': 'application/json' }, payload });

test('format_needed -> 202 and one FIFO message, grouped and deduplicated by URI', async () => {
  const { app, sent } = setup();
  const res = await post(app, { signal: 'format_needed', uri: '/blog/a.html', format: 'markdown', expired: false });
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.json(), { queued: true, uri: '/blog/a.html', format: 'markdown' });
  assert.deepEqual(sent, [{
    QueueUrl: 'https://sqs.example/queue.fifo',
    MessageBody: JSON.stringify({ uri: '/blog/a.html', format: 'markdown', requestedAt: 1234567, source: 'format_needed' }),
    MessageGroupId: '/blog/a.html',
    MessageDeduplicationId: '/blog/a.html',
  }]);
});

test('object_missing is queued the same way (the original URI)', async () => {
  const { app, sent } = setup();
  const res = await post(app, { signal: 'object_missing', uri: '/docs/architecture.html', format: 'markdown' });
  assert.equal(res.statusCode, 202);
  assert.equal(JSON.parse(sent[0].MessageBody).source, 'object_missing');
  assert.equal(sent[0].MessageGroupId, '/docs/architecture.html');
});

test('bad signals -> 400 and nothing queued', async () => {
  const { app, sent } = setup();
  const bad = [
    { signal: 'format_served', uri: '/a.html', format: 'markdown' },
    { signal: 'format_needed', uri: 'a.html', format: 'markdown' },
    { signal: 'format_needed', uri: '/a b.html', format: 'markdown' },
    { signal: 'format_needed', uri: '/' + 'a'.repeat(1100), format: 'markdown' },
    { signal: 'format_needed', uri: '/a.html', format: 'pdf' },
    { signal: 'format_needed', uri: 42, format: 'markdown' },
  ];
  for (const body of bad) {
    const res = await post(app, body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.ok(res.json().error);
  }
  assert.equal(sent.length, 0);
});

test('a body that is not JSON -> 4xx, nothing queued', async () => {
  const { app, sent } = setup();
  const res = await app.inject({ method: 'POST', url: '/signals', headers: { 'content-type': 'application/json' }, payload: 'nope' });
  assert.equal(res.statusCode, 400);
  assert.equal(sent.length, 0);
});

test('a body over 10 KB (the cf.beacon limit) -> 413', async () => {
  const { app } = setup();
  const res = await post(app, { signal: 'format_needed', uri: '/a.html', format: 'markdown', pad: 'x'.repeat(11 * 1024) });
  assert.equal(res.statusCode, 413);
});

test('other routes and methods -> 404', async () => {
  const { app } = setup();
  assert.equal((await app.inject({ method: 'GET', url: '/signals' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/' })).statusCode, 404);
});

test('an SQS failure -> 500 (the edge never waits for it; the next agent request signals again)', async () => {
  const app = buildApp({ queueUrl: 'q', formats: ['markdown'], sqs: { send: async () => { throw new Error('throttled'); } } });
  const res = await post(app, { signal: 'format_needed', uri: '/a.html', format: 'markdown' });
  assert.equal(res.statusCode, 500);
});

test('validateSignal keeps only signal, uri and format', () => {
  assert.deepEqual(validateSignal({ signal: 'format_needed', uri: '/a', format: 'markdown', extra: 1 }, ['markdown']),
    { signal: 'format_needed', uri: '/a', format: 'markdown' });
  assert.ok(validateSignal(null, ['markdown']).error);
});
