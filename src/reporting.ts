import { dirname, join } from 'node:path';
import { DEBUG_TOASTS_PER_SESSION, FAILOVER_LOG_FILE_NAME, FAILOVER_LOG_MAX_ENTRIES, SYSTEM_PROMPT_PREFIX } from './constants.js';
import { debugToastsShownBySession, failoverEventLog, lastAssistantStatsBySession, lastFailoverMsBySession, lastRetryStatusBySession, lastTransitionBySession, lastTriggerBySession, pendingBySession, runtimeSettings, stallWatchdogBySession } from './state.js';
import { buildFallbackChain, estimateModelContextLimit, fallbackSummaryByTier, formatModel, inferTierFromModel, modelKey, providerChainSummary } from './models.js';
import type { KnownTier } from './types.js';

type AnyRecord = Record<string, unknown>;
type PluginContext = { client: { tui: { showToast: (args: { body: { title: string; message: string; variant: string; duration: number } }) => Promise<unknown> } } };
type StatusModel = { providerID?: string; modelID?: string };
type FailoverToastPayload = { sessionID: string; fromModel: StatusModel | null | undefined; toModel: StatusModel | null | undefined; tierHint: KnownTier; queuedAt: number };

const getNested = (obj: AnyRecord, key: string) => (typeof obj[key] === 'object' && obj[key] !== null ? (obj[key] as AnyRecord) : {});
const getString = (obj: AnyRecord, key: string) => (typeof obj[key] === 'string' ? (obj[key] as string) : '');

/** summarizeText does normalize whitespace and clamp text to a max character width. */
export function summarizeText(value: unknown, max = 90): string {
  if (typeof value !== 'string') return '';
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

/** recordTrigger does capture the most recent trigger source and note for a session. */
export function recordTrigger(sessionID: string | null | undefined, source: string, note: string): void {
  if (!sessionID) return;
  lastTriggerBySession.set(sessionID, { source, note: summarizeText(note, 160), at: Date.now() });
}

/** safeNumber does return only finite numeric values, otherwise undefined. */
export function safeNumber(value: unknown): number | undefined { return Number.isFinite(value) ? (value as number) : undefined; }

/** formatCount does format token counts using locale separators or unknown fallback. */
export function formatCount(value: unknown): string {
  if (!Number.isFinite(value)) return 'unknown';
  return new Intl.NumberFormat('en-US').format(Math.max(0, Math.round(value as number)));
}

/** formatMs does format milliseconds to a compact human-readable duration string. */
export function formatMs(value: unknown): string {
  if (!Number.isFinite(value)) return 'unknown';
  const ms = Math.max(0, Math.round(value as number));
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/** consumeDebugToastBudget does decrement per-session debug toast budget with cap enforcement. */
export function consumeDebugToastBudget(sessionID: string): boolean {
  const shown = debugToastsShownBySession.get(sessionID) ?? 0;
  if (shown >= DEBUG_TOASTS_PER_SESSION) return false;
  debugToastsShownBySession.set(sessionID, shown + 1);
  return true;
}

/** showDebugTriggerToast does emit a bounded debug toast and record the trigger metadata. */
export async function showDebugTriggerToast(ctx: PluginContext, sessionID: string | null | undefined, source: string, note: string): Promise<void> {
  recordTrigger(sessionID, source, note);
  if (!runtimeSettings.debugToasts || !sessionID || !consumeDebugToastBudget(sessionID)) return;
  const noteText = summarizeText(note, 220);
  await ctx.client.tui.showToast({ body: { title: 'Failover Debug', message: `Trigger: ${source}${noteText ? ` · ${noteText}` : ''}`, variant: 'info', duration: 2600 } }).catch(() => {});
}

/** summarizeDispatchError does normalize mixed error payloads into concise diagnostic text. */
export function summarizeDispatchError(err: unknown): string {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return summarizeText(err, 140);
  const typed = err as AnyRecord;
  const data = getNested(typed, 'data');
  const nestedError = getNested(typed, 'error');
  const status = typed.statusCode ?? typed.status ?? data.statusCode ?? nestedError.status;
  const parts: string[] = [];
  if (Number.isFinite(status)) parts.push(`${status}`);
  const message = getString(typed, 'message');
  if (message) parts.push(message);
  const dataMessage = getString(data, 'message');
  if (dataMessage && dataMessage !== message) parts.push(dataMessage);
  const responseBody = getString(data, 'responseBody');
  if (responseBody) parts.push(responseBody);
  const dataError = getString(data, 'error');
  if (dataError) parts.push(dataError);
  const nestedMessage = getString(nestedError, 'message');
  if (nestedMessage && nestedMessage !== message) parts.push(nestedMessage);
  const code = getString(typed, 'code');
  if (code) parts.push(`code=${code}`);
  if (parts.length === 0) {
    try { return summarizeText(JSON.stringify(err), 140); } catch { return 'unknown error'; }
  }
  return summarizeText(parts.join(' · '), 140);
}

function extractResponseBodyReason(responseBody: unknown): string {
  if (typeof responseBody !== 'string') return '';
  const trimmed = responseBody.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed) as AnyRecord;
    const parsedError = getNested(parsed, 'error');
    const parsedMessage = getString(parsedError, 'message') || getString(parsed, 'message') || getString(parsed, 'error_description') || getString(parsed, 'detail');
    if (parsedMessage.trim()) return parsedMessage.trim();
  } catch {}
  return trimmed;
}

