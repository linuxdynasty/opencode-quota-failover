import { availableModelsForProvider, estimateContextWindow, getModelNotes, inferTierFromModelID } from './catalog-lookups.js';
import {
  DEFAULT_TIER,
  DISPATCH_COOLDOWN_MS,
  KNOWN_PROVIDER_IDS,
  KNOWN_TIERS,
  MAX_CONSECUTIVE_DISPATCH_FAILURES,
} from './constants.js';
import {
  addToAvailableModels,
  getAvailableModelsByProvider,
  getCustomModels,
  providerHealth,
  runtimeSettings,
} from './state.js';
import type { KnownProviderID, KnownTier } from './types.js';

type ProviderModel = {
  providerID?: string;
  modelID?: string;
};

type RuntimeCustomModelEntry = ReturnType<typeof getCustomModels>[number];

type ProviderHealthRecord = {
  consecutiveFailures: number;
  lastFailureAt: number;
  lastErrorCategory: string | null;
};

/** modelKey does build a canonical provider/model cache key. */
export function modelKey(model: ProviderModel | null | undefined): string {
  return `${model?.providerID}/${model?.modelID}`;
}

function isKnownProviderID(providerID: string): providerID is KnownProviderID {
  return KNOWN_PROVIDER_IDS.includes(providerID as KnownProviderID);
}

function isKnownTier(tier: string): tier is KnownTier {
  return KNOWN_TIERS.includes(tier as KnownTier);
}

/** formatModel does format provider/model identifiers for user-facing display. */
export function formatModel(model: ProviderModel | null | undefined): string {
  if (!model?.providerID || !model?.modelID) {
    return 'unknown/unknown';
  }
  return `${model.providerID}/${model.modelID}`;
}

/** availableModelIDsForProvider does return runtime-overridden model IDs for a provider. */
export function availableModelIDsForProvider(providerID: string): string[] {
  const runtimeModels = getAvailableModelsByProvider()?.[providerID];
  if (Array.isArray(runtimeModels) && runtimeModels.length > 0) {
    return [...runtimeModels];
  }
  return [...availableModelsForProvider(providerID)];
}

/** addModelToProviderCatalog does append a model ID to the provider runtime catalog if missing. */
export function addModelToProviderCatalog(providerID: string, modelID: string): void {
  if (!isKnownProviderID(providerID)) {
    return;
  }

  const normalized = modelID?.trim();
  if (!normalized) {
    return;
  }

  const availableModels = getAvailableModelsByProvider();
  if (!Array.isArray(availableModels[providerID])) {
    availableModels[providerID] = [...availableModelsForProvider(providerID)];
  }

  const providerModels = availableModels[providerID] ?? [];
  const lower = normalized.toLowerCase();
  const exists = providerModels.some((candidate) => candidate.toLowerCase() === lower);
  if (!exists) {
    addToAvailableModels(providerID, normalized);
  }
}

/** normalizeCustomModelEntry does sanitize and validate a custom model payload. */
export function normalizeCustomModelEntry(entry: unknown): RuntimeCustomModelEntry | null {
  const maybeEntry = entry as Partial<RuntimeCustomModelEntry> | null | undefined;
  const provider = maybeEntry?.provider;
  if (!provider || !isKnownProviderID(provider)) {
    return null;
  }

  const modelID = maybeEntry?.modelID?.trim();
  if (!modelID) {
    return null;
  }

  const tier = maybeEntry?.tier;
  if (!tier || !isKnownTier(tier)) {
    return null;
  }

  const normalized: RuntimeCustomModelEntry = {
    provider,
    modelID,
    tier,
    isDefault: maybeEntry?.isDefault === true,
  };

  if (Number.isFinite(maybeEntry?.contextWindow)) {
    normalized.contextWindow = Math.max(1, Math.round(maybeEntry.contextWindow as number));
  }

  return normalized;
}

