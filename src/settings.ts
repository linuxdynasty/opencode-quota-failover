import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { buildDefaultProviderTierMatrix } from './catalog-lookups.js';
import {
  FAILOVER_LOG_FILE_NAME,
  KNOWN_PROVIDER_IDS,
  KNOWN_TIERS,
  SETTINGS_FILE_NAME,
} from './constants.js';
import {
  getCustomModels,
  runtimeSettings,
  setCustomModels,
  cloneProviderTierMatrix,
} from './state.js';
import {
  addModelToProviderCatalog,
  canonicalModelID,
  normalizeCustomModelEntry,
  normalizeProviderList,
  sameCustomModelKey,
} from './models.js';
import { validateCustomPattern } from './detection.js';
import { recordFailoverEvent } from './reporting.js';

const DEFAULT_MODEL_BY_PROVIDER_AND_TIER = buildDefaultProviderTierMatrix();

function normalizeCustomFailoverPatterns(input: unknown): Record<string, string[]> {
  const normalized: Record<string, string[]> = {};
  if (!input || typeof input !== 'object') {
    return normalized;
  }

  for (const providerID of Object.keys(input as Record<string, unknown>)) {
    const candidates = (input as Record<string, unknown>)[providerID];
    if (!Array.isArray(candidates)) {
      continue;
    }

    const valid = [...new Set(
      candidates
        .filter((p: unknown) => typeof p === 'string')
        .map((p: string) => p.trim().toLowerCase())
        .filter((p: string) => {
          const result = validateCustomPattern(p);
          return result.valid;
        }),
    )];

    if (valid.length > 0) {
      normalized[providerID] = valid;
    }
  }

  return normalized;
}

/** settingsPathForRuntime does resolve the settings file path for the current runtime. */
export function settingsPathForRuntime(): string {
  const override = process.env.OPENCODE_FAILOVER_SETTINGS_PATH?.trim();
  if (override) {
    return override;
  }

  return join(
    homedir(),
    '.config',
    'opencode',
    'plugins',
    'opencode-quota-failover',
    SETTINGS_FILE_NAME,
  );
}

/** logPathForRuntime does resolve the failover log file path for the current runtime. */
export function logPathForRuntime(): string {
  const settingsDir = dirname(settingsPathForRuntime());
  return join(settingsDir, FAILOVER_LOG_FILE_NAME);
}

/** logFailoverEvent does append a structured failover event to memory and disk logs. */
export async function logFailoverEvent(
  level: string,
  sessionID: string | null | undefined,
  fields: Record<string, unknown> = {},
): Promise<void> {
  const timestamp = new Date().toISOString();
  const sessionShort = sessionID ? sessionID.slice(0, 16) : 'none';

  const fieldParts = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => {
      const str = String(value);
      return `${key}=${str.includes(' ') ? `"${str}"` : str}`;
    });

  const line = `${timestamp} [${level}] session=${sessionShort} ${fieldParts.join(' ')}`;

  recordFailoverEvent(line);

  try {
    const logPath = logPathForRuntime();
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${line}\n`);
  } catch {}
}

/** loadRuntimeSettings does load persisted settings from disk into mutable runtime state. */
export async function loadRuntimeSettings(path: string): Promise<void> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);

    setCustomModels([]);
    if (Array.isArray(parsed?.customModels)) {
      for (const candidate of parsed.customModels) {
        const normalized = normalizeCustomModelEntry(candidate);
        if (!normalized) {
          continue;
        }

        const existingIndex = getCustomModels().findIndex((entry) =>
          sameCustomModelKey(entry, normalized),
        );
        if (existingIndex >= 0) {
          getCustomModels()[existingIndex] = normalized;
        } else {
          getCustomModels().push(normalized);
        }
      }
    }

    for (const customModel of getCustomModels()) {
      addModelToProviderCatalog(customModel.provider, customModel.modelID);
    }

    const providerChain = normalizeProviderList(parsed?.providerChain);
    if (providerChain.length > 0) {
      runtimeSettings.providerChain = providerChain;
    }

    if (
      parsed?.modelByProviderAndTier
      && typeof parsed.modelByProviderAndTier === 'object'
    ) {
      const merged = cloneProviderTierMatrix(DEFAULT_MODEL_BY_PROVIDER_AND_TIER);
      for (const providerID of KNOWN_PROVIDER_IDS) {
        for (const tier of KNOWN_TIERS) {
          const candidate = parsed.modelByProviderAndTier?.[providerID]?.[tier];
          const canonical = canonicalModelID(providerID, candidate);
          if (canonical) {
            merged[providerID][tier] = canonical;
          }
        }
      }
      runtimeSettings.modelByProviderAndTier = merged;
    }

    if (typeof parsed?.debugToasts === 'boolean') {
      runtimeSettings.debugToasts = parsed.debugToasts;
    }

    if (Number.isFinite(parsed?.stallWatchdogMs)) {
      runtimeSettings.stallWatchdogMs = Math.max(
        1000,
        Math.round(parsed.stallWatchdogMs),
      );
    }

    if (typeof parsed?.stallWatchdogEnabled === 'boolean') {
      runtimeSettings.stallWatchdogEnabled = parsed.stallWatchdogEnabled;
    }

    if (Number.isFinite(parsed?.globalCooldownMs)) {
      runtimeSettings.globalCooldownMs = Math.max(0, Math.round(parsed.globalCooldownMs));
    }

    if (Number.isFinite(parsed?.minRetryBackoffMs)) {
      runtimeSettings.minRetryBackoffMs = Math.max(0, Math.round(parsed.minRetryBackoffMs));
    }

    if (parsed?.customFailoverPatterns && typeof parsed.customFailoverPatterns === 'object') {
      runtimeSettings.customFailoverPatterns = normalizeCustomFailoverPatterns(parsed.customFailoverPatterns);
    }
  } catch {}
}

/** saveRuntimeSettings does persist mutable runtime settings and custom models to disk. */
export async function saveRuntimeSettings(path: string): Promise<void> {
  const payload = {
    providerChain: runtimeSettings.providerChain,
    modelByProviderAndTier: runtimeSettings.modelByProviderAndTier,
    customModels: getCustomModels(),
    debugToasts: runtimeSettings.debugToasts,
    stallWatchdogMs: runtimeSettings.stallWatchdogMs,
    stallWatchdogEnabled: runtimeSettings.stallWatchdogEnabled,
    globalCooldownMs: runtimeSettings.globalCooldownMs,
    minRetryBackoffMs: runtimeSettings.minRetryBackoffMs,
    customFailoverPatterns: normalizeCustomFailoverPatterns(runtimeSettings.customFailoverPatterns),
    updatedAt: new Date().toISOString(),
  };

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(payload, null, 2));
}
