import { tool } from "@opencode-ai/plugin";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_TIER = null;
const BEDROCK_MODEL_BY_TIER = {
  opus: "us.anthropic.claude-opus-4-6-v1",
  sonnet: "us.anthropic.claude-sonnet-4-6",
  haiku: "us.anthropic.claude-haiku-4-5-20251001-v1:0"
};
const OPENAI_MODEL_BY_TIER = {
  opus: "gpt-5.3-codex",
  sonnet: "gpt-5.2-codex",
  haiku: "gpt-5.2-codex"
};
const ANTHROPIC_MODEL_BY_TIER = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5"
};
const BEDROCK_AVAILABLE_MODELS = [
  "us.anthropic.claude-opus-4-6-v1",
  "us.anthropic.claude-sonnet-4-6",
  "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  "moonshotai.kimi-k2.5",
  "moonshot.kimi-k2-thinking"
];
const OPENAI_AVAILABLE_MODELS = [
  "gpt-5.3-codex",
  "gpt-5.2-codex"
];
const ANTHROPIC_AVAILABLE_MODELS = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5"
];
const DEFAULT_PROVIDER_CHAIN = ["amazon-bedrock", "openai"];
const KNOWN_PROVIDER_IDS = ["amazon-bedrock", "openai", "anthropic"];
const KNOWN_TIERS = ["opus", "sonnet", "haiku"];
const DEFAULT_MODEL_BY_PROVIDER_AND_TIER = {
  "amazon-bedrock": BEDROCK_MODEL_BY_TIER,
  openai: OPENAI_MODEL_BY_TIER,
  anthropic: ANTHROPIC_MODEL_BY_TIER
};
const AVAILABLE_MODEL_IDS_BY_PROVIDER = {
  "amazon-bedrock": BEDROCK_AVAILABLE_MODELS,
  openai: OPENAI_AVAILABLE_MODELS,
  anthropic: ANTHROPIC_AVAILABLE_MODELS
};

const pendingBySession = new Map();
const attemptedTargetsBySession = new Map();
const lastFailoverMsBySession = new Map();
const lastRetryStatusBySession = new Map();
const lastTriggerBySession = new Map();
const lastAssistantStatsBySession = new Map();
const lastTransitionBySession = new Map();
const infoShownBySession = new Set();
const debugToastsShownBySession = new Map();
const stallWatchdogBySession = new Map();
let lastGlobalFailoverAt = 0;
let lastGlobalFailoverSession = null;

function cloneProviderTierMatrix(matrix) {
  const clone = {};
  for (const providerID of Object.keys(matrix ?? {})) {
    clone[providerID] = { ...(matrix[providerID] ?? {}) };
  }
  return clone;
}

const runtimeSettings = {
  debugToasts: true,
  providerChain: [...DEFAULT_PROVIDER_CHAIN],
  modelByProviderAndTier: cloneProviderTierMatrix(DEFAULT_MODEL_BY_PROVIDER_AND_TIER),
  stallWatchdogMs: 45 * 1000,
  stallWatchdogEnabled: false,
  globalCooldownMs: 60 * 1000,
  minRetryBackoffMs: 30 * 60 * 1000
};

const SYSTEM_PROMPT_PREFIX = "[opencode-quota-failover]";

const DEBUG_TOASTS_PER_SESSION = 5;
const SETTINGS_FILE_NAME = "settings.json";
const FAILOVER_COMMAND_PREFIXES = [
  "/failover-now",
  "/failover-status",
  "/failover-providers",
  "/failover-models",
  "/failover-set-model",
  "/failover-debug"
];

function settingsPathForRuntime() {
  const override = process.env.OPENCODE_FAILOVER_SETTINGS_PATH?.trim();
  if (override) {
    return override;
  }
  return join(homedir(), ".config", "opencode", "plugins", "opencode-quota-failover", SETTINGS_FILE_NAME);
}

function resetRuntimeSettings() {
  runtimeSettings.debugToasts = true;
  runtimeSettings.providerChain = [...DEFAULT_PROVIDER_CHAIN];
  runtimeSettings.modelByProviderAndTier = cloneProviderTierMatrix(DEFAULT_MODEL_BY_PROVIDER_AND_TIER);
  runtimeSettings.stallWatchdogMs = 45 * 1000;
  runtimeSettings.stallWatchdogEnabled = false;
  runtimeSettings.globalCooldownMs = 60 * 1000;
  runtimeSettings.minRetryBackoffMs = 30 * 60 * 1000;
  lastGlobalFailoverAt = 0;
  lastGlobalFailoverSession = null;
}

async function loadRuntimeSettings(path) {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    const providerChain = normalizeProviderList(parsed?.providerChain);
    if (providerChain.length > 0) {
      runtimeSettings.providerChain = providerChain;
    }

    if (parsed?.modelByProviderAndTier && typeof parsed.modelByProviderAndTier === "object") {
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

    if (typeof parsed?.debugToasts === "boolean") {
      runtimeSettings.debugToasts = parsed.debugToasts;
    }

    if (Number.isFinite(parsed?.stallWatchdogMs)) {
      runtimeSettings.stallWatchdogMs = Math.max(1000, Math.round(parsed.stallWatchdogMs));
    }

    if (typeof parsed?.stallWatchdogEnabled === "boolean") {
      runtimeSettings.stallWatchdogEnabled = parsed.stallWatchdogEnabled;
    }

    if (Number.isFinite(parsed?.globalCooldownMs)) {
      runtimeSettings.globalCooldownMs = Math.max(0, Math.round(parsed.globalCooldownMs));
    }

    if (Number.isFinite(parsed?.minRetryBackoffMs)) {
      runtimeSettings.minRetryBackoffMs = Math.max(0, Math.round(parsed.minRetryBackoffMs));
    }
  } catch {}
}

