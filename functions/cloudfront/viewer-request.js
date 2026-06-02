import cf from 'cloudfront';

// --- Constants (injected by CDK at synth time) ---
const DEBUG = true;
const HEADER_SKIP_CONVERSION = '{{HEADER_SKIP_CONVERSION}}';
const HEADER_NO_CONVERT = '{{HEADER_NO_CONVERT}}';
const HEADER_FORMAT_CONVERT = '{{HEADER_FORMAT_CONVERT}}';
const FORMATS_ORIGIN_ID = '{{FORMATS_ORIGIN_ID}}';
const FORMAT_MISSING_ORIGIN_ID = '{{FORMAT_MISSING_ORIGIN_ID}}';
const FAILOVER_STATUS_CODES = {{FAILOVER_STATUS_CODES}};
const ACTION_REWRITE = '{{ACTION_REWRITE}}';
const SIGNAL_PASSTHROUGH = '{{SIGNAL_PASSTHROUGH}}';
const SIGNAL_FORMAT_SERVED = '{{SIGNAL_FORMAT_SERVED}}';
const SIGNAL_FORMAT_NEEDED = '{{SIGNAL_FORMAT_NEEDED}}';

// KVS handle — associated via CDK keyValueStore property
const kvsHandle = cf.kvs();

async function handler(event) {
  const request = event.request;
  const headers = request.headers;
  const uri = request.uri;

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

  // Not an requested new format from WAF — serve original content as-is
  if (!format) {
    return request;
  }

  // 4. new format required — look up URI in KVS for available format
  try {
    const markerJson = await kvsHandle.get(uri);
    const marker = JSON.parse(markerJson);

    if (marker.action === ACTION_REWRITE) {
      const now = Math.floor(Date.now() / 1000);
      if (marker.ttl && marker.ttl > now) {
        // Valid marker — dynamically create origin group and route to formatted version
        cf.createRequestOriginGroup({
          originIds: [
            { originId: FORMATS_ORIGIN_ID },
            { originId: FORMAT_MISSING_ORIGIN_ID },
          ],
          failoverCriteria: {
            statusCodes: FAILOVER_STATUS_CODES,
          },
        });
        request.uri = marker.path;
        DEBUG && console.log(JSON.stringify({ signal: SIGNAL_FORMAT_SERVED, uri: uri, path: marker.path, format: marker.format }));
        return request;
      } else {
        // Expired marker — serve original, signal re-generation
        console.log(JSON.stringify({ signal: SIGNAL_FORMAT_NEEDED, uri: uri, format: marker.format || format, expired: true }));
        return request;
      }
    }
  } catch (e) {
    // Key not found in KVS — fall through to signal generation
  }


  // No marker found — serve original content, signal first-time generation
  console.log(JSON.stringify({ signal: SIGNAL_FORMAT_NEEDED, uri: uri, format: format, expired: false }));
  return request;
}
