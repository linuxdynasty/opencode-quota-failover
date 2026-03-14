import type { KnownProviderID, KnownTier } from './types.js';

/** DEFAULT_TIER is the fallback tier used when tier inference is unavailable. */
export const DEFAULT_TIER: KnownTier | null = null;

/** DEFAULT_PROVIDER_CHAIN is the default ordered provider failover chain. */
export const DEFAULT_PROVIDER_CHAIN: KnownProviderID[] = ['amazon-bedrock', 'openai'];

/** KNOWN_PROVIDER_IDS is the canonical list of supported provider identifiers. */
export const KNOWN_PROVIDER_IDS: KnownProviderID[] = ['amazon-bedrock', 'openai', 'anthropic'];

/** KNOWN_TIERS is the canonical list of supported model performance tiers. */
export const KNOWN_TIERS: KnownTier[] = ['opus', 'sonnet', 'haiku'];

/** SYSTEM_PROMPT_PREFIX is the system line prefix injected by this plugin. */
export const SYSTEM_PROMPT_PREFIX = '[opencode-quota-failover]';

/** DEBUG_TOASTS_PER_SESSION is the max debug trigger toasts shown per session. */
export const DEBUG_TOASTS_PER_SESSION = 5;

/** SETTINGS_FILE_NAME is the persisted runtime settings file name. */
export const SETTINGS_FILE_NAME = 'settings.json';

/** FAILOVER_COMMAND_PREFIXES is the set of slash command prefixes ignored for replay. */
export const FAILOVER_COMMAND_PREFIXES = [
  '/failover-now',
  '/failover-status',
  '/failover-providers',
  '/failover-models',
  '/failover-set-model',
  '/failover-debug',
];

/** MAX_CONSECUTIVE_DISPATCH_FAILURES is the provider failure threshold before cooldown applies. */
export const MAX_CONSECUTIVE_DISPATCH_FAILURES = 3;

/** DISPATCH_COOLDOWN_MS is the provider cooldown duration after repeated dispatch failures. */
export const DISPATCH_COOLDOWN_MS = 5 * 60 * 1000;

/** MAX_BOUNCE_COUNT is the maximum allowed failover bounce cycles per session. */
export const MAX_BOUNCE_COUNT = 3;

/** FAILOVER_LOG_MAX_ENTRIES is the in-memory ring buffer size for failover events. */
export const FAILOVER_LOG_MAX_ENTRIES = 100;

/** FAILOVER_LOG_FILE_NAME is the on-disk failover event log file name. */
export const FAILOVER_LOG_FILE_NAME = 'failover.log';