async function saveRuntimeSettings(path) {
  const payload = {
    providerChain: runtimeSettings.providerChain,
    modelByProviderAndTier: runtimeSettings.modelByProviderAndTier,
    debugToasts: runtimeSettings.debugToasts,
    stallWatchdogMs: runtimeSettings.stallWatchdogMs,
    stallWatchdogEnabled: runtimeSettings.stallWatchdogEnabled,
    globalCooldownMs: runtimeSettings.globalCooldownMs,
    minRetryBackoffMs: runtimeSettings.minRetryBackoffMs,
    updatedAt: new Date().toISOString()
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(payload, null, 2));
}

function modelKey(model) {
  return `${model.providerID}/${model.modelID}`;
}

function formatModel(model) {
  if (!model?.providerID || !model?.modelID) {
    return "unknown/unknown";
  }
  return `${model.providerID}/${model.modelID}`;
}

function normalizeProviderList(providers) {
  const deduped = [];
  for (const provider of providers ?? []) {
    if (!KNOWN_PROVIDER_IDS.includes(provider)) {
      continue;
    }
    if (deduped.includes(provider)) {
      continue;
    }
    deduped.push(provider);
  }
  return deduped;
}

function providerChainSummary() {
  return runtimeSettings.providerChain.join(" -> ");
}

function availableModelsForProvider(providerID) {
  return AVAILABLE_MODEL_IDS_BY_PROVIDER[providerID] ?? [];
}

function canonicalModelID(providerID, modelID) {
  const normalized = modelID?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const available = availableModelsForProvider(providerID);
  return available.find((candidate) => candidate.toLowerCase() === normalized) ?? null;
}

function getModelForProviderTier(providerID, tier) {
  if (!tier) {
    return null;
  }
  const providerModels = runtimeSettings.modelByProviderAndTier[providerID]
    ?? DEFAULT_MODEL_BY_PROVIDER_AND_TIER[providerID];
  if (!providerModels) {
    return null;
  }
  return providerModels[tier] ?? null;
}

function providerTierSummary(providerID) {
  return KNOWN_TIERS
    .map((tier) => `${tier}: ${providerID}/${getModelForProviderTier(providerID, tier) ?? "n/a"}`)
    .join("\n");
}

function buildModelCatalogReport(providerID) {
  const providers = providerID ? [providerID] : KNOWN_PROVIDER_IDS;
  const lines = ["Failover Model Catalog"];

  for (const id of providers) {
    lines.push(`Provider: ${id}`);
    lines.push("Available models:");
    for (const modelID of availableModelsForProvider(id)) {
      lines.push(`- ${modelID}`);
    }
    lines.push("Active tier mapping:");
    lines.push(providerTierSummary(id));
  }

  lines.push("");
  lines.push("Tip: use failover_set_model to choose a provider/tier target model.");
  return lines.join("\n");
}

function fallbackSummaryByTier() {
  return KNOWN_TIERS
    .map((tier) => {
      const chain = buildFallbackChain(tier).map(formatModel).join(" -> ") || "(none)";
      return `${tier}: ${chain}`;
    })
    .join("\n");
}

function collectErrorDetails(error) {
  const texts = [];
  let statusCode;

  const add = (value) => {
    if (typeof value === "string" && value.trim().length > 0) {
      texts.push(value.toLowerCase());
    }
  };

  if (!error) {
    return { text: "", statusCode };
  }

  if (typeof error === "string") {
    add(error);
    return { text: texts.join(" "), statusCode };
  }

  add(error.message);
  add(error.description);
  add(error.reason);
  add(error.details);

  if (error.data && typeof error.data === "object") {
    add(error.data.message);
    add(error.data.responseBody);
    add(error.data.error);
    if (typeof error.data.statusCode === "number") {
      statusCode = error.data.statusCode;
    }
  }

  if (error.error && typeof error.error === "object") {
    add(error.error.message);
    if (error.error.data && typeof error.error.data === "object") {
      add(error.error.data.message);
      add(error.error.data.responseBody);
    }
  }

  try {
    add(JSON.stringify(error));
  } catch {}

  return { text: texts.join(" "), statusCode };
}

function isUsageLimitError(error) {
  const { text, statusCode } = collectErrorDetails(error);
  if (!text) {
    return false;
  }

  const tokenLimitSignals = [
    "context length",
    "context window",
    "token limit",
    "too many tokens",
    "prompt is too long",
    "max_tokens",
    "context_length_exceeded"
  ];
  if (tokenLimitSignals.some((signal) => text.includes(signal))) {
    return false;
  }

  const hardQuotaPatterns = [
    /insufficient[_\s-]?quota/,
    /quota[_\s-]?exceeded/,
    /exceeded.*quota/,
    /billing[_\s-]?hard[_\s-]?limit/,
    /out of credits?/,
    /insufficient credits?/,
    /credit balance.*(?:zero|depleted|empty|negative)/,
    /servicequotaexceeded/,
    /you.*have.*(reached|exceeded).*(limit|quota)/,
    /monthly usage limit/,
    /daily usage limit/,
    /subscription.*limit.*(?:reached|exceeded)/,
    /plan.*limit.*(?:reached|exceeded)/,
    /usage limit (?:reached|exceeded|hit)/
  ];
  if (hardQuotaPatterns.some((pattern) => pattern.test(text))) {
    return true;
  }

  if (/(would exceed your account'?s rate limit|account'?s rate limit)/.test(text)) {
    return true;
  }

  if (statusCode === 402) {
    const billingWords = /(payment|billing|quota|credit|subscription|plan)/;
    if (billingWords.test(text)) {
      return true;
    }
  }

  const retryBackoffMs = parseRetryBackoffMs(text);
  const hasAccountQuotaWords = /(account|quota|subscription|billing|plan limit|usage limit)/.test(text);
  if (retryBackoffMs >= 30 * 60 * 1000 && hasAccountQuotaWords) {
    return true;
  }

  return false;
}

function isBedrockOpusModel(model) {
  const providerID = model?.providerID;
  const modelID = model?.modelID?.toLowerCase() ?? "";
  return providerID === "amazon-bedrock" && modelID.includes("claude-opus-4-6");
}

function isThinkingBlockMutationError(error) {
  const { text } = collectErrorDetails(error);
  if (!text) {
    return false;
  }

  const signals = [
    "the model returned the following errors",
    "thinking` or `redacted_thinking` blocks",
    "blocks in the latest assistant message cannot be modified",
    "must remain as they were in the original response"
  ];

  let hits = 0;
  for (const signal of signals) {
    if (text.includes(signal)) {
      hits += 1;
    }
  }

  return hits >= 2;
}

