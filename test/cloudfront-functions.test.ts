// The CloudFront Functions, run under Node with a fake `cloudfront` module. The source is built
// with the same placeholder values CDK injects at synth time.
import * as fs from 'fs';
import * as path from 'path';
import { viewerRequestReplacements, viewerResponseReplacements } from '../lib/constructs/edge/routing-functions';

const DIR = path.join(__dirname, '../functions/cloudfront');

function load(file: string, replacements: Record<string, string>, cf: Record<string, unknown>) {
  let src = fs.readFileSync(path.join(DIR, file), 'utf-8');
  for (const [key, value] of Object.entries(replacements)) src = src.split(`{{${key}}}`).join(value);
  expect(src).not.toMatch(/\{\{[A-Z_]+\}\}/);
  src = src.replace(/^import cf from 'cloudfront';\s*/m, '');
  // eslint-disable-next-line no-new-func
  return new Function('cf', 'console', `${src}\nreturn handler;`)(cf, { log: () => undefined });
}

type Headers = Record<string, { value: string }>;
const hv = (headers: Headers, name: string) => headers[name] && headers[name].value;
const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const PAST = Math.floor(Date.now() / 1000) - 60;
const AGENT: Headers = { 'x-amzn-waf-format-convert-needed': { value: 'markdown' } };

/** A fake cf: KVS from a map, beacon and origin-group calls recorded. */
function fakeCf(kvs: Record<string, unknown> = {}, beacon?: (path: string, opts: any) => void) {
  const calls = { beacons: [] as Array<{ path: string; opts: any }>, groups: [] as any[] };
  const cf = {
    kvs: () => ({
      get: async (key: string) => {
        if (!(key in kvs)) throw new Error('KeyNotFound');
        return JSON.stringify(kvs[key]);
      },
    }),
    beacon: beacon ?? ((p: string, opts: any) => { calls.beacons.push({ path: p, opts }); }),
    createRequestOriginGroup: (group: any) => { calls.groups.push(group); },
  };
  return { cf, calls };
}

describe('viewer-request.js', () => {
  const run = async (headers: Headers, kvs: Record<string, unknown> = {}, beacon?: (p: string, o: any) => void, uri = '/blog/a.html') => {
    const { cf, calls } = fakeCf(kvs, beacon);
    const handler = load('viewer-request.js', viewerRequestReplacements(), cf);
    const request = await handler({ request: { method: 'GET', uri, headers: { ...headers }, querystring: {} } });
    return { request, calls };
  };

  test('a browser: no KVS read, no beacon, no origin group', async () => {
    const { request, calls } = await run({});
    expect(calls.beacons).toEqual([]);
    expect(calls.groups).toEqual([]);
    expect(request.uri).toBe('/blog/a.html');
    expect(request.headers['x-format-status']).toBeUndefined();
  });

  test('an agent, KVS miss: one cf.beacon format_needed to the signal origin, original served', async () => {
    const { request, calls } = await run(AGENT);
    expect(calls.groups).toEqual([]);
    expect(calls.beacons).toHaveLength(1);
    const [{ path: p, opts }] = calls.beacons;
    expect(p).toBe('/signals');
    expect(opts).toEqual({
      originId: 'signal',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signal: 'format_needed', uri: '/blog/a.html', format: 'markdown', expired: false }),
      logDeliveryErrors: true,
    });
    expect(request.uri).toBe('/blog/a.html');
    expect(hv(request.headers, 'x-format-status')).toBe('queued');
  });

  test('an agent, valid marker: origin group formats -> content, URI unchanged, version in a header', async () => {
    const { request, calls } = await run(AGENT, {
      '/blog/a.html': { action: 'rewrite', path: '/formats/markdown/blog/a.html', format: 'markdown', ttl: FUTURE },
    });
    expect(calls.beacons).toEqual([]);
    expect(calls.groups).toEqual([{
      originIds: [{ originId: 'formats-markdown' }, { originId: 'content' }],
      failoverCriteria: { statusCodes: [403, 404] },
    }]);
    expect(request.uri).toBe('/blog/a.html');
    expect(hv(request.headers, 'x-format-version')).toBe(String(FUTURE));
    expect(hv(request.headers, 'x-format-served')).toBe('markdown');
    expect(hv(request.headers, 'x-format-status')).toBe('served');
  });

  test('an agent, expired marker: original served, beacon with expired: true', async () => {
    const { calls } = await run(AGENT, { '/blog/a.html': { action: 'rewrite', format: 'markdown', ttl: PAST } });
    expect(calls.groups).toEqual([]);
    expect(JSON.parse(calls.beacons[0].opts.body)).toEqual({ signal: 'format_needed', uri: '/blog/a.html', format: 'markdown', expired: true });
  });

  test('a marker for a format with no origin is treated as expired, never routed', async () => {
    const { calls } = await run(AGENT, { '/blog/a.html': { action: 'rewrite', format: 'pdf', ttl: FUTURE } });
    expect(calls.groups).toEqual([]);
    expect(calls.beacons).toHaveLength(1);
  });

  test('beacon throws (bad call, no network-call access): fail open, status failed', async () => {
    const thrower = () => { throw Object.assign(new Error('not supported'), { name: 'TypeError' }); };
    const { request } = await run(AGENT, {}, thrower);
    expect(request.uri).toBe('/blog/a.html');
    expect(hv(request.headers, 'x-format-status')).toBe('failed');
  });

  test('viewer-supplied internal headers are dropped (no cache-key or verdict forging)', async () => {
    const { request } = await run({
      'x-format-version': { value: '1' }, 'x-format-served': { value: 'markdown' }, 'x-format-status': { value: 'served' },
    });
    expect(request.headers['x-format-version']).toBeUndefined();
    expect(request.headers['x-format-served']).toBeUndefined();
    expect(request.headers['x-format-status']).toBeUndefined();
  });

  test('skip-conversion header (Generator Lambda): removed, nothing else happens', async () => {
    const { request, calls } = await run({ ...AGENT, 'x-internal-skip-conversion': { value: 'true' } });
    expect(request.headers['x-internal-skip-conversion']).toBeUndefined();
    expect(calls.beacons).toEqual([]);
  });

  test('do-not-convert header from WAF: passthrough, no beacon', async () => {
    const { calls } = await run({ ...AGENT, 'x-amzn-waf-no-convert': { value: 'true' } });
    expect(calls.beacons).toEqual([]);
    expect(calls.groups).toEqual([]);
  });
});