/** exactDispatchErrorReason does extract the highest-signal dispatch error reason for users. */
export function exactDispatchErrorReason(err: unknown): string {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return summarizeText(err, 480);
  const typed = err as AnyRecord;
  const data = getNested(typed, 'data');
  const nestedError = getNested(typed, 'error');
  const status = typed.statusCode ?? typed.status ?? data.statusCode ?? nestedError.status;
  const rawCandidates = [getString(data, 'message'), getString(typed, 'message'), getString(nestedError, 'message'), getString(data, 'error'), extractResponseBodyReason(data.responseBody), getString(typed, 'code') ? `code=${getString(typed, 'code')}` : ''];
  const normalized: string[] = [];
  for (const candidate of rawCandidates) {
    const text = candidate.trim();
    if (!text || normalized.includes(text)) continue;
    normalized.push(text);
  }
  let reason = normalized[0] ?? 'unknown error';
  if (Number.isFinite(status)) reason = `${status} ${reason}`;
  return summarizeText(reason, 480);
}

/** dispatchErrorHint does return provider/category-specific remediation guidance text. */
export function dispatchErrorHint(providerID: string, category: string): string {
  if (providerID === 'openai' && category === 'auth_config') return 'OpenAI authentication/config issue. ChatGPT account login is not OpenAI API auth here. Use a valid OpenAI API key/token with billing enabled (opencode auth login openai).';
  if (providerID === 'openai' && category === 'quota') return 'OpenAI API quota/billing appears exhausted for the configured API key.';
  if (category === 'auth_config') return 'Provider authentication/config failed. Verify provider login and model availability in OpenCode.';
  if (category === 'quota') return 'Provider quota/billing appears exhausted for the configured credentials.';
  if (category === 'transient') return 'Provider appears temporarily unavailable/rate-limited.';
  return 'Unknown provider error. Check provider logs and credentials.';
}

/** categorizeDispatchError does classify dispatch errors into auth, quota, transient, or unknown categories. */
export function categorizeDispatchError(err: unknown): string {
  if (!err) return 'unknown';
  const typed = err as AnyRecord;
  const data = getNested(typed, 'data');
  const nestedError = getNested(typed, 'error');
  const text = [typeof err === 'string' ? err : '', getString(typed, 'message'), getString(typed, 'code'), getString(data, 'message'), getString(data, 'responseBody'), getString(data, 'error'), getString(nestedError, 'message')].join(' ').toLowerCase();
  const status = typed.statusCode ?? typed.status ?? data.statusCode ?? nestedError.status;
  if (status === 401 || status === 403 || /unauthorized|forbidden|invalid.?api.?key|invalid.?credentials|access.?denied/.test(text) || /authentication|not.?authorized/.test(text)) return 'auth_config';
  if (status === 404 || /model.?not.?found|not.?found|does.?not.?exist|unknown.?model|unsupported.?model/.test(text) || /no.?such.?model|invalid.?model/.test(text)) return 'auth_config';
  if (/insufficient.?quota|quota.?exceeded|billing.?hard.?limit|out.?of.?credits/.test(text) || status === 402) return 'quota';
  if (status === 429 || status === 503 || status === 502 || status === 500 || /rate.?limit|too.?many.?requests|overloaded|temporarily.?unavailable|timeout|timed.?out/.test(text) || /econnreset|econnrefused|enotfound|socket.?hang.?up|network|fetch.?failed/.test(text)) return 'transient';
  return 'unknown';
}

