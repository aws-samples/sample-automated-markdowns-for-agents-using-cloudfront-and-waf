// --- Constants (injected by CDK at synth time) ---
const FORMAT_PREFIX_REGEX = /^\/formats\/([^/]+)\/(.*)/;
const SIGNAL_OBJECT_MISSING = '{{SIGNAL_OBJECT_MISSING}}';

async function handler(event) {
  const request = event.request;
  const uri = request.uri;

  // Strip /formats/<format>/ prefix and revert to original path
  const formatPrefixMatch = uri.match(FORMAT_PREFIX_REGEX);
  if (formatPrefixMatch) {
    const format = formatPrefixMatch[1];
    const originalPath = '/' + formatPrefixMatch[2];
    request.uri = originalPath;

    // Log object_missing signal — feeds into generation pipeline
    console.log(JSON.stringify({
      signal: SIGNAL_OBJECT_MISSING,
      uri: uri,
      original_uri: originalPath,
      format: format,
      timestamp: new Date().toISOString()
    }));
  }

  return request;
}
