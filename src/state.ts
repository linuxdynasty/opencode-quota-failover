import { buildAvailableModelsByProvider, buildDefaultProviderTierMatrix } from './catalog-lookups.js';
import { DEFAULT_PROVIDER_CHAIN } from './constants.js';
import type { ProviderTierMatrix, RuntimeSettings } from './types.js';

type AttemptedTargetsSessionMap = Map<string, Map<string, Set<string>>>;
type CustomModelEntry = {
  provider: string;
  modelID: string;
  tier: string;
  isDefault?: boolean;
  contextWindow?: number;
};

const DEFAULT_MODEL_BY_PROVIDER_AND_TIER: ProviderTierMatrix = buildDefaultProviderTierMatrix();

/** pendingBySession is the queued failover payload keyed by session ID. */
export const pendingBySession = new Map<string, Record<string, unknown>>();

/** attemptedTargetsBySession is attempted model keys keyed by session and user-message ID. */
export const attemptedTargetsBySession: AttemptedTargetsSessionMap = new Map();

/** lastFailoverMsBySession is the last successful failover latency in milliseconds by session. */
export const lastFailoverMsBySession = new Map<string, number>();

/** lastRetryStatusBySession is the most recent retry status payload keyed by session. */
export const lastRetryStatusBySession = new Map<string, Record<string, unknown>>();

/** lastTriggerBySession is the last debug trigger record keyed by session. */
export const lastTriggerBySession = new Map<string, Record<string, unknown>>();

/** lastAssistantStatsBySession is the latest assistant token/model snapshot keyed by session. */
export const lastAssistantStatsBySession = new Map<string, Record<string, unknown>>();

/** lastTransitionBySession is the latest failover transition keyed by session. */
export const lastTransitionBySession = new Map<string, Record<string, unknown>>();

/** debugToastsShownBySession is the consumed debug-toast budget keyed by session. */
export const debugToastsShownBySession = new Map<string, number>();

/** stallWatchdogBySession is the active stall watchdog registration keyed by session. */
export const stallWatchdogBySession = new Map<string, Record<string, unknown>>();

/** infoShownBySession is the set of sessions that have already seen system prompt info toast. */
export const infoShownBySession = new Set<string>();

/** providerHealth is the dispatch failure health state keyed by provider ID. */
export const providerHealth = new Map<string, Record<string, unknown>>();

/** bounceCountBySession is the failover bounce counter keyed by session ID. */
export const bounceCountBySession = new Map<string, number>();

/** failoverEventLog is the in-memory ring buffer of formatted failover event lines. */
export const failoverEventLog: string[] = [];

/** runtimeSettings is the mutable runtime configuration object shared across imports. */
export const runtimeSettings: RuntimeSettings = {
  debugToasts: true,
  providerChain: [...DEFAULT_PROVIDER_CHAIN],
  modelByProviderAndTier: cloneProviderTierMatrix(DEFAULT_MODEL_BY_PROVIDER_AND_TIER),
  stallWatchdogMs: 45 * 1000,
  stallWatchdogEnabled: false,
  globalCooldownMs: 60 * 1000,
  minRetryBackoffMs: 30 * 60 * 1000,
  customFailoverPatterns: {},
};

let lastGlobalFailoverAt = 0;
let lastGlobalFailoverSessionID: string | null = null;
let customModels: CustomModelEntry[] = [];
let AVAILABLE_MODEL_IDS_BY_PROVIDER = buildAvailableModelsByProvider();

/** cloneProviderTierMatrix does a shallow-clone of a provider-tier matrix. */
export function cloneProviderTierMatrix(matrix: ProviderTierMatrix): ProviderTierMatrix {
  const clone: ProviderTierMatrix = {};
  for (const providerID of Object.keys(matrix ?? {})) {
    clone[providerID] = { ...(matrix[providerID] ?? {}) };
  }
  return clone;
}

/** getLastGlobalFailoverAt does return the latest global failover timestamp in epoch milliseconds. */
export function getLastGlobalFailoverAt(): number {
  return lastGlobalFailoverAt;
}