/** sameCustomModelKey does compare two custom models by provider and case-insensitive model ID. */
export function sameCustomModelKey(
  left: RuntimeCustomModelEntry | null | undefined,
  right: RuntimeCustomModelEntry | null | undefined,
): boolean {
  return (
    left?.provider === right?.provider
    && left?.modelID?.toLowerCase() === right?.modelID?.toLowerCase()
  );
}

/** findCustomModel does find a custom model by optional provider and model ID. */
export function findCustomModel(
  providerID: string | null | undefined,
  modelID: string | null | undefined,
): RuntimeCustomModelEntry | null {
  const normalized = modelID?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (providerID) {
    return (
      getCustomModels().find(
        (entry) =>
          entry.provider === providerID
          && entry.modelID.toLowerCase() === normalized,
      ) ?? null
    );
  }

  return (
    getCustomModels().find((entry) => entry.modelID.toLowerCase() === normalized) ?? null
  );
}

/** normalizeProviderList does validate, dedupe, and preserve provider ordering. */
export function normalizeProviderList(providers: string[] | null | undefined): string[] {
  const deduped: string[] = [];
  for (const provider of providers ?? []) {
    if (!isKnownProviderID(provider)) {
      continue;
    }
    if (deduped.includes(provider)) {
      continue;
    }
    deduped.push(provider);
  }
  return deduped;
}

/** providerChainSummary does format the configured provider chain. */
export function providerChainSummary(): string {
  return runtimeSettings.providerChain.join(' -> ');
}

/** canonicalModelID does normalize and validate a model ID for a specific provider. */
export function canonicalModelID(providerID: string, modelID: string | null | undefined): string | null {
  const normalized = modelID?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const available = availableModelIDsForProvider(providerID);
  return available.find((candidate) => candidate.toLowerCase() === normalized) ?? null;
}

/** getSelectionWarningNotes does return model-selection warnings or notes. */
export function getSelectionWarningNotes(providerID: string, modelID: string): string | undefined {
  const catalogNotes = getModelNotes(providerID, modelID);
  if (catalogNotes) {
    return catalogNotes;
  }

  if (providerID === 'amazon-bedrock' && modelID === 'moonshotai.kimi-k2.5') {
    return [
      'Warning: moonshotai.kimi-k2.5 can have long first-token latency in tool-heavy sessions.',
      'Tip: try moonshot.kimi-k2-thinking for faster/stabler interactive tool use.',
    ].join('\n');
  }

  return undefined;
}

/** getModelForProviderTier does resolve a model ID for provider+tier from runtime mapping. */
export function getModelForProviderTier(providerID: string, tier: KnownTier | null | undefined): string | null {
  if (!tier) {
    return null;
  }

  const providerModels = runtimeSettings.modelByProviderAndTier[providerID];
  if (!providerModels) {
    return null;
  }

  return providerModels[tier] ?? null;
}

/** providerTierSummary does format provider model mapping by known tiers. */
export function providerTierSummary(providerID: string): string {
  return KNOWN_TIERS.map(
    (tier) => `${tier}: ${providerID}/${getModelForProviderTier(providerID, tier) ?? 'n/a'}`,
  ).join('\n');
}

/** buildModelCatalogReport does build a formatted catalog and active mapping report. */
export function buildModelCatalogReport(providerID: string | null | undefined): string {
  const providers = providerID ? [providerID] : KNOWN_PROVIDER_IDS;
  const lines = ['Failover Model Catalog'];

  for (const id of providers) {
    lines.push(`Provider: ${id}`);
    lines.push('Available models:');
    for (const modelID of availableModelIDsForProvider(id)) {
      lines.push(`- ${modelID}`);
    }
    lines.push('Active tier mapping:');
    lines.push(providerTierSummary(id));
  }

  lines.push('');
  lines.push('Tip: use failover_set_model to choose a provider/tier target model.');
  return lines.join('\n');
}

