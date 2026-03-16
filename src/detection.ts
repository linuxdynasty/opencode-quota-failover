import type { ProviderModel } from './types.js';
import { CUSTOM_PATTERN_WILDCARD, MIN_CUSTOM_PATTERN_LENGTH } from './constants.js';
import { runtimeSettings } from './state.js';

interface FailoverTriggerOptions {
  requireDefinitive?: boolean;
  customPatterns?: Record<string, string[] | undefined>;
}

/** collectErrorDetails does normalize heterogeneous error payloads into searchable text and status code. */
/**
 * VALIDATION_SUPPRESSION_SIGNALS is the shared suppression list used by isDefinitiveQuotaError,
 * isAmbiguousRateLimitSignal, and isRequestValidationError to prevent false-positive quota
 * classification of non-retryable client-side validation errors.
 *
 * Category A: cross-provider non-recoverable (same payload fails everywhere — never failover)
 *   - token/context limit exceeded (model capacity, not account quota)
 *   - invalid request structure (bad JSON, schema mismatch, unsupported fields)
 *   - content policy violations (prompt blocked)
 *   - model/feature capability mismatches
 *
 * Category B: provider-specific serialization failures are handled separately by
 * isProviderRequestError (Bedrock-gated) and should NOT appear here.
 */
const VALIDATION_SUPPRESSION_SIGNALS: string[] = [
  // Context / token limits (model capacity — not account quota)
  'context length',
  'context window',
  'token limit',
  'too many tokens',
  'prompt is too long',
  'max_tokens',
  'context_length_exceeded',
  'request_too_large',

  // Structured error type strings (Anthropic/OpenAI error.type field)
  'invalid_request_error',

  // Generic validation language
  'validationexception',
  'validation failed',
  'validation error',

  // HTTP 400 semantics
  'bad request',

  // Schema-level structural errors
  'unprocessable entity',
  'unsupported parameter',
  'missing required',
  'extra inputs are not permitted',
  'unknown field',

  // Content policy
  'content_policy_violation',
  'content policy',

  // Model capability mismatch
  'prefilling assistant messages is not supported',
  'not supported for this model',
  'model does not support',
  'feature not available for this model',
];

export function collectErrorDetails(error: unknown): { text: string; statusCode: number | undefined } {
  const texts: string[] = [];
  let statusCode: number | undefined;

  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.trim().length > 0) {
      texts.push(value.toLowerCase());
    }
  };

  if (!error) {
    return { text: '', statusCode };
  }

  if (typeof error === 'string') {
    add(error);
    return { text: texts.join(' '), statusCode };
  }

  const record = error as Record<string, unknown>;
  add(record.message);
  add(record.description);
  add(record.reason);
  add(record.details);

  if (record.data && typeof record.data === 'object') {
    const data = record.data as Record<string, unknown>;
    add(data.message);
    add(data.responseBody);
    add(data.error);
    if (typeof data.statusCode === 'number') {
      statusCode = data.statusCode;
    }
  }

  if (record.error && typeof record.error === 'object') {
    const nestedError = record.error as Record<string, unknown>;
    add(nestedError.message);
    if (nestedError.data && typeof nestedError.data === 'object') {
      const nestedData = nestedError.data as Record<string, unknown>;
      add(nestedData.message);
      add(nestedData.responseBody);
    }
  }

  try {
    add(JSON.stringify(error));
  } catch {}

  return { text: texts.join(' '), statusCode };
}

