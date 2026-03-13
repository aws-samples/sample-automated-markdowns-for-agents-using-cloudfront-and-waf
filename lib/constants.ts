// ---------------------------------------------------------------------------
// Shared constants for the Markdown Generation stack
// ---------------------------------------------------------------------------

// --- Deployment ---
export const STACK_REGION = 'us-east-1';
export const STACK_DESCRIPTION =
  'Automated markdown generation for AI agents using Amazon CloudFront and AWS WAF';

// --- CloudFront ---
export const DEFAULT_ROOT_OBJECT = 'index.html';
export const CFF_NAME_MAX_LENGTH = 64;

// Origin IDs — referenced by CFF viewer-request.js for dynamic origin groups
export const FORMATS_ORIGIN_ID = 'formats-s3';
export const FORMAT_MISSING_ORIGIN_ID = 'format-missing-distro';

// Behavior path patterns
export const STATIC_PATH_PATTERN = '/static/*';
export const FORMATS_PATH_PATTERN = '/formats/*';

// Internal header used by Generator Lambda to bypass CFF routing
export const HEADER_SKIP_CONVERSION = 'x-internal-skip-conversion';

// Origin secret header — restricts Format-Missing distro to Primary distro only
export const ORIGIN_SECRET_HEADER = 'x-origin-verify';

// Origin-group failover
export const ORIGIN_GROUP_FAILOVER_STATUS_CODES = [403];

// --- AWS WAF ---
export const WAF_ACL_METRIC_NAME = 'MarkdownBotControlAcl';
export const WAF_AI_BOT_LABEL =
  'awswaf:managed:aws:bot-control:bot:category:ai';
export const WAF_BOT_CONTROL_RULESET = 'AWSManagedRulesBotControlRuleSet';
export const WAF_BOT_CONTROL_VERSION = 'Version_5.0';
export const WAF_BOT_CONTROL_INSPECTION_LEVEL = 'COMMON';

// AWS WAF rule names & metrics
export const WAF_RULE_BOT_CONTROL = 'AWSBotControl';
export const WAF_METRIC_BOT_CONTROL = 'BotControlRule';
export const WAF_RULE_FORMAT_CONVERT_INJECTION = 'FormatConvertHeaderInjection';
export const WAF_METRIC_FORMAT_CONVERT = 'FormatConvertDetected';
export const WAF_RULE_DO_NOT_CONVERT = 'DoNotConvert';
export const WAF_METRIC_DO_NOT_CONVERT = 'DoNotConvertRule';

// AWS WAF for Format-Missing distro (origin-verify)
export const WAF_FORMAT_MISSING_ACL_METRIC = 'FormatMissingOriginVerifyAcl';
export const WAF_RULE_ORIGIN_VERIFY = 'OriginVerify';
export const WAF_METRIC_ORIGIN_VERIFY = 'OriginVerifyRule';

// --- Generation Pipeline ---
export const DEFAULT_FORMAT = 'markdown';
export const MARKDOWN_CONTENT_TYPE = 'text/markdown';

// AWS WAF-injected headers (AWS WAF auto-prefixes with 'x-amzn-waf-')
export const WAF_HEADER_FORMAT_CONVERT = 'format-convert-needed';
export const WAF_HEADER_FORMAT_CONVERT_VALUE = DEFAULT_FORMAT;
export const WAF_HEADER_NO_CONVERT = 'no-convert';
export const WAF_ACCEPT_HEADER_SEARCH_STRING = MARKDOWN_CONTENT_TYPE;

// Regex patterns excluded from format conversion
export const DO_NOT_CONVERT_PATTERNS = ['/static/.*'];

// --- KVS Marker Actions ---
export const ACTION_REWRITE = 'rewrite';

// --- CFF Log Signals ---
export const SIGNAL_FORMAT_SERVED = 'format_served';
export const SIGNAL_FORMAT_NEEDED = 'format_needed';
export const SIGNAL_OBJECT_MISSING = 'object_missing';
export const SIGNAL_PASSTHROUGH = 'passthrough';

export const FORMAT_TTL_SECONDS = 86400; // 24 hours
export const GENERATOR_MEMORY_SIZE_MB = 512;
export const GENERATOR_TIMEOUT_MINUTES = 2;
export const PARSER_TIMEOUT_SECONDS = 30;
export const KVS_SYNC_TIMEOUT_SECONDS = 30;
export const QUEUE_VISIBILITY_TIMEOUT_MINUTES = 5;
export const QUEUE_RETENTION_DAYS = 1;
export const KVS_SYNC_BATCH_SIZE = 1;
export const KVS_SYNC_RETRY_ATTEMPTS = 3;
export const SQS_GENERATOR_BATCH_SIZE = 1;

// --- DynamoDB ---
export const DDB_PARTITION_KEY = 'uri';
export const DDB_TTL_ATTRIBUTE = 'ttl';

// --- CloudWatch ---
export const METRIC_NAMESPACE = 'MarkdownGeneration';
export const DASHBOARD_NAME = 'MarkdownGeneration-Operations';
