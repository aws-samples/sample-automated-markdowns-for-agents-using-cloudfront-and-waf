import cf from 'cloudfront';

// Viewer-response function on the default behavior (runtime cloudfront-js-2.0).
// When the request function routed to a format, the answer should be that format. If it is
// not, the formats bucket had no object (a 403) and the origin group served the original
// from the content origin. That is "object_missing": cf.beacon it to the signal API
// (API Gateway, which sends it to SQS), and the Generator regenerates the page. The viewer
// already has the original, so nothing waits.
// It also copies the x-format-status verdict onto the response.

// --- Constants (injected by CDK at synth time) ---
const HEADER_FORMAT_SERVED = '{{HEADER_FORMAT_SERVED}}';
const HEADER_FORMAT_STATUS = '{{HEADER_FORMAT_STATUS}}';
const FORMAT_CONTENT_TYPES = {{FORMAT_CONTENT_TYPES}};
const SIGNAL_ORIGIN_ID = '{{SIGNAL_ORIGIN_ID}}';
const SIGNAL_PATH = '{{SIGNAL_PATH}}';
const SIGNAL_OBJECT_MISSING = '{{SIGNAL_OBJECT_MISSING}}';

async function handler(event) {
  const request = event.request;
  const response = event.response;
  const status = request.headers[HEADER_FORMAT_STATUS];
  if (!status) return response;
  response.headers[HEADER_FORMAT_STATUS] = { value: status.value };

  const served = request.headers[HEADER_FORMAT_SERVED];
  // Only a 200 carries a body to check (a 304 has no content type).
  if (!served || response.statusCode !== 200) return response;

  const format = served.value;
  const expected = FORMAT_CONTENT_TYPES[format];
  const contentType = response.headers['content-type'] ? response.headers['content-type'].value : '';
  if (expected && contentType.indexOf(expected) === 0) return response;

  // The original came back instead of the format.
  response.headers[HEADER_FORMAT_STATUS] = { value: 'missing' };
  try {
    cf.beacon(SIGNAL_PATH, {
      originId: SIGNAL_ORIGIN_ID,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The generation message as the Generator reads it
      body: JSON.stringify({ uri: request.uri, format: format, requestedAt: Date.now(), source: SIGNAL_OBJECT_MISSING }),
      logDeliveryErrors: true,
    });
  } catch (e) {
    console.log(JSON.stringify({ signal: 'signal_failed', uri: request.uri, error: e.name + ': ' + e.message }));
  }
  return response;
}