/** recordFailoverEvent does append one formatted failover line to the in-memory ring buffer. */
export function recordFailoverEvent(line: string): void {
  failoverEventLog.push(line);
  if (failoverEventLog.length > FAILOVER_LOG_MAX_ENTRIES) failoverEventLog.shift();
}

/** buildSystemPromptInfo does compose the failover status system prompt line. */
export function buildSystemPromptInfo(currentModel: StatusModel | null | undefined, fallbackChain: StatusModel[], lastFailoverMs: number | undefined): string {
  const chainText = fallbackChain.map((model, idx) => `${idx + 1}) ${formatModel(model)}`).join(' -> ') || '(none - tier unknown)';
  const watchdogSeconds = Math.max(1, Math.round((runtimeSettings.stallWatchdogMs ?? 45000) / 1000));
  const timingText = typeof lastFailoverMs === 'number' ? `Last observed takeover latency in this session: ${lastFailoverMs}ms.` : 'Takeover timing: runs immediately on retry-status backoff, otherwise triggers once the session reaches idle (usually under a few seconds).';
  const watchdogText = runtimeSettings.stallWatchdogEnabled ? `Stall watchdog: auto-reroute if no assistant output within ${watchdogSeconds}s after failover dispatch.` : 'Stall watchdog: disabled (no auto-reroute on stall).';
  return `${SYSTEM_PROMPT_PREFIX} Current model: ${formatModel(currentModel)}. Failover chain: ${chainText}. ${timingText} ${watchdogText}`;
}

/** buildFailoverToastMessage does format the multiline failover activation toast body. */
export function buildFailoverToastMessage({ sessionID, fromModel, toModel, tierHint, queuedAt }: FailoverToastPayload): string {
  const chainText = buildFallbackChain(tierHint).map(formatModel).join(' -> ');
  const queuedMs = Number.isFinite(queuedAt) ? Math.max(0, Date.now() - queuedAt) : undefined;
  const trigger = (lastTriggerBySession.get(sessionID) as { source?: string; note?: string } | undefined);
  return ['Failover Active', `From: ${formatModel(fromModel)}`, `To:   ${formatModel(toModel)}`, `Tier: ${tierHint}`, `Trigger: ${trigger ? `${trigger.source}${trigger.note ? ` (${trigger.note})` : ''}` : 'unknown'}`, `Takeover: ${Number.isFinite(queuedMs) ? `${queuedMs}ms` : 'n/a'}`, `Chain: ${chainText}`].join('\n');
}

