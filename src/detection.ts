import type { ProviderModel } from './types.js';

interface FailoverTriggerOptions {
  requireDefinitive?: boolean;
}

/** collectErrorDetails does normalize heterogeneous error payloads into searchable text and status code. */
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

  const tokenLimitSignals = [
    'context length',
    'context window',
    'token limit',
    'too many tokens',
    'prompt is too long',
    'max_tokens',
    'context_length_exceeded',
  ];
  if (tokenLimitSignals.some((signal) => text.includes(signal))) {
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

  const tokenLimitSignals = [
    'context length',
    'context window',
    'token limit',
    'too many tokens',
    'prompt is too long',
    'max_tokens',
    'context_length_exceeded',
  ];
  if (tokenLimitSignals.some((signal) => text.includes(signal))) {
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

/** shouldTriggerFailover does decide whether a failure signal should initiate failover dispatch. */
export function shouldTriggerFailover(
  error: unknown,
  failedModel: ProviderModel | null | undefined,
  { requireDefinitive = false }: FailoverTriggerOptions = {},
): boolean {
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