function shouldTriggerFailover(error, failedModel) {
  if (isUsageLimitError(error)) {
    return true;
  }

  return isBedrockOpusModel(failedModel) && isThinkingBlockMutationError(error);
}

function parseRetryBackoffMs(text) {
  if (typeof text !== "string" || text.length === 0) {
    return 0;
  }

  const marker = text.match(/(?:retry(?:ing)?|try again)\s+in\s+([^\]\n\.;,]+)/i);
  if (!marker?.[1]) {
    return 0;
  }

  const segment = marker[1];
  let totalMs = 0;
  const unitMatches = segment.matchAll(/(\d+)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\b/gi);
  for (const match of unitMatches) {
    const amount = Number.parseInt(match[1] ?? "0", 10);
    const unit = (match[2] ?? "").toLowerCase();
    if (!Number.isFinite(amount) || amount <= 0) {
      continue;
    }
    if (unit.startsWith("h")) {
      totalMs += amount * 60 * 60 * 1000;
      continue;
    }
    if (unit.startsWith("m")) {
      totalMs += amount * 60 * 1000;
      continue;
    }
    if (unit.startsWith("s")) {
      totalMs += amount * 1000;
    }
  }

  return totalMs;
}

function convertPartToInput(part) {
  if (!part || typeof part !== "object") {
    return null;
  }

  if (part.type === "text") {
    return {
      type: "text",
      text: part.text ?? "",
      synthetic: part.synthetic,
      ignored: part.ignored,
      metadata: part.metadata
    };
  }

  if (part.type === "file") {
    return {
      type: "file",
      mime: part.mime,
      filename: part.filename,
      url: part.url,
      source: part.source
    };
  }

  if (part.type === "agent") {
    return {
      type: "agent",
      name: part.name,
      source: part.source
    };
  }

  if (part.type === "subtask") {
    return {
      type: "subtask",
      prompt: part.prompt,
      description: part.description,
      agent: part.agent
    };
  }

  return null;
}

function getAttemptedTargets(sessionID, userMessageID) {
  let sessionMap = attemptedTargetsBySession.get(sessionID);
  if (!sessionMap) {
    sessionMap = new Map();
    attemptedTargetsBySession.set(sessionID, sessionMap);
  }

  let attemptedSet = sessionMap.get(userMessageID);
  if (!attemptedSet) {
    attemptedSet = new Set();
    sessionMap.set(userMessageID, attemptedSet);
  }

  return attemptedSet;
}

function inferTierFromModel(model) {
  const modelID = model?.modelID?.toLowerCase() ?? "";
  if (!modelID) {
    return null;
  }

  if (
    modelID.includes("claude-opus-4-6")
    || modelID.includes("claude-opus")
    || modelID.includes("gpt-5.3")
    || modelID.includes("gpt-5.3-codex")
    || modelID.includes("gpt-5-codex")
    || modelID.includes("gpt-5.1-codex-max")
  ) {
    return "opus";
  }

  if (
    modelID.includes("claude-sonnet-4-6")
    || modelID.includes("claude-sonnet")
    || modelID.includes("gpt-5.2-codex")
    || modelID.includes("gpt-5.3-codex-spark")
    || modelID.includes("gpt-5.1-codex")
    || modelID.includes("gpt-5.1")
    || modelID.includes("kimi-k2.5")
    || modelID.includes("kimi")
  ) {
    return "sonnet";
  }

  if (
    modelID.includes("claude-haiku-4-5")
    || modelID.includes("claude-haiku")
    || modelID.includes("codex-mini")
  ) {
    return "haiku";
  }

  return null;
}

function buildFallbackChain(modelTierHint) {
  const tier = modelTierHint ?? DEFAULT_TIER;
  if (!tier) {
    return [];
  }

  const chain = [];
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

function pickFallback(failedModel, attemptedSet, modelTierHint) {
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
    return candidate;
  }

  return null;
}

function isWithinGlobalCooldown(sessionID) {
  const cooldownMs = runtimeSettings.globalCooldownMs;
  if (!cooldownMs || cooldownMs <= 0) {
    return false;
  }
  if (sessionID && sessionID === lastGlobalFailoverSession) {
    return false;
  }
  return (Date.now() - lastGlobalFailoverAt) < cooldownMs;
}

function queueFailover(sessionID, pending) {
  const existing = pendingBySession.get(sessionID) ?? {};
  pendingBySession.set(sessionID, {
    queuedAt: Date.now(),
    ...existing,
    ...pending
  });
}

function clearStallWatchdog(sessionID) {
  const existing = stallWatchdogBySession.get(sessionID);
  if (existing?.timer) {
    clearTimeout(existing.timer);
  }
  stallWatchdogBySession.delete(sessionID);
}

function resolveEventSessionID(event) {
  const props = event?.properties ?? {};
  return (
    props.sessionID
    ?? props.info?.sessionID
    ?? props.message?.sessionID
    ?? props.message?.info?.sessionID
    ?? props.part?.sessionID
    ?? props.part?.message?.sessionID
    ?? null
  );
}

async function handleStallWatchdogTimeout(ctx, sessionID, target, tierHint, startedAt) {
  const current = stallWatchdogBySession.get(sessionID);
  if (!current || modelKey(current.target) !== modelKey(target) || current.startedAt !== startedAt) {
    return;
  }
  stallWatchdogBySession.delete(sessionID);

  const elapsedMs = Math.max(0, Date.now() - startedAt);
  await showDebugTriggerToast(
    ctx,
    sessionID,
    "watchdog.stall_timeout",
    `${formatModel(target)} after ${elapsedMs}ms`
  );

  queueFailover(sessionID, {
    modelTierHint: tierHint,
    failedModel: target
  });

  await ctx.client.session.abort({
    path: { id: sessionID },
    query: { directory: ctx.directory }
  }).catch(() => {});

  await processFailover(ctx, sessionID);
}