/** isDefinitiveQuotaError does classify hard quota and billing exhaustion signals. */
export function isDefinitiveQuotaError(error: unknown): boolean {
  const { text, statusCode } = collectErrorDetails(error);
  if (!text) {
    return false;
  }

  if (VALIDATION_SUPPRESSION_SIGNALS.some((signal) => text.includes(signal))) {
    return false;
  }

  const hardQuotaPatterns = [
    /insufficient[_\s-]?quota/,
    /quota[_\s-]?exceeded/,
    /exceeded.*quota/,
    /billing[_\s-]?hard[_\s-]?limit/,
    /out of credits?/,
    /insufficient credits?/,
    /credit balance.*(?:zero|depleted|empty|negative)/,
    /servicequotaexceeded/,
    /you.*have.*(reached|exceeded).*(limit|quota)/,
    /monthly usage limit/,
    /daily usage limit/,
    /subscription.*limit.*(?:reached|exceeded)/,
    /plan.*limit.*(?:reached|exceeded)/,
    /usage limit (?:reached|exceeded|hit)/,
  ];
  if (hardQuotaPatterns.some((pattern) => pattern.test(text))) {
    return true;
  }

  if (statusCode === 402) {
    const billingWords = /(payment|billing|quota|credit|subscription|plan)/;
    if (billingWords.test(text)) {
      return true;
    }
  }

  const retryBackoffMs = parseRetryBackoffMs(text);
  const hasAccountQuotaWords =
    /(account|quota|subscription|billing|plan limit|usage limit)/.test(text);
  if (retryBackoffMs >= 30 * 60 * 1000 && hasAccountQuotaWords) {
    return true;
  }

  return false;
}

/** isAmbiguousRateLimitSignal does detect account-level rate-limit wording requiring backoff confirmation. */
export function isAmbiguousRateLimitSignal(error: unknown): boolean {
  const { text } = collectErrorDetails(error);
  if (!text) {
    return false;
  }

  if (VALIDATION_SUPPRESSION_SIGNALS.some((signal) => text.includes(signal))) {
    return false;
  }

  if (
    /(would exceed your account'?s rate limit|account'?s rate limit)/.test(text)
  ) {
    return true;
  }

  return false;
}

/** isUsageLimitError does detect either definitive quota exhaustion or ambiguous account rate-limit wording. */
export function isUsageLimitError(error: unknown): boolean {
  return isDefinitiveQuotaError(error) || isAmbiguousRateLimitSignal(error);
}

/** isBedrockOpusModel does identify Bedrock Claude Opus 4.6 targets for special failover handling. */
export function isBedrockOpusModel(model: ProviderModel | null | undefined): boolean {
  const providerID = model?.providerID;
  const modelID = model?.modelID?.toLowerCase() ?? '';
  return providerID === 'amazon-bedrock' && modelID.includes('claude-opus-4-6');
}

/** isBedrockModel does identify any Amazon Bedrock model target for provider-scoped failover gating. */
export function isBedrockModel(model: ProviderModel | null | undefined): boolean {
  return model?.providerID === 'amazon-bedrock';
}

/** isThinkingBlockMutationError does detect immutable thinking-block replay mutation errors. */
export function isThinkingBlockMutationError(error: unknown): boolean {
  const { text } = collectErrorDetails(error);
  if (!text) {
    return false;
  }

  const signals = [
    'the model returned the following errors',
    'thinking` or `redacted_thinking` blocks',
    'blocks in the latest assistant message cannot be modified',
    'must remain as they were in the original response',
  ];

  let hits = 0;
  for (const signal of signals) {
    if (text.includes(signal)) {
      hits += 1;
    }
  }

  return hits >= 2;
}

/** isProviderRequestError does detect non-recoverable provider request validation failures. */
export function isProviderRequestError(error: unknown): boolean {
  const { text } = collectErrorDetails(error);
  if (!text) {
    return false;
  }

  // Gate 1: Bedrock-style error prefix required — prevents matching generic validation errors
  if (!text.includes('the model returned the following errors')) {
    return false;
  }

  // Gate 2: At least one request-validation signal
  const requestErrorSignals = [
    'not valid json',
    'request body',
    'invalid request',
    'malformed request',
  ];

  return requestErrorSignals.some((signal) => text.includes(signal));
}

/** isAnthropicTokenRefreshError does detect Anthropic token refresh 400 failures that should fail over. */
function isAnthropicTokenRefreshError(
  error: unknown,
  failedModel: ProviderModel | null | undefined,
): boolean {
  if (failedModel?.providerID !== 'anthropic') {
    return false;
  }

  const { text, statusCode } = collectErrorDetails(error);
  if (!text) {
    return false;
  }

  if (typeof statusCode === 'number' && statusCode !== 400) {
    return false;
  }

  return /token refresh failed:\s*400\b/.test(text);
}