/** inferTierFromModel does infer a tier from custom model metadata or catalog rules. */
export function inferTierFromModel(model: ProviderModel | null | undefined): KnownTier | null {
  const providerID = model?.providerID;
  const modelID = model?.modelID ?? '';
  if (!modelID) {
    return null;
  }

  const custom = findCustomModel(providerID, modelID);
  if (custom?.tier && isKnownTier(custom.tier)) {
    return custom.tier;
  }

  return inferTierFromModelID(modelID);
}

/** buildFallbackChain does build ordered fallback targets for a tier hint. */
export function buildFallbackChain(modelTierHint: KnownTier | null | undefined): Array<{ providerID: string; modelID: string }> {
  const tier = modelTierHint ?? DEFAULT_TIER;
  if (!tier) {
    return [];
  }

  const chain: Array<{ providerID: string; modelID: string }> = [];
  const providerOrder = runtimeSettings.providerChain;

  for (const providerID of providerOrder) {
    const modelID = getModelForProviderTier(providerID, tier);
    if (!modelID) {
      continue;
    }
    chain.push({ providerID, modelID });
  }

  return chain;
}

/** pickFallback does select the next eligible fallback model target. */
export function pickFallback(
  failedModel: ProviderModel | null | undefined,
  attemptedSet: Set<string>,
  modelTierHint: KnownTier | null | undefined,
): { providerID: string; modelID: string } | null {
  const fallbackChain = buildFallbackChain(modelTierHint);
  const failedKey = failedModel ? modelKey(failedModel) : null;

  for (const candidate of fallbackChain) {
    const candidateKey = modelKey(candidate);
    if (candidateKey === failedKey) {
      continue;
    }
    if (attemptedSet.has(candidateKey)) {
      continue;
    }
    if (isProviderInCooldown(candidate.providerID)) {
      continue;
    }
    return candidate;
  }

  return null;
}

/** fallbackSummaryByTier does summarize fallback chain ordering for each known tier. */
export function fallbackSummaryByTier(): string {
  return KNOWN_TIERS.map((tier) => {
    const chain = buildFallbackChain(tier).map(formatModel).join(' -> ') || '(none)';
    return `${tier}: ${chain}`;
  }).join('\n');
}

/** isProviderInCooldown does report whether provider dispatch is currently cooling down. */
export function isProviderInCooldown(providerID: string): boolean {
  const health = providerHealth.get(providerID) as ProviderHealthRecord | undefined;
  if (!health) {
    return false;
  }
  if (health.consecutiveFailures < MAX_CONSECUTIVE_DISPATCH_FAILURES) {
    return false;
  }
  return Date.now() - health.lastFailureAt < DISPATCH_COOLDOWN_MS;
}

/** recordDispatchFailure does increase provider failure counters after a dispatch error. */
export function recordDispatchFailure(providerID: string, errorCategory: string): void {
  const existing = (providerHealth.get(providerID) as ProviderHealthRecord | undefined) ?? {
    consecutiveFailures: 0,
    lastFailureAt: 0,
    lastErrorCategory: null,
  };
  providerHealth.set(providerID, {
    consecutiveFailures: existing.consecutiveFailures + 1,
    lastFailureAt: Date.now(),
    lastErrorCategory: errorCategory,
  });
}

/** clearDispatchFailures does clear provider failure/cooldown tracking after success. */
export function clearDispatchFailures(providerID: string): void {
  providerHealth.delete(providerID);
}

/** estimateModelContextLimit does estimate context window from custom metadata or catalog lookups. */
export function estimateModelContextLimit(modelID: string | null | undefined): number | undefined {
  if (!modelID) {
    return undefined;
  }

  const custom = findCustomModel(undefined, modelID);
  if (custom && Number.isFinite(custom.contextWindow)) {
    return custom.contextWindow;
  }

  return estimateContextWindow(modelID);
}
