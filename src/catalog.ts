import type { KnownProviderID, KnownTier } from './types.js';

/** ModelDefinition describes a single model supported by the failover system. */
export interface ModelDefinition {
  /** id is the exact model ID as returned by `opencode models <provider>`. */
  id: string;
  /** provider identifies which AI provider hosts this model. */
  provider: KnownProviderID;
  /** tier classifies the model's performance level for fallback chain construction. */
  tier: KnownTier;
  /** isDefault marks this model as the default for its provider+tier combination. */
  isDefault: boolean;
  /** contextWindow is the token context window size, if known. */
  contextWindow?: number;
  /** tierPatterns lists substring patterns used to infer this model's tier from model IDs. */
  tierPatterns: string[];
  /** notes holds optional caveats or warnings displayed in MCP tool output. */
  notes?: string;
}

/** MODEL_CATALOG defines every model supported by the failover system. Add new models here. */
export const MODEL_CATALOG: readonly ModelDefinition[] = [
  {
    id: 'us.anthropic.claude-opus-4-6-v1',
    provider: 'amazon-bedrock',
    tier: 'opus',
    isDefault: true,
    contextWindow: 200000,
    tierPatterns: ['claude-opus-4-6', 'claude-opus'],
  },
  {
    id: 'us.anthropic.claude-sonnet-4-6',
    provider: 'amazon-bedrock',
    tier: 'sonnet',
    isDefault: true,
    contextWindow: 200000,
    tierPatterns: ['claude-sonnet-4-6', 'claude-sonnet'],
  },
  {
    id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    provider: 'amazon-bedrock',
    tier: 'haiku',
    isDefault: true,
    contextWindow: 200000,
    tierPatterns: ['claude-haiku-4-5', 'claude-haiku'],
  },
  {
    id: 'moonshotai.kimi-k2.5',
    provider: 'amazon-bedrock',
    tier: 'sonnet',
    isDefault: false,
    tierPatterns: ['kimi-k2.5', 'kimi'],
  },
  {
    id: 'moonshot.kimi-k2-thinking',
    provider: 'amazon-bedrock',
    tier: 'sonnet',
    isDefault: false,
    tierPatterns: ['kimi'],
  },
  {
    id: 'gpt-5.4',
    provider: 'openai',
    tier: 'opus',
    isDefault: true,
    contextWindow: 1050000,
    tierPatterns: ['gpt-5.4'],
  },
  {
    id: 'gpt-5.3-codex',
    provider: 'openai',
    tier: 'sonnet',
    isDefault: true,
    contextWindow: 272000,
    tierPatterns: ['gpt-5.3-codex'],
  },
  {
    id: 'gpt-5.3-codex-spark',
    provider: 'openai',
    tier: 'sonnet',
    isDefault: false,
    contextWindow: 272000,
    tierPatterns: ['gpt-5.3-codex-spark', 'gpt-5.3-codex'],
    notes: 'Matches the broader gpt-5.3-codex pattern first in current inference order.',
  },
  {
    id: 'gpt-5.2',
    provider: 'openai',
    tier: 'sonnet',
    isDefault: false,
    contextWindow: 272000,
    tierPatterns: ['gpt-5.2'],
  },
  {
    id: 'gpt-5.2-codex',
    provider: 'openai',
    tier: 'haiku',
    isDefault: true,
    contextWindow: 272000,
    tierPatterns: ['gpt-5.2-codex', 'gpt-5.2'],
  },
  {
    id: 'gpt-5.1-codex-max',
    provider: 'openai',
    tier: 'opus',
    isDefault: false,
    contextWindow: 272000,
    tierPatterns: ['gpt-5.1-codex-max'],
  },
  {
    id: 'gpt-5.1-codex',
    provider: 'openai',
    tier: 'sonnet',
    isDefault: false,
    tierPatterns: ['gpt-5.1-codex', 'gpt-5.1'],
  },
  {
    id: 'gpt-5.1-codex-mini',
    provider: 'openai',
    tier: 'haiku',
    isDefault: false,
    tierPatterns: ['codex-mini', 'gpt-5.1-codex', 'gpt-5.1'],
    notes:
      'Configured as haiku in catalog; current inferTierFromModel ordering may classify it as sonnet due substring overlap.',
  },
  {
    id: 'gpt-5-codex',
    provider: 'openai',
    tier: 'opus',
    isDefault: false,
    tierPatterns: ['gpt-5-codex'],
  },
  {
    id: 'codex-mini-latest',
    provider: 'openai',
    tier: 'haiku',
    isDefault: false,
    tierPatterns: ['codex-mini'],
  },
  {
    id: 'claude-opus-4-6',
    provider: 'anthropic',
    tier: 'opus',
    isDefault: true,
    contextWindow: 200000,
    tierPatterns: ['claude-opus-4-6', 'claude-opus'],
  },
  {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    tier: 'sonnet',
    isDefault: true,
    contextWindow: 200000,
    tierPatterns: ['claude-sonnet-4-6', 'claude-sonnet'],
  },
  {
    id: 'claude-haiku-4-5',
    provider: 'anthropic',
    tier: 'haiku',
    isDefault: true,
    contextWindow: 200000,
    tierPatterns: ['claude-haiku-4-5', 'claude-haiku'],
  },
];