/**
 * matchesWildcardPattern checks if text contains the pattern using glob-style '*' wildcards.
 * Without '*', this is a plain substring match (text.includes(pattern)).
 * With '*', segments between wildcards must appear in order in the text.
 * Example: "billing*limit*exceeded" matches "billing hard limit was exceeded today".
 * No regex. No start/end anchoring — all matching is substring-based.
 */
export function matchesWildcardPattern(text: string, pattern: string): boolean {
  if (!pattern || !text) return false;
  if (!pattern.includes('*')) return text.includes(pattern);
  const segments = pattern.split('*').filter((s) => s.length > 0);
  if (segments.length === 0) return true; // Pattern is all wildcards
  let pos = 0;
  for (const segment of segments) {
    const idx = text.indexOf(segment, pos);
    if (idx === -1) return false;
    pos = idx + segment.length;
  }
  return true;
}

export function normalizeCustomPattern(pattern: unknown): string {
  if (typeof pattern !== 'string') {
    return '';
  }
  return pattern.trim().toLowerCase();
}

export function validateCustomPattern(pattern: string): { valid: boolean; reason?: string } {
  if (typeof pattern !== 'string') {
    return { valid: false, reason: 'Pattern must be a string.' };
  }

  const trimmed = normalizeCustomPattern(pattern);
  if (trimmed.length === 0) {
    return { valid: false, reason: 'Pattern must not be empty.' };
  }

  const literalLength = trimmed.split(CUSTOM_PATTERN_WILDCARD).join('').length;
  if (literalLength < MIN_CUSTOM_PATTERN_LENGTH) {
    return {
      valid: false,
      reason: `Pattern must contain at least ${MIN_CUSTOM_PATTERN_LENGTH} non-wildcard literal characters.`,
    };
  }

  return { valid: true };
}

export const matchWildcardPattern = matchesWildcardPattern;

/** isCustomFailoverPattern does check error text against per-provider user-configured substring patterns. */
export function isCustomFailoverPattern(
  error: unknown,
  providerID: string | null | undefined,
  customPatterns: Record<string, string[] | undefined> = runtimeSettings.customFailoverPatterns as Record<string, string[] | undefined>,
): boolean {
  if (!providerID) return false;
  const providerPatterns = customPatterns[providerID] ?? [];
  const wildcardPatterns = customPatterns['*'] ?? [];
  const patterns = [...providerPatterns, ...wildcardPatterns];
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  const { text } = collectErrorDetails(error);
  if (!text) return false;
  return patterns.some(
    (pattern) =>
      typeof pattern === 'string'
      && pattern.length > 0
      && matchesWildcardPattern(text, normalizeCustomPattern(pattern)),
  );
}

/** shouldTriggerFailover does decide whether a failure signal should initiate failover dispatch. */
/**
 * isRequestValidationError detects Category A non-retryable client-side validation errors
 * that must NEVER trigger failover. The same payload would fail on any provider, so switching
 * providers cannot help and would only produce a duplicate error.
 *
 * This is the explicit fast-path guard. It is called as step 0 in shouldTriggerFailover and
 * returns true when the error is clearly a structural/schema problem with the request itself,
 * not a provider capacity or quota issue.
 *
 * Signals covered:
 *   - Anthropic error.type == "invalid_request_error"
 *   - OpenAI HTTP 400 with validation language
 *   - AWS Bedrock ValidationException
 *   - Generic HTTP 400/422 with schema, field, or format error wording
 *   - Content policy blocks (prompt rejected — same on any provider)
 *   - Model capability mismatches (feature not supported — same on any provider)
 *
 * Note: Bedrock-specific serialization failures (Category B) are NOT handled here.
 * They are handled by isProviderRequestError (Bedrock-gated, single-hit failover may help
 * because the same content is valid JSON on a different provider).
 */
