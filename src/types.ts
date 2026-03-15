import type { Plugin, PluginInput } from '@opencode-ai/plugin';
import type { ToolContext as PluginToolContext } from '@opencode-ai/plugin/tool';

/** KnownProviderID enumerates the AI provider identifiers supported by the failover system. */
export type KnownProviderID = 'amazon-bedrock' | 'openai' | 'anthropic';

/** KnownTier enumerates the performance tiers used for provider fallback parity. */
export type KnownTier = 'opus' | 'sonnet' | 'haiku';

/** TierModelMap maps each known tier to a concrete model ID string. */
export type TierModelMap = Record<KnownTier, string>;

/** ProviderTierMatrix maps provider IDs to their tier-to-model mappings. */
export type ProviderTierMatrix = Record<string, TierModelMap>;

/** OpenCodePlugin re-exports the SDK plugin type. Source of truth lives in @opencode-ai/plugin. */
export type OpenCodePlugin = Plugin;

/** OpenCodePluginInput re-exports the SDK plugin init input from @opencode-ai/plugin. */
export type OpenCodePluginInput = PluginInput;

/** OpenCodeToolContext re-exports the SDK tool execution context from @opencode-ai/plugin/tool. */
export type OpenCodeToolContext = PluginToolContext;

/** ProviderModel identifies a specific model on a specific provider for dispatch and failover routing. */
export interface ProviderModel {
  /** Provider identifier, usually one of KnownProviderID. */
  providerID: string;
  /** Exact provider model ID string. */
  modelID: string;
}

/** RuntimeSettings holds the mutable configuration loaded from disk and updated via MCP tools. */
export interface RuntimeSettings {
  /** Whether debug toasts are enabled for detection traces. */
  debugToasts: boolean;
  /** Ordered provider failover chain. */
  providerChain: string[];
  /** Per-provider, per-tier model mapping matrix. */
  modelByProviderAndTier: ProviderTierMatrix;
  /** Timeout window used by the session stall watchdog. */
  stallWatchdogMs: number;
  /** Enables/disables stall watchdog behavior. */
  stallWatchdogEnabled: boolean;
  /** Global minimum cooldown between failovers. */
  globalCooldownMs: number;
  /** Minimum retry backoff that qualifies as quota exhaustion. */
  minRetryBackoffMs: number;
  /** Per-provider substring patterns that trigger failover when matched in error text. */
  customFailoverPatterns: Record<string, string[]>;
}

/** ErrorDetails aggregates error information extracted from heterogeneous provider error shapes. */
export interface ErrorDetails {
  /** Lower-cased normalized text built from all known error fields. */
  text: string;
  /** HTTP-like status code if discovered, otherwise null. */
  statusCode: number | null;
  /** Retryability signal if known from provider payload, otherwise null. */
  isRetryable: boolean | null;
}

/** PendingFailover holds the queued failover payload awaiting a dispatch-safe event. */
export interface PendingFailover {
  /** Tier hint used to select the fallback target during dispatch. */
  modelTierHint?: KnownTier | string | null;
  /** Provider/model that failed and triggered this failover. */
  failedModel?: ProviderModel | null;
  /** Epoch milliseconds when failover was queued. */
  queuedAt: number;
}

/** AssistantStats captures the token accounting snapshot from the most recent assistant response. */
export interface AssistantStats {
  /** Provider used in the latest assistant response. */
  providerID: string;
  /** Model used in the latest assistant response. */
  modelID: string;
  /** Prompt/input token count. */
  inputTokens: number | undefined;
  /** Completion/output token count. */
  outputTokens: number | undefined;
  /** Reasoning/thinking token count, if available. */
  reasoningTokens: number | undefined;
  /** Epoch milliseconds when snapshot was recorded. */
  at: number;
}

/** TransitionRecord documents a completed provider/model transition during failover. */
export interface TransitionRecord {
  /** Previous model before failover dispatch. */
  from: ProviderModel | null;
  /** Selected model after failover dispatch. */
  to: ProviderModel;
  /** Tier hint used while selecting the fallback target. */
  tierHint: KnownTier | string | null;
  /** Epoch milliseconds when transition happened. */
  at: number;
}

/** TriggerRecord captures minimal telemetry about the last failover signal for a session. */
export interface TriggerRecord {
  /** Trigger source name (event path, detector, watchdog, etc). */
  source: string;
  /** Short normalized trigger note text. */
  note: string;
  /** Epoch milliseconds when trigger was recorded. */
  at: number;
}

/** ProviderHealthRecord tracks consecutive dispatch failures for a provider to gate retries. */
export interface ProviderHealthRecord {
  /** Number of consecutive dispatch failures for provider. */
  consecutiveFailures: number;
  /** Timestamp of most recent failure. */
  lastFailureAt: number;
  /** Most recent failure error category (auth_config, quota, transient, unknown), or null. */
  lastErrorCategory: string | null;
}

