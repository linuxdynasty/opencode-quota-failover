import { describe, expect, test } from 'bun:test';

import { MODEL_CATALOG } from './catalog.js';
import type { KnownProviderID, KnownTier, ProviderTierMatrix } from './types.js';
import {
  availableModelsForProvider,
  buildAvailableModelsByProvider,
  buildDefaultProviderTierMatrix,
  defaultTierMapForProvider,
  estimateContextWindow,
  getModelNotes,
  inferTierFromModelID,
} from './catalog-lookups.js';

const HARD_CODED_AVAILABLE_MODELS: Record<KnownProviderID, readonly string[]> = {
  'amazon-bedrock': [
    'us.anthropic.claude-opus-4-6-v1',
    'us.anthropic.claude-sonnet-4-6',
    'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    'moonshotai.kimi-k2.5',
    'moonshot.kimi-k2-thinking',
  ],
  openai: [
    'gpt-5.4',
    'gpt-5.3-codex',
    'gpt-5.3-codex-spark',
    'gpt-5.2',
    'gpt-5.2-codex',
    'gpt-5.1-codex-max',
    'gpt-5.1-codex',
    'gpt-5.1-codex-mini',
    'gpt-5-codex',
    'codex-mini-latest',
  ],
  anthropic: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
};

const HARD_CODED_DEFAULT_TIER_MAPS: Record<KnownProviderID, Record<KnownTier, string>> = {
  'amazon-bedrock': {
    opus: 'us.anthropic.claude-opus-4-6-v1',
    sonnet: 'us.anthropic.claude-sonnet-4-6',
    haiku: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  },
  openai: {
    opus: 'gpt-5.4',
    sonnet: 'gpt-5.3-codex',
    haiku: 'gpt-5.2-codex',
  },
  anthropic: {
    opus: 'claude-opus-4-6',
    sonnet: 'claude-sonnet-4-6',
    haiku: 'claude-haiku-4-5',
  },
};

const DEFAULT_MODEL_BY_PROVIDER_AND_TIER: ProviderTierMatrix = {
  'amazon-bedrock': {
    opus: 'us.anthropic.claude-opus-4-6-v1',
    sonnet: 'us.anthropic.claude-sonnet-4-6',
    haiku: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  },
  openai: {
    opus: 'gpt-5.4',
    sonnet: 'gpt-5.3-codex',
    haiku: 'gpt-5.2-codex',
  },
  anthropic: {
    opus: 'claude-opus-4-6',
    sonnet: 'claude-sonnet-4-6',
    haiku: 'claude-haiku-4-5',
  },
};

const DIVERGENCES_FROM_INDEX: Record<string, { indexTier: KnownTier; catalogTier: KnownTier }> = {
  'gpt-5.2-codex': { indexTier: 'sonnet', catalogTier: 'haiku' },
  'gpt-5.1-codex-mini': { indexTier: 'sonnet', catalogTier: 'haiku' },
};

function indexInferTierFromModel(modelID: string): KnownTier | null {
  const id = modelID.toLowerCase();

  if (
    id.includes('claude-opus-4-6') ||
    id.includes('claude-opus') ||
    id.includes('gpt-5.4') ||
    id.includes('gpt-5-codex') ||
    id.includes('gpt-5.1-codex-max')
  ) {
    return 'opus';
  }

  if (
    id.includes('claude-sonnet-4-6') ||
    id.includes('claude-sonnet') ||
    id.includes('gpt-5.3-codex') ||
    id.includes('gpt-5.3-codex-spark') ||
    id.includes('gpt-5.2-codex') ||
    id.includes('gpt-5.2') ||
    id.includes('gpt-5.1-codex') ||
    id.includes('gpt-5.1') ||
    id.includes('kimi-k2.5') ||
    id.includes('kimi')
  ) {
    return 'sonnet';
  }

  if (id.includes('claude-haiku-4-5') || id.includes('claude-haiku') || id.includes('codex-mini')) {
    return 'haiku';
  }

  return null;
}

