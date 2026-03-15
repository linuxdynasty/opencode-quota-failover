import { tool } from '@opencode-ai/plugin';
import { availableModelIDsForProvider, addModelToProviderCatalog, buildModelCatalogReport, canonicalModelID, fallbackSummaryByTier, getSelectionWarningNotes, inferTierFromModel, normalizeCustomModelEntry, normalizeProviderList, providerChainSummary, providerTierSummary, sameCustomModelKey } from './models.js';
import { KNOWN_TIERS, MIN_CUSTOM_ERROR_PATTERN_LENGTH } from './constants.js';
import { runtimeSettings, getCustomModels } from './state.js';
import { saveRuntimeSettings } from './settings.js';
import { runManualFailover } from './failover.js';
import { validateCustomPattern } from './detection.js';
import { buildStatusReport } from './reporting.js';

/** createTools does build MCP tool definitions bound to plugin runtime context. */
export function createTools(ctx: any, settingsPath: string) {
  return {
    failover_set_debug: tool({
      description: 'Enable or disable quota-failover debug trigger toasts.',
      args: {
        enabled: tool.schema
          .boolean()
          .describe('Set true to enable debug toasts, false to disable'),
      },
      async execute(args) {
        runtimeSettings.debugToasts = args.enabled;
        await saveRuntimeSettings(settingsPath).catch(() => {});
        return `Failover debug toasts are now ${args.enabled ? 'enabled' : 'disabled'}.`;
      },
    }),
    failover_set_providers: tool({
      description: 'Set ordered providers used for automatic failover.',
      args: {
        providers: tool.schema
          .array(tool.schema.enum(['amazon-bedrock', 'openai', 'anthropic']))
          .min(1)
          .describe('Provider order used when failover is triggered'),
      },
      async execute(args) {
        const normalized = normalizeProviderList(args.providers);
        if (!normalized.length) {
          return 'No valid providers supplied. Allowed: amazon-bedrock, openai, anthropic.';
        }

        runtimeSettings.providerChain = normalized;
        await saveRuntimeSettings(settingsPath).catch(() => {});
        return [
          `Failover provider chain updated: ${providerChainSummary()}`,
          'Tier mappings:',
          fallbackSummaryByTier(),
        ].join('\n');
      },
    }),
    failover_list_models: tool({
      description: 'List available failover models and active tier mappings.',
      args: {
        provider: tool.schema
          .enum(['amazon-bedrock', 'openai', 'anthropic'])
          .optional()
          .describe('Optional provider filter'),
      },
      async execute(args) {
        return buildModelCatalogReport(args.provider);
      },
    }),
    failover_set_model: tool({
      description: 'Set the fallback model for a provider and tier.',
      args: {
        provider: tool.schema
          .enum(['amazon-bedrock', 'openai', 'anthropic'])
          .describe('Provider whose fallback target should be changed'),
        modelID: tool.schema
          .string()
          .min(1)
          .describe('Model ID from failover_list_models'),
        tier: tool.schema
          .enum(['opus', 'sonnet', 'haiku'])
          .optional()
          .describe(
            'Optional tier. If omitted, inferred from model ID when possible.',
          ),
        allTiers: tool.schema
          .boolean()
          .optional()
          .describe('Set this model for opus, sonnet, and haiku tiers'),
      },
      async execute(args) {
        const providerID = args.provider;
        const modelID = canonicalModelID(providerID, args.modelID);
        if (!modelID) {
          return [
            `Unknown model for provider ${providerID}: ${args.modelID}`,
            'Available models:',
            ...availableModelIDsForProvider(providerID).map((id) => `- ${id}`),
          ].join('\n');
        }

        let tiers;
        if (args.allTiers) {
          tiers = [...KNOWN_TIERS];
        } else if (args.tier) {
          tiers = [args.tier];
        } else {
          const inferred = inferTierFromModel({ providerID, modelID });
          if (!inferred) {
            return 'Unable to infer tier from model ID. Provide `tier` or set `allTiers: true`.';
          }
          tiers = [inferred];
        }

        for (const tier of tiers) {
          runtimeSettings.modelByProviderAndTier[providerID][tier] = modelID;
        }
        await saveRuntimeSettings(settingsPath).catch(() => {});

        const warnings: string[] = [];
        const modelNotes = getSelectionWarningNotes(providerID, modelID);
        if (modelNotes) {
          warnings.push(...modelNotes.split('\n').filter(Boolean));
        }

        return [
          `Failover model updated for ${providerID}.`,
          `Updated tiers: ${tiers.join(', ')}`,
          providerTierSummary(providerID),
          ...(warnings.length ? ['', ...warnings] : []),
          '',
          'Tier mappings:',
          fallbackSummaryByTier(),
        ].join('\n');
      },
    }),
    failover_add_model: tool({
      description: 'Register a custom model for use in failover chain.',
      args: {
        provider: tool.schema
          .enum(['amazon-bedrock', 'openai', 'anthropic'])
          .describe('Provider ID'),
        modelID: tool.schema.string().min(1).describe('Model ID string'),
        tier: tool.schema
          .enum(['opus', 'sonnet', 'haiku'])
          .describe('Performance tier'),
        contextWindow: tool.schema
          .number()
          .optional()
          .describe('Token context window size'),
        setDefault: tool.schema
          .boolean()
          .optional()
          .describe('Make this the default for provider+tier'),
      },
      async execute(args) {
        const providerID = args.provider;
        const modelID = args.modelID.trim();
        const tier = args.tier;
        const setDefault = args.setDefault === true;

        const normalized = normalizeCustomModelEntry({
          provider: providerID,
          modelID,
          tier,
          contextWindow: args.contextWindow,
          isDefault: setDefault,
        });

        if (!normalized) {
          return 'Invalid custom model payload. Ensure provider, modelID, and tier are valid.';
        }

        const customModels = getCustomModels();
        const existingIndex = customModels.findIndex((entry) =>
          sameCustomModelKey(entry, normalized),
        );
        if (existingIndex >= 0) {
          customModels[existingIndex] = normalized;
        } else {
          customModels.push(normalized);
        }

        addModelToProviderCatalog(providerID, modelID);

        if (setDefault) {
          runtimeSettings.modelByProviderAndTier[providerID][tier] = modelID;
        }

        await saveRuntimeSettings(settingsPath).catch(() => {});

        const details = [
          `Custom model registered: ${providerID}/${modelID}`,
          `Tier: ${tier}`,
        ];
        if (Number.isFinite(normalized.contextWindow)) {
          details.push(`Context window: ${normalized.contextWindow}`);
        }
        if (setDefault) {
          details.push(
            `Default updated: ${providerID}/${tier} -> ${modelID}`,
          );
        }

        return [
          ...details,
          '',
          'Active tier mapping:',
          providerTierSummary(providerID),
        ].join('\n');
      },
    }),
    failover_now: tool({
      description:
        'Immediately trigger failover to the next configured fallback model.',
      args: {
        sessionID: tool.schema
          .string()
          .optional()
          .describe(
            'Optional session ID. Defaults to the current session where the tool is called.',
          ),
        provider: tool.schema
          .enum(['amazon-bedrock', 'openai', 'anthropic'])
          .optional()
          .describe(
            'Optional provider target. If omitted, use provider chain progression.',
          ),
        modelID: tool.schema
          .string()
          .optional()
          .describe(
            'Optional explicit model ID. Requires provider when set.',
          ),
        tier: tool.schema
          .enum(['opus', 'sonnet', 'haiku'])
          .optional()
          .describe('Optional tier hint when provider/model is specified.'),
      },
      async execute(args, context) {
        const sessionID = args.sessionID?.trim() || context.sessionID;
        if (!sessionID) {
          return 'No session ID available for failover-now.';
        }

        if (args.modelID && !args.provider) {
          return 'provider is required when modelID is provided.';
        }

        return runManualFailover(ctx, {
          sessionID,
          providerID: args.provider,
          modelID: args.modelID,
          tier: args.tier,
        });
      },
    }),
    failover_set_error_patterns: tool({
      description: 'Set custom error message substring patterns that trigger failover for a provider.',
      args: {
        provider: tool.schema
          .enum(['amazon-bedrock', 'openai', 'anthropic'])
          .describe('Provider to configure patterns for'),
        patterns: tool.schema
          .array(tool.schema.string().min(1))
          .min(1)
          .describe(`Substring/wildcard patterns to match in error messages (case-insensitive, min ${MIN_CUSTOM_ERROR_PATTERN_LENGTH} non-wildcard chars)`),
        replace: tool.schema
          .boolean()
          .optional()
          .describe('If true, replace existing patterns. If false (default), append to existing patterns.'),
      },
      async execute(args) {
        const providerID = args.provider;
        const normalized = args.patterns
          .map((p: string) => p.trim().toLowerCase())
          .filter((p: string) => p.length > 0);
        if (normalized.length === 0) {
          return 'No valid patterns provided.';
        }

        const accepted: string[] = [];
        const rejected: string[] = [];
        for (const pattern of normalized) {
          const validation = validateCustomPattern(pattern);
          if (validation.valid) {
            accepted.push(pattern);
          } else {
            rejected.push(`"${pattern}": ${validation.reason}`);
          }
        }

        if (accepted.length === 0) {
          return [
            'All patterns were rejected.',
            ...rejected.map((entry) => `  - ${entry}`),
          ].join('\n');
        }

        const existing = runtimeSettings.customFailoverPatterns[providerID] ?? [];
        const merged = args.replace
          ? [...new Set(accepted)]
          : [...new Set([...existing, ...accepted])];
        runtimeSettings.customFailoverPatterns[providerID] = merged;
        await saveRuntimeSettings(settingsPath).catch(() => {});

        const lines = [
          `Custom failover patterns updated for ${providerID}.`,
          `Active patterns (${merged.length}):`,
          ...merged.map((p: string, i: number) => `  ${i + 1}. "${p}"`),
        ];
        if (rejected.length > 0) {
          lines.push('', `Rejected patterns (${rejected.length}):`, ...rejected.map((entry) => `  - ${entry}`));
        }
        return lines.join('\n');
      },
    }),
    failover_clear_error_patterns: tool({
      description: 'Clear custom error message patterns for a provider, or all providers.',
      args: {
        provider: tool.schema
          .enum(['amazon-bedrock', 'openai', 'anthropic'])
          .optional()
          .describe('Provider to clear. If omitted, clears all providers.'),
      },
      async execute(args) {
        if (args.provider) {
          const hadPatterns = (runtimeSettings.customFailoverPatterns[args.provider] ?? []).length > 0;
          runtimeSettings.customFailoverPatterns[args.provider] = [];
          await saveRuntimeSettings(settingsPath).catch(() => {});
          return hadPatterns
            ? `Custom failover patterns cleared for ${args.provider}.`
            : `No custom failover patterns were set for ${args.provider}.`;
        }
        runtimeSettings.customFailoverPatterns = {};
        await saveRuntimeSettings(settingsPath).catch(() => {});
        return 'All custom failover patterns cleared.';
      },
    }),
    failover_add_error_pattern: tool({
      description: 'Add one custom error pattern for a provider. Supports wildcard * matching.',
      args: {
        provider: tool.schema
          .enum(['amazon-bedrock', 'openai', 'anthropic'])
          .describe('Provider to configure pattern for'),
        pattern: tool.schema
          .string()
          .min(1)
          .describe(`Error substring or wildcard pattern (min ${MIN_CUSTOM_ERROR_PATTERN_LENGTH} non-wildcard chars)`),
      },
      async execute(args) {
        const providerID = args.provider;
        const normalized = args.pattern.trim().toLowerCase();
        const validation = validateCustomPattern(normalized);
        if (!validation.valid) {
          return `Pattern rejected: ${validation.reason}`;
        }

        const existing = runtimeSettings.customFailoverPatterns[providerID] ?? [];
        if (existing.includes(normalized)) {
          return `Pattern already exists for ${providerID}: "${normalized}"`;
        }

        const next = [...existing, normalized];
        runtimeSettings.customFailoverPatterns[providerID] = next;
        await saveRuntimeSettings(settingsPath).catch(() => {});
        return [
          `Custom failover pattern added for ${providerID}.`,
          `Active patterns (${next.length}):`,
          ...next.map((p: string, i: number) => `  ${i + 1}. "${p}"`),
        ].join('\n');
      },
    }),
    failover_remove_error_pattern: tool({
      description: 'Remove one custom error pattern for a provider.',
      args: {
        provider: tool.schema
          .enum(['amazon-bedrock', 'openai', 'anthropic'])
          .describe('Provider to remove pattern from'),
        pattern: tool.schema
          .string()
          .min(1)
          .describe('Pattern string to remove (case-insensitive)'),
      },
      async execute(args) {
        const providerID = args.provider;
        const normalized = args.pattern.trim().toLowerCase();
        const existing = runtimeSettings.customFailoverPatterns[providerID] ?? [];
        const next = existing.filter((pattern: string) => pattern !== normalized);
        if (next.length === existing.length) {
          return `Pattern not found for ${providerID}: "${normalized}"`;
        }

        if (next.length === 0) {
          delete runtimeSettings.customFailoverPatterns[providerID];
        } else {
          runtimeSettings.customFailoverPatterns[providerID] = next;
        }
        await saveRuntimeSettings(settingsPath).catch(() => {});
        return `Pattern removed for ${providerID}: "${normalized}"`;
      },
    }),
    failover_list_error_patterns: tool({
      description: 'List configured custom failover error patterns by provider.',
      args: {
        provider: tool.schema
          .enum(['amazon-bedrock', 'openai', 'anthropic'])
          .optional()
          .describe('Optional provider filter'),
      },
      async execute(args) {
        const providers = args.provider
          ? [args.provider]
          : ['amazon-bedrock', 'openai', 'anthropic'];
        const lines: string[] = [];
        for (const providerID of providers) {
          const patterns = runtimeSettings.customFailoverPatterns[providerID] ?? [];
          if (patterns.length === 0) {
            continue;
          }
          lines.push(`${providerID} (${patterns.length}):`);
          lines.push(...patterns.map((p: string, i: number) => `  ${i + 1}. "${p}"`));
        }

        if (lines.length === 0) {
          return args.provider
            ? `No custom failover error patterns configured for ${args.provider}.`
            : 'No custom failover error patterns configured.';
        }
        return ['Custom failover error patterns:', ...lines].join('\n');
      },
    }),
    failover_status: tool({
      description:
        'Show quota failover status, provider chain, and session context headroom estimates.',
      args: {
        sessionID: tool.schema
          .string()
          .optional()
          .describe(
            'Optional session ID. Defaults to the current session where the tool is called.',
          ),
      },
      async execute(args, context) {
        const sessionID = args.sessionID?.trim() || context.sessionID;
        return buildStatusReport(sessionID, settingsPath);
      },
    }),
  };
}
