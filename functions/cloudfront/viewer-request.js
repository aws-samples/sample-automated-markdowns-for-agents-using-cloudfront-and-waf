import cf from 'cloudfront';

// Viewer-request function on the default behavior (runtime cloudfront-js-2.0).
// AWS WAF says whether the viewer is an AI agent that wants a format; KVS says whether that
// format exists for this URI. A hit routes to the formats bucket, with the content origin as
// the failover. A miss serves the original and cf.beacons a "format_needed" signal to the
// signal API (API Gateway, which sends it to SQS as the generation message). The request
// never waits for the signal.

// --- Constants (injected by CDK at synth time) ---
const DEBUG = true;
const HEADER_SKIP_CONVERSION = '{{HEADER_SKIP_CONVERSION}}';
const HEADER_NO_CONVERT = '{{HEADER_NO_CONVERT}}';
const HEADER_FORMAT_CONVERT = '{{HEADER_FORMAT_CONVERT}}';
const HEADER_FORMAT_VERSION = '{{HEADER_FORMAT_VERSION}}';
const HEADER_FORMAT_SERVED = '{{HEADER_FORMAT_SERVED}}';
const HEADER_FORMAT_STATUS = '{{HEADER_FORMAT_STATUS}}';
const CONTENT_ORIGIN_ID = '{{CONTENT_ORIGIN_ID}}';
const FORMAT_ORIGIN_IDS = {{FORMAT_ORIGIN_IDS}};
const FAILOVER_STATUS_CODES = {{FAILOVER_STATUS_CODES}};
const SIGNAL_ORIGIN_ID = '{{SIGNAL_ORIGIN_ID}}';
const SIGNAL_PATH = '{{SIGNAL_PATH}}';
const ACTION_REWRITE = '{{ACTION_REWRITE}}';
const SIGNAL_PASSTHROUGH = '{{SIGNAL_PASSTHROUGH}}';
const SIGNAL_FORMAT_SERVED = '{{SIGNAL_FORMAT_SERVED}}';
const SIGNAL_FORMAT_NEEDED = '{{SIGNAL_FORMAT_NEEDED}}';

// KVS handle — associated via CDK keyValueStore property
const kvsHandle = cf.kvs();

// The one network call this function makes, fire-and-forget. The body is the generation
// message as the Generator reads it; CloudFront adds the API key as an origin custom header.
// It throws only for a bad call (or a distribution without network calls); a late delivery
// failure goes to CloudWatch Logs.
function sendSignal(uri, format) {
  cf.beacon(SIGNAL_PATH, {
    originId: SIGNAL_ORIGIN_ID,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uri: uri, format: format, requestedAt: Date.now(), source: SIGNAL_FORMAT_NEEDED }),
    logDeliveryErrors: true,
  });
}

// Serve the original and ask for the format (a missing or an expired marker).
function formatNeeded(request, uri, format) {
  try {
    sendSignal(uri, format);
    request.headers[HEADER_FORMAT_STATUS] = { value: 'queued' };
  } catch (e) {
    // Fail open: the viewer still gets the original content.
    request.headers[HEADER_FORMAT_STATUS] = { value: 'failed' };
    console.log(JSON.stringify({ signal: 'signal_failed', uri: uri, error: e.name + ': ' + e.message }));
  }
  return request;
}

async function handler(event) {
  const request = event.request;
  const headers = request.headers;
  const uri = request.uri;

  // 0. Only this function sets the internal format headers: drop viewer-supplied copies.
  delete headers[HEADER_FORMAT_VERSION];
  delete headers[HEADER_FORMAT_SERVED];
  delete headers[HEADER_FORMAT_STATUS];

  // 1. Skip conversion if internal header present (used by Generator Lambda)
  if (headers[HEADER_SKIP_CONVERSION]) {
    delete headers[HEADER_SKIP_CONVERSION];
    return request;
  }

  // 2. Do-not-convert: WAF injects this header for paths matching regex pattern set
  if (headers[HEADER_NO_CONVERT]) {
    DEBUG && console.log(JSON.stringify({ signal: SIGNAL_PASSTHROUGH, uri: uri, reason: 'do_not_convert' }));
    return request;
  }

  // 3. Check WAF bot detection header — value is the target format (e.g., "markdown")
  const botHeader = headers[HEADER_FORMAT_CONVERT];
  const format = botHeader ? botHeader.value : null;

  // Not a request for a new format from WAF — serve original content as-is
  if (!format) {
    return request;
  }

  // 4. A format is wanted — look up the URI in KVS. A missing key throws: not generated yet.
  let marker = null;
  try {
    const markerJson = await kvsHandle.get(uri);
    marker = JSON.parse(markerJson);
  } catch (e) {
    // Key not found in KVS — fall through to signal generation
  }

  if (!marker || marker.action !== ACTION_REWRITE) {
    return formatNeeded(request, uri, format);
  }

  const markerFormat = marker.format || format;
  const formatOriginId = FORMAT_ORIGIN_IDS[markerFormat];
  const now = Math.floor(Date.now() / 1000);
  if (!formatOriginId || !marker.ttl || marker.ttl <= now) {
    // Expired (or a format this edge cannot route) — serve original, signal re-generation
    return formatNeeded(request, uri, markerFormat);
  }

  // 5. Valid marker. The URI stays as it is: the formats origin's origin path
  //    (/formats/<format>) maps it to the generated object, and a 403 from the formats
  //    bucket (object missing) fails over to the content origin with the same URI.
  cf.createRequestOriginGroup({
    originIds: [
      { originId: formatOriginId },
      { originId: CONTENT_ORIGIN_ID },
    ],
    failoverCriteria: {
      statusCodes: FAILOVER_STATUS_CODES,
    },
  });
  // The marker's TTL is in the cache key: a regenerated format is a new cache entry.
  headers[HEADER_FORMAT_VERSION] = { value: String(marker.ttl) };
  headers[HEADER_FORMAT_SERVED] = { value: markerFormat };
  headers[HEADER_FORMAT_STATUS] = { value: 'served' };
  DEBUG && console.log(JSON.stringify({ signal: SIGNAL_FORMAT_SERVED, uri: uri, format: markerFormat }));
  return request;
}
