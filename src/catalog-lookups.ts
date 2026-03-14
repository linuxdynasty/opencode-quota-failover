import { MODEL_CATALOG } from './catalog.js';
import type { KnownTier, ProviderTierMatrix, TierModelMap } from './types.js';

interface TierPatternLookup {
  pattern: string;
  tier: KnownTier;
}

interface ContextPatternLookup {
  pattern: string;
  contextWindow: number;
}

const KNOWN_TIERS: readonly KnownTier[] = ['opus', 'sonnet', 'haiku'];

const AVAILABLE_MODELS_BY_PROVIDER = buildAvailableModelsByProviderInternal();
const DEFAULT_TIER_MAP_BY_PROVIDER = buildDefaultTierMapByProviderInternal();
const DEFAULT_PROVIDER_TIER_MATRIX = buildDefaultProviderTierMatrixInternal();
const TIER_PATTERN_LOOKUPS = buildTierPatternLookupsInternal();
const CONTEXT_PATTERN_LOOKUPS = buildContextPatternLookupsInternal();

/** availableModelsForProvider returns every known model ID for the given provider. */
export function availableModelsForProvider(providerID: string): string[] {
  const modelIDs = AVAILABLE_MODELS_BY_PROVIDER[providerID] ?? [];
  return [...modelIDs];
}

/** defaultTierMapForProvider returns the default model mapping for every known tier. */
export function defaultTierMapForProvider(providerID: string): Record<KnownTier, string> {
  const defaults = DEFAULT_TIER_MAP_BY_PROVIDER[providerID];
  if (!defaults) {
    throw new Error(`No default tier map found for provider: ${providerID}`);
  }

  return { ...defaults };
}

/** buildDefaultProviderTierMatrix builds provider-tier defaults from catalog defaults. */
export function buildDefaultProviderTierMatrix(): ProviderTierMatrix {
  const matrix: ProviderTierMatrix = {};

  for (const [providerID, tierMap] of Object.entries(DEFAULT_PROVIDER_TIER_MATRIX)) {
    matrix[providerID] = { ...tierMap };
  }

  return matrix;
}

/** inferTierFromModelID infers a tier using exact IDs first, then longest tier pattern match. */
export function inferTierFromModelID(modelID: string): KnownTier | null {
  const id = modelID.toLowerCase();

  const exact = MODEL_CATALOG.find((model) => model.id.toLowerCase() === id);
  if (exact) {
    return exact.tier;
  }

  for (const lookup of TIER_PATTERN_LOOKUPS) {
    if (id.includes(lookup.pattern)) {
      return lookup.tier;
    }
  }

  return null;
}

/** estimateContextWindow estimates a model context window from exact IDs or known context patterns. */
export function estimateContextWindow(modelID: string): number | undefined {
  const id = modelID.toLowerCase();

  const exact = MODEL_CATALOG.find((model) => model.id.toLowerCase() === id);
  if (exact?.contextWindow !== undefined) {
    return exact.contextWindow;
  }

  for (const lookup of CONTEXT_PATTERN_LOOKUPS) {
    if (id.includes(lookup.pattern)) {
      return lookup.contextWindow;
    }
  }

  return undefined;
}

/** getModelNotes returns the catalog notes for a provider model, if present. */
export function getModelNotes(providerID: string, modelID: string): string | undefined {
  const model = MODEL_CATALOG.find(
    (entry) => entry.provider === providerID && entry.id.toLowerCase() === modelID.toLowerCase(),
  );
  return model?.notes;
}

/** buildAvailableModelsByProvider builds provider-keyed lists of known model IDs. */
export function buildAvailableModelsByProvider(): Record<string, readonly string[]> {
  const byProvider: Record<string, readonly string[]> = {};

  for (const [providerID, modelIDs] of Object.entries(AVAILABLE_MODELS_BY_PROVIDER)) {
    byProvider[providerID] = [...modelIDs];
  }

  return byProvider;
}

function buildAvailableModelsByProviderInternal(): Record<string, readonly string[]> {
  const byProvider = new Map<string, string[]>();

  for (const model of MODEL_CATALOG) {
    const list = byProvider.get(model.provider) ?? [];
    list.push(model.id);
    byProvider.set(model.provider, list);
  }

  return Object.fromEntries(byProvider.entries());
}

function buildDefaultTierMapByProviderInternal(): Record<string, TierModelMap> {
  const byProvider = new Map<string, Partial<TierModelMap>>();

  for (const model of MODEL_CATALOG) {
    if (!model.isDefault) {
      continue;
    }

    const tierMap = byProvider.get(model.provider) ?? {};
    tierMap[model.tier] = model.id;
    byProvider.set(model.provider, tierMap);
  }

  const result: Record<string, TierModelMap> = {};
  for (const [providerID, tierMap] of byProvider.entries()) {
    for (const tier of KNOWN_TIERS) {
      if (!tierMap[tier]) {
        throw new Error(`Missing default tier ${tier} for provider ${providerID}`);
      }
    }

    const opus = tierMap.opus;
    const sonnet = tierMap.sonnet;
    const haiku = tierMap.haiku;

    if (!opus || !sonnet || !haiku) {
      throw new Error(`Incomplete default tier map for provider ${providerID}`);
    }

    result[providerID] = {
      opus,
      sonnet,
      haiku,
    };
  }

  return result;
}

function buildDefaultProviderTierMatrixInternal(): ProviderTierMatrix {
  const matrix: ProviderTierMatrix = {};

  for (const [providerID, tierMap] of Object.entries(DEFAULT_TIER_MAP_BY_PROVIDER)) {
    matrix[providerID] = { ...tierMap };
  }

  return matrix;
}

function buildTierPatternLookupsInternal(): TierPatternLookup[] {
  const lookups: TierPatternLookup[] = [];

  for (const model of MODEL_CATALOG) {
    for (const pattern of model.tierPatterns) {
      lookups.push({ pattern: pattern.toLowerCase(), tier: model.tier });
    }
  }

  lookups.sort((a, b) => b.pattern.length - a.pattern.length);
  return lookups;
}

function buildContextPatternLookupsInternal(): ContextPatternLookup[] {
  const lookups: ContextPatternLookup[] = [];

  for (const model of MODEL_CATALOG) {
    if (model.contextWindow === undefined) {
      continue;
    }

    for (const pattern of model.tierPatterns) {
      lookups.push({ pattern: pattern.toLowerCase(), contextWindow: model.contextWindow });
    }
  }

  lookups.sort((a, b) => b.pattern.length - a.pattern.length);
  return lookups;
}