/** setLastGlobalFailoverAt does update the latest global failover timestamp. */
export function setLastGlobalFailoverAt(value: number): void {
  lastGlobalFailoverAt = value;
}

/** getLastGlobalFailoverSessionID does return the session ID that last performed global failover. */
export function getLastGlobalFailoverSessionID(): string | null {
  return lastGlobalFailoverSessionID;
}

/** setLastGlobalFailoverSessionID does update the last global failover session ID. */
export function setLastGlobalFailoverSessionID(value: string | null): void {
  lastGlobalFailoverSessionID = value;
}

/** getCustomModels does return the mutable custom-model registry. */
export function getCustomModels(): CustomModelEntry[] {
  return customModels;
}

/** setCustomModels does replace the custom-model registry with the provided entries. */
export function setCustomModels(models: CustomModelEntry[]): void {
  customModels = models;
}

/** addCustomModel does append one custom-model entry to the registry. */
export function addCustomModel(model: CustomModelEntry): void {
  customModels.push(model);
}

/** getAvailableModelsByProvider does return the mutable provider-model lookup table. */
export function getAvailableModelsByProvider(): Record<string, readonly string[]> {
  return AVAILABLE_MODEL_IDS_BY_PROVIDER;
}

/** setAvailableModelsByProvider does replace the runtime provider-model lookup table. */
export function setAvailableModelsByProvider(value: Record<string, readonly string[]>): void {
  AVAILABLE_MODEL_IDS_BY_PROVIDER = value;
}

/** addToAvailableModels does append a model ID to a provider runtime catalog. */
export function addToAvailableModels(provider: string, modelID: string): void {
  if (!Array.isArray(AVAILABLE_MODEL_IDS_BY_PROVIDER[provider])) {
    AVAILABLE_MODEL_IDS_BY_PROVIDER[provider] = [];
  }
  (AVAILABLE_MODEL_IDS_BY_PROVIDER[provider] as string[]).push(modelID);
}

/** clearStallWatchdog does clear and remove the active watchdog timer for a session. */
export function clearStallWatchdog(sessionID: string): void {
  const existing = stallWatchdogBySession.get(sessionID);
  const timer = existing?.timer;
  if (typeof timer === 'object' || typeof timer === 'number') {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  }
  stallWatchdogBySession.delete(sessionID);
}

/** cleanupSession does remove all tracked in-memory state for a session. */
export function cleanupSession(sessionID: string): void {
  clearStallWatchdog(sessionID);
  pendingBySession.delete(sessionID);
  attemptedTargetsBySession.delete(sessionID);
  lastFailoverMsBySession.delete(sessionID);
  lastRetryStatusBySession.delete(sessionID);
  lastTriggerBySession.delete(sessionID);
  lastAssistantStatsBySession.delete(sessionID);
  lastTransitionBySession.delete(sessionID);
  infoShownBySession.delete(sessionID);
  debugToastsShownBySession.delete(sessionID);
  bounceCountBySession.delete(sessionID);
}

/** resetGlobalFailoverState does reset only global failover timestamp/session tracking. */
export function resetGlobalFailoverState(): void {
  lastGlobalFailoverAt = 0;
  lastGlobalFailoverSessionID = null;
}

/** resetRuntimeSettings does restore runtime settings and mutable shared state to defaults. */
export function resetRuntimeSettings(): void {
  runtimeSettings.debugToasts = true;
  runtimeSettings.providerChain = [...DEFAULT_PROVIDER_CHAIN];
  runtimeSettings.modelByProviderAndTier = cloneProviderTierMatrix(DEFAULT_MODEL_BY_PROVIDER_AND_TIER);
  runtimeSettings.stallWatchdogMs = 45 * 1000;
  runtimeSettings.stallWatchdogEnabled = false;
  runtimeSettings.globalCooldownMs = 60 * 1000;
  runtimeSettings.minRetryBackoffMs = 30 * 60 * 1000;
  runtimeSettings.customFailoverPatterns = {};
  customModels = [];
  AVAILABLE_MODEL_IDS_BY_PROVIDER = buildAvailableModelsByProvider();
  resetGlobalFailoverState();
  failoverEventLog.length = 0;
  providerHealth.clear();
  bounceCountBySession.clear();
}