function armStallWatchdog(ctx, sessionID, target, tierHint) {
  if (!runtimeSettings.stallWatchdogEnabled) {
    return;
  }

  clearStallWatchdog(sessionID);

  const startedAt = Date.now();
  const timeoutMs = Math.max(1000, Number(runtimeSettings.stallWatchdogMs) || 45 * 1000);
  const timer = setTimeout(
    () => handleStallWatchdogTimeout(ctx, sessionID, target, tierHint, startedAt).catch(() => {}),
    timeoutMs
  );
  timer.unref?.();

  stallWatchdogBySession.set(sessionID, {
    target,
    tierHint,
    startedAt,
    timeoutMs,
    timer
  });
}

function cleanupSession(sessionID) {
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
}

function consumeDebugToastBudget(sessionID) {
  const shown = debugToastsShownBySession.get(sessionID) ?? 0;
  if (shown >= DEBUG_TOASTS_PER_SESSION) {
    return false;
  }
  debugToastsShownBySession.set(sessionID, shown + 1);
  return true;
}

function summarizeText(value, max = 90) {
  if (typeof value !== "string") {
    return "";
  }
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= max) {
    return compact;
  }
  return `${compact.slice(0, max - 1)}…`;
}

function firstTextPart(message) {
  if (!message || !Array.isArray(message.parts)) {
    return "";
  }
  const part = message.parts.find((entry) => entry?.type === "text" && typeof entry.text === "string");
  return part?.text ?? "";
}

function isFailoverCommandMessage(message) {
  const text = firstTextPart(message).trim().toLowerCase();
  return FAILOVER_COMMAND_PREFIXES.some((prefix) => text.startsWith(prefix));
}

function pickReplayUserMessage(messages) {
  const ordered = [...(messages ?? [])].reverse();
  const nonCommandUser = ordered.find(
    (message) => message.info?.role === "user" && !isFailoverCommandMessage(message)
  );
  if (nonCommandUser) {
    return nonCommandUser;
  }
  return ordered.find((message) => message.info?.role === "user") ?? null;
}

function recordTrigger(sessionID, source, note) {
  if (!sessionID) {
    return;
  }
  lastTriggerBySession.set(sessionID, {
    source,
    note: summarizeText(note, 160),
    at: Date.now()
  });
}

function safeNumber(value) {
  return Number.isFinite(value) ? value : undefined;
}

function formatCount(value) {
  if (!Number.isFinite(value)) {
    return "unknown";
  }
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.round(value)));
}

function formatMs(value) {
  if (!Number.isFinite(value)) {
    return "unknown";
  }

  const ms = Math.max(0, Math.round(value));
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remMin = minutes % 60;
    return `${hours}h ${remMin}m`;
  }
  if (minutes > 0) {
    const remSec = seconds % 60;
    return `${minutes}m ${remSec}s`;
  }
  return `${seconds}s`;
}

function estimateModelContextLimit(modelID) {
  const id = (modelID ?? "").toLowerCase();
  if (!id) {
    return undefined;
  }

  if (
    id.includes("gpt-5.3")
    || id.includes("gpt-5.2")
    || id.includes("gpt-5.1-codex-max")
  ) {
    return 272000;
  }

  if (
    id.includes("claude-opus-4-6")
    || id.includes("claude-sonnet-4-6")
    || id.includes("claude-haiku-4-5")
  ) {
    return 200000;
  }

  return undefined;
}

async function showDebugTriggerToast(ctx, sessionID, source, note) {
  recordTrigger(sessionID, source, note);

  if (!runtimeSettings.debugToasts || !sessionID || !consumeDebugToastBudget(sessionID)) {
    return;
  }

  const noteText = summarizeText(note);
  const suffix = noteText ? ` · ${noteText}` : "";

  await ctx.client.tui.showToast({
    body: {
      title: "Failover Debug",
      message: `Trigger: ${source}${suffix}`,
      variant: "info",
      duration: 2600
    }
  }).catch(() => {});
}

async function processFailover(ctx, sessionID) {
  const pending = pendingBySession.get(sessionID);
  if (!pending) {
    return;
  }

  clearStallWatchdog(sessionID);
  pendingBySession.delete(sessionID);

  const messagesResp = await ctx.client.session.messages({
    path: { id: sessionID },
    query: { directory: ctx.directory }
  });

  const messages = messagesResp.data ?? [];
  const lastUserMessage = [...messages].reverse().find((message) => message.info?.role === "user");
  if (!lastUserMessage) {
    return;
  }

  const failedAssistant = [...messages].reverse().find((message) => message.info?.role === "assistant" && message.info?.error);
  const failedModel = pending.failedModel ?? (
    failedAssistant?.info?.providerID && failedAssistant?.info?.modelID
      ? { providerID: failedAssistant.info.providerID, modelID: failedAssistant.info.modelID }
      : null
  );

  const userMessageID = lastUserMessage.info.id;
  const userModel = lastUserMessage.info?.model;
  const tierHint = pending.modelTierHint
    ?? inferTierFromModel(failedModel)
    ?? inferTierFromModel(userModel);
  if (!tierHint) {
    await ctx.client.tui.showToast({
      body: {
        title: "Model Failover",
        message: "Skipped automatic failover: unable to infer model tier from the failed run.",
        variant: "warning",
        duration: 5000
      }
    }).catch(() => {});
    return;
  }
  const attemptedSet = getAttemptedTargets(sessionID, userMessageID);
  const target = pickFallback(failedModel, attemptedSet, tierHint);

  if (!target) {
    await ctx.client.tui.showToast({
      body: {
        title: "Model Failover",
        message: "No additional fallback model available.",
        variant: "error",
        duration: 4500
      }
    }).catch(() => {});
    return;
  }

  const retryParts = (lastUserMessage.parts ?? []).map(convertPartToInput).filter(Boolean);
  const safeParts = retryParts.length > 0 ? retryParts : [{ type: "text", text: "continue" }];

  const targetKey = modelKey(target);
  attemptedSet.add(targetKey);

  await showDebugTriggerToast(
    ctx,
    sessionID,
    "failover.dispatch",
    `${target.providerID}/${target.modelID}`
  );

  await ctx.client.tui.showToast({
    body: {
      title: "Model Failover",
      message: buildFailoverToastMessage({
        sessionID,
        fromModel: failedModel ?? userModel,
        toModel: target,
        tierHint,
        queuedAt: pending.queuedAt
      }),
      variant: "warning",
      duration: 7000
    }
  }).catch(() => {});

  try {
    await ctx.client.session.prompt({
      path: { id: sessionID },
      query: { directory: ctx.directory },
      body: {
        parts: safeParts,
        agent: lastUserMessage.info.agent,
        system: lastUserMessage.info.system,
        tools: lastUserMessage.info.tools,
        model: target
      }
    });
    lastGlobalFailoverAt = Date.now();
    lastGlobalFailoverSession = sessionID;
  } catch {
    attemptedSet.delete(targetKey);
    queueFailover(sessionID, pending);
    return;
  }

  if (typeof pending.queuedAt === "number") {
    lastFailoverMsBySession.set(sessionID, Math.max(0, Date.now() - pending.queuedAt));
  }
  lastTransitionBySession.set(sessionID, {
    from: failedModel ?? userModel ?? null,
    to: target,
    tierHint,
    at: Date.now()
  });
  armStallWatchdog(ctx, sessionID, target, tierHint);
}