function indexEstimateModelContextLimit(modelID: string): number | undefined {
  const id = modelID.toLowerCase();

  if (id.includes('gpt-5.4')) {
    return 1050000;
  }

  if (id.includes('gpt-5.3') || id.includes('gpt-5.2') || id.includes('gpt-5.1-codex-max')) {
    return 272000;
  }

  if (id.includes('claude-opus-4-6') || id.includes('claude-sonnet-4-6') || id.includes('claude-haiku-4-5')) {
    return 200000;
  }

  return undefined;
}

describe('Model Catalog', () => {
  test('availableModelsForProvider() matches hardcoded arrays for each provider', () => {
    const providers: KnownProviderID[] = ['amazon-bedrock', 'openai', 'anthropic'];

    for (const providerID of providers) {
      expect(availableModelsForProvider(providerID)).toEqual([
        ...HARD_CODED_AVAILABLE_MODELS[providerID],
      ]);
    }
  });

  test('defaultTierMapForProvider() matches hardcoded tier maps for each provider', () => {
    const providers: KnownProviderID[] = ['amazon-bedrock', 'openai', 'anthropic'];

    for (const providerID of providers) {
      expect(defaultTierMapForProvider(providerID)).toEqual(HARD_CODED_DEFAULT_TIER_MAPS[providerID]);
    }
  });

  test('buildDefaultProviderTierMatrix() matches DEFAULT_MODEL_BY_PROVIDER_AND_TIER', () => {
    expect(buildDefaultProviderTierMatrix()).toEqual(DEFAULT_MODEL_BY_PROVIDER_AND_TIER);
  });

  test('inferTierFromModelID() matches index behavior for all known models except documented divergences', () => {
    for (const model of MODEL_CATALOG) {
      const fromCatalogLookup = inferTierFromModelID(model.id);
      const fromIndexLogic = indexInferTierFromModel(model.id);
      const divergence = DIVERGENCES_FROM_INDEX[model.id];

      if (divergence) {
        expect(fromIndexLogic).toBe(divergence.indexTier);
        expect(fromCatalogLookup).toBe(divergence.catalogTier);
        expect(fromCatalogLookup).not.toBe(fromIndexLogic);
        continue;
      }

      expect(fromCatalogLookup).toBe(fromIndexLogic);
    }
  });

  test('estimateContextWindow() matches estimateModelContextLimit() behavior for all known models', () => {
    for (const model of MODEL_CATALOG) {
      expect(estimateContextWindow(model.id)).toBe(indexEstimateModelContextLimit(model.id));
    }
  });

  test('getModelNotes() returns notes from catalog entries', () => {
    for (const model of MODEL_CATALOG) {
      expect(getModelNotes(model.provider, model.id)).toBe(model.notes);
    }
  });

  test('buildAvailableModelsByProvider() returns all provider model lists', () => {
    expect(buildAvailableModelsByProvider()).toEqual(HARD_CODED_AVAILABLE_MODELS);
  });

  test('every catalog model has at least one tierPattern', () => {
    for (const model of MODEL_CATALOG) {
      expect(model.tierPatterns.length).toBeGreaterThanOrEqual(1);
    }
  });

  test('there are no duplicate defaults for any provider+tier', () => {
    const defaultCounts = new Map<string, number>();

    for (const model of MODEL_CATALOG) {
      if (!model.isDefault) {
        continue;
      }

      const key = `${model.provider}:${model.tier}`;
      defaultCounts.set(key, (defaultCounts.get(key) ?? 0) + 1);
    }

    for (const count of defaultCounts.values()) {
      expect(count).toBe(1);
    }
  });

  test('all catalog tierPatterns are lowercase', () => {
    for (const model of MODEL_CATALOG) {
      for (const pattern of model.tierPatterns) {
        expect(pattern).toBe(pattern.toLowerCase());
      }
    }
  });
});