/** RetryStatusRecord holds the most recent retry backoff details observed for a session. */
export interface RetryStatusRecord {
  /** Retry attempt number from the session.status event. */
  attempt: unknown;
  /** Next retry timestamp from the session.status event. */
  nextAt: unknown;
  /** Source message text from the retry status event. */
  message: unknown;
  /** Parsed retry delay in milliseconds. */
  retryBackoffMs: number;
}

/** StallWatchdogEntry represents an active stall watchdog timer registration for a session. */
export interface StallWatchdogEntry {
  /** Selected fallback target guarded by this timer. */
  target: ProviderModel;
  /** Tier hint used when arming the watchdog. */
  tierHint: string | null;
  /** Epoch milliseconds when watchdog was armed. */
  startedAt: number;
  /** Timeout duration in milliseconds. */
  timeoutMs: number;
  /** Timer handle used to cancel watchdog dispatch. */
  timer: ReturnType<typeof setTimeout>;
}

/** PersistedSettings defines the on-disk settings.json payload shape with all fields optional. */
export interface PersistedSettings {
  /** Optional stored provider chain. */
  providerChain?: string[];
  /** Optional stored provider/tier model matrix. */
  modelByProviderAndTier?: ProviderTierMatrix;
  /** Optional stored debug toast flag. */
  debugToasts?: boolean;
  /** Optional stored watchdog timeout. */
  stallWatchdogMs?: number;
  /** Optional stored watchdog enabled flag. */
  stallWatchdogEnabled?: boolean;
  /** Optional stored global cooldown. */
  globalCooldownMs?: number;
  /** Optional stored minimum retry backoff threshold. */
  minRetryBackoffMs?: number;
  /** Optional stored per-provider custom failover error patterns. */
  customFailoverPatterns?: Record<string, string[]>;
}

/** AttemptedTargetsBySession indexes per-session, per-message attempted model keys in memory. */
export interface AttemptedTargetsBySession {
  /** Map key is session ID, value is per-message attempted model keys. */
  bySession: Map<string, Map<string, Set<string>>>;
}

/** FailoverEventRecord represents a structured event captured in the failover event ring buffer. */
export interface FailoverEventRecord {
  /** RFC3339 event timestamp. */
  timestamp: string;
  /** Log level for ring buffer report output. */
  level: string;
  /** Session identifier associated with event. */
  sessionID: string | null;
  /** Additional event fields collapsed into key/value map. */
  fields: Record<string, string | number | boolean>;
}

/** DispatchErrorSummary normalizes a dispatch error into reason, category, and user-facing hint. */
export interface DispatchErrorSummary {
  /** Human-readable reason text extracted from error payloads. */
  reason: string;
  /** Classified reason bucket used by hint generation. */
  category: 'auth_config' | 'quota' | 'transient' | 'unknown';
  /** User-facing next-step hint text. */
  hint: string;
}

/** RetryBackoffParseResult holds the parsed retry backoff duration from an error text segment. */
export interface RetryBackoffParseResult {
  /** True when a retry segment marker was found. */
  matched: boolean;
  /** Backoff parsed from the marker segment. */
  backoffMs: number;
  /** Segment captured from source text. */
  segment: string;
}

/** QuotaSignalDecision captures the verdict produced by quota-signal evaluators. */
export interface QuotaSignalDecision {
  /** Whether failover should trigger for this signal. */
  shouldTrigger: boolean;
  /** Detector source responsible for this decision. */
  detector: string;
  /** Optional explanatory note for debug toasts. */
  note: string;
}

/** ContextHeadroomSnapshot captures token headroom at a point in time for status reporting. */
export interface ContextHeadroomSnapshot {
  /** Last observed model. */
  modelID: string;
  /** Estimated model context limit if known. */
  contextLimit: number | undefined;
  /** Used tokens at snapshot time. */
  usedTokens: number;
  /** Remaining context tokens if estimable. */
  remainingTokens: number | undefined;
}

/** SessionStatusSnapshot aggregates session-scoped state for status report generation. */
export interface SessionStatusSnapshot {
  /** Session identifier represented by this snapshot. */
  sessionID: string;
  /** Last recorded trigger for the session, if any. */
  lastTrigger: TriggerRecord | null;
  /** Last transition record for the session, if any. */
  lastTransition: TransitionRecord | null;
  /** Last assistant stats snapshot for the session, if any. */
  assistantStats: AssistantStats | null;
  /** Retry status record for the session, if any. */
  retryStatus: RetryStatusRecord | null;
}

/** SessionEventEnvelope wraps the base transport payload for session event handling. */
export interface SessionEventEnvelope {
  /** Event name in the plugin event stream. */
  type: string;
  /** Loosely typed provider event properties payload. */
  properties: Record<string, unknown>;
}

/** DebugTriggerPayload carries metadata for queuing a debug toast notification. */
export interface DebugTriggerPayload {
  /** Session tied to trigger. */
  sessionID: string;
  /** Trigger source identifier. */
  source: string;
  /** Trigger explanatory text. */
  text: string;
}