async function runManualFailover(ctx, { sessionID, providerID, modelID, tier }) {
  const startedAt = Date.now();
  clearStallWatchdog(sessionID);
  const messagesResp = await ctx.client.session.messages({
    path: { id: sessionID },
    query: { directory: ctx.directory }
  });
  const messages = messagesResp.data ?? [];
  const replayUserMessage = pickReplayUserMessage(messages);
  if (!replayUserMessage) {
    return "Unable to run failover-now: no user message found to replay.";
  }

  const assistantWithModel = [...messages]
    .reverse()
    .find((message) => message.info?.role === "assistant" && message.info?.providerID && message.info?.modelID);
  const currentModel = replayUserMessage.info?.model ?? (
    assistantWithModel
      ? { providerID: assistantWithModel.info.providerID, modelID: assistantWithModel.info.modelID }
      : null
  );

  const tierHint = tier
    ?? inferTierFromModel(providerID && modelID ? { providerID, modelID } : null)
    ?? inferTierFromModel(currentModel);
  const attemptedSet = getAttemptedTargets(sessionID, replayUserMessage.info.id);

  let target;
  if (providerID && modelID) {
    const canonical = canonicalModelID(providerID, modelID);
    if (!canonical) {
      return [
        `Unknown model for provider ${providerID}: ${modelID}`,
        "Available models:",
        ...availableModelsForProvider(providerID).map((id) => `- ${id}`)
      ].join("\n");
    }
    target = { providerID, modelID: canonical };
  } else if (providerID) {
    if (!tierHint) {
      return "Unable to infer tier for provider-targeted failover. Provide `tier` explicitly.";
    }
    const mapped = getModelForProviderTier(providerID, tierHint);
    if (!mapped) {
      return `No configured model mapping for provider ${providerID} at tier ${tierHint}.`;
    }
    target = { providerID, modelID: mapped };
  } else {
    if (!tierHint) {
      return "Unable to infer tier from current model. Provide `tier` or explicit provider/model.";
    }
    target = pickFallback(currentModel, attemptedSet, tierHint);
  }

  if (!target) {
    return "No additional fallback model available for failover-now.";
  }

  if (currentModel && modelKey(target) === modelKey(currentModel)) {
    return `Already on target model ${formatModel(target)}.`;
  }

  const retryParts = (replayUserMessage.parts ?? []).map(convertPartToInput).filter(Boolean);
  const safeParts = retryParts.length > 0
    ? retryParts
    : [{ type: "text", text: "Continue from the latest unfinished task." }];

  const targetKey = modelKey(target);
  attemptedSet.add(targetKey);
  recordTrigger(sessionID, "manual.failover_now", `${formatModel(currentModel)} -> ${formatModel(target)}`);

  try {
    await ctx.client.session.prompt({
      path: { id: sessionID },
      query: { directory: ctx.directory },
      body: {
        parts: safeParts,
        agent: replayUserMessage.info.agent,
        system: replayUserMessage.info.system,
        tools: replayUserMessage.info.tools,
        model: target
      }
    });
  } catch {
    attemptedSet.delete(targetKey);
    return "Failed to dispatch failover-now prompt. Target model was not switched.";
  }

  const elapsedMs = Math.max(0, Date.now() - startedAt);
  lastFailoverMsBySession.set(sessionID, elapsedMs);
  lastTransitionBySession.set(sessionID, {
    from: currentModel ?? null,
    to: target,
    tierHint,
    at: Date.now()
  });
  armStallWatchdog(ctx, sessionID, target, tierHint);

  return [
    "Failover-now dispatched.",
    `From: ${formatModel(currentModel)}`,
    `To:   ${formatModel(target)}`,
    `Tier: ${tierHint}`,
    `Replay source: ${replayUserMessage.info.id}`,
    `Latency: ${elapsedMs}ms`
  ].join("\n");
}

async function forceFailoverFromRetryStatus(ctx, sessionID) {
  await showDebugTriggerToast(ctx, sessionID, "session.status(retry)", "aborting built-in retry");

  await ctx.client.session.abort({
    path: { id: sessionID },
    query: { directory: ctx.directory }
  }).catch(() => {});

  await processFailover(ctx, sessionID);
}

function buildSystemPromptInfo(currentModel, fallbackChain, lastFailoverMs) {
  const chainText = (fallbackChain
    .map((model, idx) => `${idx + 1}) ${formatModel(model)}`)
    .join(" -> ")) || "(none - tier unknown)";
  const watchdogSeconds = Math.max(1, Math.round((runtimeSettings.stallWatchdogMs ?? 45000) / 1000));
  const timingText = typeof lastFailoverMs === "number"
    ? `Last observed takeover latency in this session: ${lastFailoverMs}ms.`
    : "Takeover timing: runs immediately on retry-status backoff, otherwise triggers once the session reaches idle (usually under a few seconds).";
  const watchdogText = runtimeSettings.stallWatchdogEnabled
    ? `Stall watchdog: auto-reroute if no assistant output within ${watchdogSeconds}s after failover dispatch.`
    : "Stall watchdog: disabled (no auto-reroute on stall).";

  return `${SYSTEM_PROMPT_PREFIX} Current model: ${formatModel(currentModel)}. Failover chain: ${chainText}. ${timingText} ${watchdogText}`;
}