/** buildStatusReport does generate the complete human-readable status report output. */
export function buildStatusReport(sessionID: string | null | undefined, settingsPath: string): string {
  const lines: string[] = ['Quota Failover Status', `Debug toasts: ${runtimeSettings.debugToasts ? 'on' : 'off'}`, `Provider chain: ${providerChainSummary()}`, `Stall watchdog timeout: ${formatMs(runtimeSettings.stallWatchdogMs)}`, `Stall watchdog: ${runtimeSettings.stallWatchdogEnabled ? 'enabled' : 'disabled (default)'}`, `Global failover cooldown: ${formatMs(runtimeSettings.globalCooldownMs)}`, `Min retry backoff threshold: ${formatMs(runtimeSettings.minRetryBackoffMs)}`, 'Tier mappings:', fallbackSummaryByTier()];
  if (!sessionID) {
    lines.push('Session: none selected', 'Quota window note: Claude Max and ChatGPT Pro subscription quota/reset windows are not exposed via plugin APIs.', 'Failover uses observed quota/rate-limit errors and retry windows.');
    return lines.join('\n');
  }

  lines.push(`Session: ${sessionID}`, `Pending failover: ${pendingBySession.has(sessionID) ? 'yes' : 'no'}`);
  const stall = stallWatchdogBySession.get(sessionID) as AnyRecord | undefined;
  lines.push(stall ? `Stall watchdog: armed for ${formatModel(stall.target as StatusModel)} (age ${formatMs(Date.now() - (stall.startedAt as number))}, timeout ${formatMs(stall.timeoutMs)})` : 'Stall watchdog: idle');
  const lastTrigger = lastTriggerBySession.get(sessionID) as { source?: string; note?: string } | undefined;
  lines.push(lastTrigger ? `Last trigger: ${lastTrigger.source}${lastTrigger.note ? ` (${lastTrigger.note})` : ''}` : 'Last trigger: none');
  const retryStatus = lastRetryStatusBySession.get(sessionID) as AnyRecord | undefined;
  lines.push(retryStatus ? `Last retry backoff: ${formatMs(retryStatus.retryBackoffMs)} (attempt ${retryStatus.attempt ?? '?'})` : 'Last retry backoff: none seen');
  const failoverMs = lastFailoverMsBySession.get(sessionID);
  lines.push(`Last failover latency: ${typeof failoverMs === 'number' ? `${failoverMs}ms` : 'n/a'}`);
  const transition = lastTransitionBySession.get(sessionID) as AnyRecord | undefined;
  lines.push(transition ? `Last transition: ${formatModel(transition.from as StatusModel)} -> ${formatModel(transition.to as StatusModel)} (tier=${transition.tierHint})` : 'Last transition: none');

  const assistantStats = lastAssistantStatsBySession.get(sessionID) as AnyRecord | undefined;
  if (!assistantStats) {
    lines.push('Context headroom: unknown (no assistant usage snapshot seen yet).');
  } else {
    const currentModel = { providerID: assistantStats.providerID as string, modelID: assistantStats.modelID as string };
    const tierHint = inferTierFromModel(currentModel);
    const currentLimit = estimateModelContextLimit(currentModel.modelID);
    const inputTokens = assistantStats.inputTokens;
    lines.push(`Last model usage: ${formatModel(currentModel)} (input=${formatCount(inputTokens)}, output=${formatCount(assistantStats.outputTokens)}, reasoning=${formatCount(assistantStats.reasoningTokens)})`);
    if (Number.isFinite(inputTokens) && typeof currentLimit === 'number') {
      const usedPct = Math.min(100, Math.max(0, ((inputTokens as number) / currentLimit) * 100));
      lines.push(`Context headroom (current): ${formatCount(Math.max(0, currentLimit - (inputTokens as number)))} / ${formatCount(currentLimit)} tokens left (${usedPct.toFixed(1)}% used from last input).`);
      const fallbackCandidate = buildFallbackChain(tierHint).find((candidate) => modelKey(candidate) !== modelKey(currentModel));
      if (fallbackCandidate) {
        const fallbackLimit = estimateModelContextLimit(fallbackCandidate.modelID);
        lines.push(typeof fallbackLimit === 'number'
          ? `Context headroom (first fallback ${formatModel(fallbackCandidate)}): ${formatCount(Math.max(0, fallbackLimit - (inputTokens as number)))} / ${formatCount(fallbackLimit)} tokens left (same prompt estimate).`
          : `Context headroom (first fallback ${formatModel(fallbackCandidate)}): unknown (limit metadata unavailable).`);
      }
    } else {
      lines.push('Context headroom: unknown (provider does not expose enough token/limit metadata for this model snapshot).');
    }
  }

  lines.push('Quota window note: Claude Max and ChatGPT Pro subscription quota/reset windows are not exposed via plugin APIs.', 'Failover uses observed quota/rate-limit errors and retry windows.', '', `Log file: ${join(dirname(settingsPath), FAILOVER_LOG_FILE_NAME)}`);
  if (failoverEventLog.length > 0) {
    const recentCount = Math.min(failoverEventLog.length, 15);
    lines.push(`Recent events (last ${recentCount} of ${failoverEventLog.length}):`);
    for (const entry of failoverEventLog.slice(-recentCount)) lines.push(`  ${entry}`);
  } else {
    lines.push('Recent events: none');
  }
  return lines.join('\n');
}