export function isRequestValidationError(error: unknown): boolean {
  const { text, statusCode } = collectErrorDetails(error);
  if (!text) {
    return false;
  }

  // Fast path: structured error type field is definitive
  if (text.includes('invalid_request_error')) {
    return true;
  }

  // AWS Bedrock ValidationException (not ServiceQuotaExceededException)
  if (text.includes('validationexception') && !text.includes('servicequotaexceeded')) {
    return true;
  }

  // Context/token limit — model capacity limit, not account quota
  const contextLimitSignals = [
    'context length',
    'context window',
    'token limit',
    'too many tokens',
    'prompt is too long',
    'max_tokens',
    'context_length_exceeded',
    'request_too_large',
  ];
  if (contextLimitSignals.some((s) => text.includes(s))) {
    return true;
  }

  // Schema / structural errors
  const structuralSignals = [
    'extra inputs are not permitted',
    'unknown field',
    'missing required',
    'unsupported parameter',
    'prefilling assistant messages is not supported',
    'not supported for this model',
    'model does not support',
    'feature not available for this model',
  ];
  if (structuralSignals.some((s) => text.includes(s))) {
    return true;
  }

  // Content policy blocks
  if (text.includes('content_policy_violation') || text.includes('content policy')) {
    return true;
  }

  // HTTP 400 / 422 with explicit validation language (but NOT Bedrock serialization prefix,
  // which is handled by isProviderRequestError)
  if (
    (statusCode === 400 || statusCode === 422)
    && !text.includes('the model returned the following errors')
  ) {
    const http400Signals = [
      'validation failed',
      'validation error',
      'bad request',
      'unprocessable entity',
      'invalid request',
      'malformed request',
    ];
    if (http400Signals.some((s) => text.includes(s))) {
      return true;
    }
  }

  return false;
}

export function shouldTriggerFailover(
  error: unknown,
  failedModel: ProviderModel | null | undefined,
  {
    requireDefinitive = false,
    customPatterns,
  }: FailoverTriggerOptions = {},
): boolean {
  // Step 0: Category A validation errors — same payload fails on any provider, never failover
  if (isRequestValidationError(error)) {
    return false;
  }

  const isQuota = requireDefinitive
    ? isDefinitiveQuotaError(error)
    : isUsageLimitError(error);
  if (isQuota) {
    return true;
  }

  if (isBedrockOpusModel(failedModel) && isThinkingBlockMutationError(error)) {
    return true;
  }

  if (isBedrockModel(failedModel) && isProviderRequestError(error)) {
    return true;
  }

  if (isAnthropicTokenRefreshError(error, failedModel)) {
    return true;
  }

  if (isCustomFailoverPattern(error, failedModel?.providerID, customPatterns)) {
    return true;
  }

  return false;
}

/** parseRetryBackoffMs does parse retry-in durations into milliseconds from provider message text. */
export function parseRetryBackoffMs(text: unknown): number {
  if (typeof text !== 'string' || text.length === 0) {
    return 0;
  }

  const marker = text.match(
    /(?:retry(?:ing)?|try again)\s+in\s+([^\]\n\.;,]+)/i,
  );
  if (!marker?.[1]) {
    return 0;
  }

  const segment = marker[1];
  let totalMs = 0;
  const unitMatches = segment.matchAll(
    /(\d+)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\b/gi,
  );
  for (const match of unitMatches) {
    const amount = Number.parseInt(match[1] ?? '0', 10);
    const unit = (match[2] ?? '').toLowerCase();
    if (!Number.isFinite(amount) || amount <= 0) {
      continue;
    }
    if (unit.startsWith('h')) {
      totalMs += amount * 60 * 60 * 1000;
      continue;
    }
    if (unit.startsWith('m')) {
      totalMs += amount * 60 * 1000;
      continue;
    }
    if (unit.startsWith('s')) {
      totalMs += amount * 1000;
    }
  }

  return totalMs;
}