function buildFailoverToastMessage({ sessionID, fromModel, toModel, tierHint, queuedAt }) {
  const chainText = buildFallbackChain(tierHint).map(formatModel).join(" -> ");
  const queuedMs = Number.isFinite(queuedAt) ? Math.max(0, Date.now() - queuedAt) : undefined;
  const takeoverText = Number.isFinite(queuedMs) ? `${queuedMs}ms` : "n/a";
  const trigger = lastTriggerBySession.get(sessionID);
  const triggerText = trigger
    ? `${trigger.source}${trigger.note ? ` (${trigger.note})` : ""}`
    : "unknown";

  return [
    "Failover Active",
    `From: ${formatModel(fromModel)}`,
    `To:   ${formatModel(toModel)}`,
    `Tier: ${tierHint}`,
    `Trigger: ${triggerText}`,
    `Takeover: ${takeoverText}`,
    `Chain: ${chainText}`
  ].join("\n");
}

function buildStatusReport(sessionID) {
  const lines = [];

  lines.push("Quota Failover Status");
  lines.push(`Debug toasts: ${runtimeSettings.debugToasts ? "on" : "off"}`);
  lines.push(`Provider chain: ${providerChainSummary()}`);
  lines.push(`Stall watchdog timeout: ${formatMs(runtimeSettings.stallWatchdogMs)}`);
  lines.push(`Stall watchdog: ${runtimeSettings.stallWatchdogEnabled ? "enabled" : "disabled (default)"}`);
  lines.push(`Global failover cooldown: ${formatMs(runtimeSettings.globalCooldownMs)}`);
  lines.push(`Min retry backoff threshold: ${formatMs(runtimeSettings.minRetryBackoffMs)}`);
  lines.push("Tier mappings:");
  lines.push(fallbackSummaryByTier());

  if (!sessionID) {
    lines.push("Session: none selected");
    lines.push("Quota window note: Claude Max and ChatGPT Pro subscription quota/reset windows are not exposed via plugin APIs.");
    lines.push("Failover uses observed quota/rate-limit errors and retry windows.");
    return lines.join("\n");
  }

  lines.push(`Session: ${sessionID}`);
  lines.push(`Pending failover: ${pendingBySession.has(sessionID) ? "yes" : "no"}`);
  const stall = stallWatchdogBySession.get(sessionID);
  if (stall) {
    lines.push(`Stall watchdog: armed for ${formatModel(stall.target)} (age ${formatMs(Date.now() - stall.startedAt)}, timeout ${formatMs(stall.timeoutMs)})`);
  } else {
    lines.push("Stall watchdog: idle");
  }

  const lastTrigger = lastTriggerBySession.get(sessionID);
  if (lastTrigger) {
    lines.push(`Last trigger: ${lastTrigger.source}${lastTrigger.note ? ` (${lastTrigger.note})` : ""}`);
  } else {
    lines.push("Last trigger: none");
  }

  const retryStatus = lastRetryStatusBySession.get(sessionID);
  if (retryStatus) {
    lines.push(`Last retry backoff: ${formatMs(retryStatus.retryBackoffMs)} (attempt ${retryStatus.attempt ?? "?"})`);
  } else {
    lines.push("Last retry backoff: none seen");
  }

  const failoverMs = lastFailoverMsBySession.get(sessionID);
  lines.push(`Last failover latency: ${typeof failoverMs === "number" ? `${failoverMs}ms` : "n/a"}`);

  const transition = lastTransitionBySession.get(sessionID);
  if (transition) {
    lines.push(`Last transition: ${formatModel(transition.from)} -> ${formatModel(transition.to)} (tier=${transition.tierHint})`);
  } else {
    lines.push("Last transition: none");
  }

  const assistantStats = lastAssistantStatsBySession.get(sessionID);
  if (!assistantStats) {
    lines.push("Context headroom: unknown (no assistant usage snapshot seen yet).");
  } else {
    const currentModel = {
      providerID: assistantStats.providerID,
      modelID: assistantStats.modelID
    };
    const tierHint = inferTierFromModel(currentModel);
    const currentLimit = estimateModelContextLimit(assistantStats.modelID);
    const inputTokens = assistantStats.inputTokens;

    lines.push(`Last model usage: ${formatModel(currentModel)} (input=${formatCount(inputTokens)}, output=${formatCount(assistantStats.outputTokens)}, reasoning=${formatCount(assistantStats.reasoningTokens)})`);

    if (Number.isFinite(inputTokens) && Number.isFinite(currentLimit)) {
      const currentRemaining = Math.max(0, currentLimit - inputTokens);
      const usedPct = Math.min(100, Math.max(0, (inputTokens / currentLimit) * 100));
      lines.push(`Context headroom (current): ${formatCount(currentRemaining)} / ${formatCount(currentLimit)} tokens left (${usedPct.toFixed(1)}% used from last input).`);

      const fallbackCandidate = buildFallbackChain(tierHint).find((candidate) => modelKey(candidate) !== modelKey(currentModel));
      if (fallbackCandidate) {
        const fallbackLimit = estimateModelContextLimit(fallbackCandidate.modelID);
        if (Number.isFinite(fallbackLimit)) {
          const fallbackRemaining = Math.max(0, fallbackLimit - inputTokens);
          lines.push(`Context headroom (first fallback ${formatModel(fallbackCandidate)}): ${formatCount(fallbackRemaining)} / ${formatCount(fallbackLimit)} tokens left (same prompt estimate).`);
        } else {
          lines.push(`Context headroom (first fallback ${formatModel(fallbackCandidate)}): unknown (limit metadata unavailable).`);
        }
      }
    } else {
      lines.push("Context headroom: unknown (provider does not expose enough token/limit metadata for this model snapshot).");
    }
  }

  lines.push("Quota window note: Claude Max and ChatGPT Pro subscription quota/reset windows are not exposed via plugin APIs.");
  lines.push("Failover uses observed quota/rate-limit errors and retry windows.");

  return lines.join("\n");
}