describe('viewer-response.js', () => {
  const run = async (requestHeaders: Headers, response: { statusCode: number; headers: Headers }, beacon?: (p: string, o: any) => void) => {
    const { cf, calls } = fakeCf({}, beacon);
    const handler = load('viewer-response.js', viewerResponseReplacements(), cf);
    const out = await handler({ request: { uri: '/blog/a.html', headers: requestHeaders }, response });
    return { out, calls };
  };
  const SERVED: Headers = { 'x-format-status': { value: 'served' }, 'x-format-served': { value: 'markdown' } };

  test('a browser response is untouched', async () => {
    const { out, calls } = await run({}, { statusCode: 200, headers: { 'content-type': { value: 'text/html' } } });
    expect(out.headers['x-format-status']).toBeUndefined();
    expect(calls.beacons).toEqual([]);
  });

  test('served and the answer is markdown: status served, no beacon', async () => {
    const { out, calls } = await run(SERVED, { statusCode: 200, headers: { 'content-type': { value: 'text/markdown; charset=utf-8' } } });
    expect(hv(out.headers, 'x-format-status')).toBe('served');
    expect(calls.beacons).toEqual([]);
  });

  test('served but the original came back (failover): status missing, one beacon object_missing', async () => {
    const { out, calls } = await run(SERVED, { statusCode: 200, headers: { 'content-type': { value: 'text/html' } } });
    expect(hv(out.headers, 'x-format-status')).toBe('missing');
    expect(calls.beacons).toEqual([{
      path: '/signals',
      opts: {
        originId: 'signal',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ signal: 'object_missing', uri: '/blog/a.html', format: 'markdown' }),
        logDeliveryErrors: true,
      },
    }]);
  });

  test('queued: the verdict is copied, nothing else', async () => {
    const { out, calls } = await run({ 'x-format-status': { value: 'queued' } }, { statusCode: 200, headers: {} });
    expect(hv(out.headers, 'x-format-status')).toBe('queued');
    expect(calls.beacons).toEqual([]);
  });

  test('a 304 is not read as a missing object', async () => {
    const { calls } = await run(SERVED, { statusCode: 304, headers: {} });
    expect(calls.beacons).toEqual([]);
  });

  test('beacon throws: response still returned', async () => {
    const thrower = () => { throw new TypeError('boom'); };
    const { out } = await run(SERVED, { statusCode: 200, headers: { 'content-type': { value: 'text/html' } } }, thrower);
    expect(hv(out.headers, 'x-format-status')).toBe('missing');
  });
});