export { isUsageLimitError };

export default async function quotaFailoverPlugin(ctx) {
  resetRuntimeSettings();
  const settingsPath = settingsPathForRuntime();
  await loadRuntimeSettings(settingsPath);

  return {
    tool: {
      failover_set_debug: tool({
        description: "Enable or disable quota-failover debug trigger toasts.",
        args: {
          enabled: tool.schema.boolean().describe("Set true to enable debug toasts, false to disable")
        },
        async execute(args) {
          runtimeSettings.debugToasts = args.enabled;
          await saveRuntimeSettings(settingsPath).catch(() => {});
          return `Failover debug toasts are now ${args.enabled ? "enabled" : "disabled"}.`;
        }
      }),
      failover_set_providers: tool({
        description: "Set ordered providers used for automatic failover.",
        args: {
          providers: tool.schema
            .array(tool.schema.enum(["amazon-bedrock", "openai", "anthropic"]))
            .min(1)
            .describe("Provider order used when failover is triggered")
        },
        async execute(args) {
          const normalized = normalizeProviderList(args.providers);
          if (!normalized.length) {
            return "No valid providers supplied. Allowed: amazon-bedrock, openai, anthropic.";
          }

          runtimeSettings.providerChain = normalized;
          await saveRuntimeSettings(settingsPath).catch(() => {});
          return [
            `Failover provider chain updated: ${providerChainSummary()}`,
            "Tier mappings:",
            fallbackSummaryByTier()
          ].join("\n");
        }
      }),
      failover_list_models: tool({
        description: "List available failover models and active tier mappings.",
        args: {
          provider: tool.schema
            .enum(["amazon-bedrock", "openai", "anthropic"])
            .optional()
            .describe("Optional provider filter")
        },
        async execute(args) {
          return buildModelCatalogReport(args.provider);
        }
      }),
      failover_set_model: tool({
        description: "Set the fallback model for a provider and tier.",
        args: {
          provider: tool.schema
            .enum(["amazon-bedrock", "openai", "anthropic"])
            .describe("Provider whose fallback target should be changed"),
          modelID: tool.schema
            .string()
            .min(1)
            .describe("Model ID from failover_list_models"),
          tier: tool.schema
            .enum(["opus", "sonnet", "haiku"])
            .optional()
            .describe("Optional tier. If omitted, inferred from model ID when possible."),
          allTiers: tool.schema
            .boolean()
            .optional()
            .describe("Set this model for opus, sonnet, and haiku tiers")
        },
        async execute(args) {
          const providerID = args.provider;
          const modelID = canonicalModelID(providerID, args.modelID);
          if (!modelID) {
            return [
              `Unknown model for provider ${providerID}: ${args.modelID}`,
              "Available models:",
              ...availableModelsForProvider(providerID).map((id) => `- ${id}`)
            ].join("\n");
          }

          let tiers;
          if (args.allTiers) {
            tiers = [...KNOWN_TIERS];
          } else if (args.tier) {
            tiers = [args.tier];
          } else {
            const inferred = inferTierFromModel({ providerID, modelID });
            if (!inferred) {
              return "Unable to infer tier from model ID. Provide `tier` or set `allTiers: true`.";
            }
            tiers = [inferred];
          }

          if (!runtimeSettings.modelByProviderAndTier[providerID]) {
            runtimeSettings.modelByProviderAndTier[providerID] = {};
          }

          for (const tier of tiers) {
            runtimeSettings.modelByProviderAndTier[providerID][tier] = modelID;
          }
          await saveRuntimeSettings(settingsPath).catch(() => {});

          const warnings = [];
          if (providerID === "amazon-bedrock" && modelID === "moonshotai.kimi-k2.5") {
            warnings.push("Warning: moonshotai.kimi-k2.5 can have long first-token latency in tool-heavy sessions.");
            warnings.push("Tip: try moonshot.kimi-k2-thinking for faster/stabler interactive tool use.");
          }

          return [
            `Failover model updated for ${providerID}.`,
            `Updated tiers: ${tiers.join(", ")}`,
            providerTierSummary(providerID),
            ...(warnings.length ? ["", ...warnings] : []),
            "",
            "Tier mappings:",
            fallbackSummaryByTier()
          ].join("\n");
        }
      }),
      failover_now: tool({
        description: "Immediately trigger failover to the next configured fallback model.",
        args: {
          sessionID: tool.schema
            .string()
            .optional()
            .describe("Optional session ID. Defaults to the current session where the tool is called."),
          provider: tool.schema
            .enum(["amazon-bedrock", "openai", "anthropic"])
            .optional()
            .describe("Optional provider target. If omitted, use provider chain progression."),
          modelID: tool.schema
            .string()
            .optional()
            .describe("Optional explicit model ID. Requires provider when set."),
          tier: tool.schema
            .enum(["opus", "sonnet", "haiku"])
            .optional()
            .describe("Optional tier hint when provider/model is specified.")
        },
        async execute(args, context) {
          const sessionID = args.sessionID?.trim() || context.sessionID;
          if (!sessionID) {
            return "No session ID available for failover-now.";
          }

          if (args.modelID && !args.provider) {
            return "provider is required when modelID is provided.";
          }

          return runManualFailover(ctx, {
            sessionID,
            providerID: args.provider,
            modelID: args.modelID,
            tier: args.tier
          });
        }
      }),
      failover_status: tool({
        description: "Show quota failover status, provider chain, and session context headroom estimates.",
        args: {
          sessionID: tool.schema
            .string()
            .optional()
            .describe("Optional session ID. Defaults to the current session where the tool is called.")
        },
        async execute(args, context) {
          const sessionID = args.sessionID?.trim() || context.sessionID;
          return buildStatusReport(sessionID);
        }
      })
    },
    "chat.message": async (input, _output) => {
      const sessionID = input.sessionID;
      if (!sessionID || infoShownBySession.has(sessionID)) {
        return;
      }

      const currentModel = input.model ?? null;
      const tierHint = inferTierFromModel(currentModel);
      const fallbackChain = buildFallbackChain(tierHint);
      const lastFailoverMs = lastFailoverMsBySession.get(sessionID);
      const line = buildSystemPromptInfo(currentModel, fallbackChain, lastFailoverMs)
        .replace(`${SYSTEM_PROMPT_PREFIX} `, "");

      await ctx.client.tui.showToast({
        body: {
          title: "Failover Active",
          message: line,
          variant: "info",
          duration: 6500
        }
      }).catch(() => {});

      infoShownBySession.add(sessionID);
    },
    "experimental.chat.system.transform": async (input, output) => {
      const currentModel = {
        providerID: input.model?.providerID,
        modelID: input.model?.id
      };
      const tierHint = inferTierFromModel(currentModel);
      const fallbackChain = buildFallbackChain(tierHint);
      const lastFailoverMs = input.sessionID
        ? lastFailoverMsBySession.get(input.sessionID)
        : undefined;
      const line = buildSystemPromptInfo(currentModel, fallbackChain, lastFailoverMs);

      output.system = (output.system ?? []).filter((entry) => !entry.startsWith(SYSTEM_PROMPT_PREFIX));
      output.system.push(line);
    },
    event: async ({ event }) => {
      try {
        if (event.type === "session.deleted") {
          cleanupSession(event.properties?.info?.id);
          return;
        }

        if (event.type === "message.updated") {
          const info = event.properties?.info;
          if (!info || info.role !== "assistant" || !info.sessionID) {
            return;
          }

          lastAssistantStatsBySession.set(info.sessionID, {
            providerID: info.providerID,
            modelID: info.modelID,
            inputTokens: safeNumber(info.tokens?.input),
            outputTokens: safeNumber(info.tokens?.output),
            reasoningTokens: safeNumber(info.tokens?.reasoning),
            at: Date.now()
          });

          if (info.error || safeNumber(info.tokens?.output) > 0) {
            clearStallWatchdog(info.sessionID);
          }

          const failedModel = {
            providerID: info.providerID,
            modelID: info.modelID
          };
          if (!info.error || !shouldTriggerFailover(info.error, failedModel)) {
            return;
          }

          if (isWithinGlobalCooldown(info.sessionID)) {
            return;
          }
          const forceOpusTier = isBedrockOpusModel(failedModel) && isThinkingBlockMutationError(info.error);
          queueFailover(info.sessionID, {
            modelTierHint: forceOpusTier ? "opus" : inferTierFromModel(failedModel),
            failedModel
          });
          await showDebugTriggerToast(
            ctx,
            info.sessionID,
            "message.updated",
            `${info.providerID}/${info.modelID}`
          );
          return;
        }

        if (event.type === "message.part.delta") {
          const sessionID = resolveEventSessionID(event);
          if (!sessionID) {
            return;
          }
          clearStallWatchdog(sessionID);
          return;
        }

        if (event.type === "session.status") {
          const sessionID = event.properties?.sessionID;
          const status = event.properties?.status;
          if (!sessionID || !status || status.type !== "retry") {
            return;
          }

          lastRetryStatusBySession.set(sessionID, {
            attempt: status.attempt,
            nextAt: status.next,
            message: status.message,
            retryBackoffMs: parseRetryBackoffMs(status.message)
          });

          const retryMessage = status.message;
          const lastAssistant = lastAssistantStatsBySession.get(sessionID);
          const failedModel = (lastAssistant?.providerID && lastAssistant?.modelID)
            ? { providerID: lastAssistant.providerID, modelID: lastAssistant.modelID }
            : null;
          if (!shouldTriggerFailover(retryMessage, failedModel)) {
            return;
          }

          // Only intercept retry if the backoff is long enough to indicate real quota exhaustion
          const retryBackoffMs = parseRetryBackoffMs(retryMessage);
          if (retryBackoffMs < runtimeSettings.minRetryBackoffMs) {
            return;
          }

          // Apply global cooldown to prevent cascade across sessions
          if (isWithinGlobalCooldown(sessionID)) {
            return;
          }

          const forceOpusTier = isBedrockOpusModel(failedModel) && isThinkingBlockMutationError(retryMessage);
          queueFailover(sessionID, forceOpusTier
            ? { modelTierHint: "opus", failedModel }
            : (failedModel ? { failedModel } : {}));
          await forceFailoverFromRetryStatus(ctx, sessionID);
          return;
        }

        if (event.type === "session.error") {
          const sessionID = event.properties?.sessionID;
          const error = event.properties?.error;
          const lastAssistant = sessionID ? lastAssistantStatsBySession.get(sessionID) : null;
          const failedModel = (lastAssistant?.providerID && lastAssistant?.modelID)
            ? { providerID: lastAssistant.providerID, modelID: lastAssistant.modelID }
            : null;
          if (!sessionID || !error || !shouldTriggerFailover(error, failedModel)) {
            return;
          }

          if (isWithinGlobalCooldown(sessionID)) {
            return;
          }
          const forceOpusTier = isBedrockOpusModel(failedModel) && isThinkingBlockMutationError(error);
          queueFailover(sessionID, forceOpusTier
            ? { modelTierHint: "opus", failedModel }
            : (failedModel ? { failedModel } : {}));
          await showDebugTriggerToast(
            ctx,
            sessionID,
            "session.error",
            forceOpusTier ? "bedrock opus thinking/redacted_thinking immutable-block error detected" : "usage/rate limit detected"
          );
          return;
        }

        if (event.type === "session.idle") {
          const sessionID = event.properties?.sessionID;
          if (sessionID) {
            clearStallWatchdog(sessionID);
          }
          if (!sessionID || !pendingBySession.has(sessionID)) {
            return;
          }
          await processFailover(ctx, sessionID);
        }
      } catch (error) {
        console.error("[opencode-quota-failover] failed:", error);
      }
    }
  };
}
