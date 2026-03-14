# OpenCode Quota Failover Plugin

This is an **OpenCode CLI** plugin (`@opencode-ai/plugin` SDK). It is NOT for Claude Code, Cursor, or any other tool.

## Verifying Provider Auth & Models

```bash
# Check which providers are authenticated
opencode auth list

# List available models for a provider
opencode models openai
opencode models amazon-bedrock
opencode models anthropic
```

Only models returned by `opencode models <provider>` are valid dispatch targets. If a model ID is not in that list, failover dispatch will fail silently.

## Architecture (15-module TypeScript)

The plugin is split into 15 focused modules under `src/`. The root `index.js` is a 9-line re-export bridge compiled from `src/index.ts`.

| Module | Purpose |
|--------|---------|
| `src/catalog.ts` | Single source of truth for all model definitions. Add new models here. |
| `src/catalog-lookups.ts` | Data-driven queries derived from the catalog: available models, tier maps, context windows |
| `src/types.ts` | Shared TypeScript types (KnownProviderID, KnownTier, RuntimeSettings, etc.) |
| `src/constants.ts` | Plugin-wide constants: provider IDs, tiers, default chain, cooldown/watchdog defaults |
| `src/state.ts` | In-process runtime state: session maps, cooldown timestamps, watchdog handles |
| `src/settings.ts` | Disk persistence for `settings.json`; `loadRuntimeSettings`, `saveRuntimeSettings` |
| `src/models.ts` | Model selection: `inferTierFromModel`, `pickFallback`, `buildFallbackChain`, `estimateModelContextLimit` |
| `src/detection.ts` | Quota signal detection: `isDefinitiveQuotaError`, `isAmbiguousRateLimitSignal`, `isUsageLimitError` |
| `src/failover.ts` | Core failover: `queueFailover`, `processFailover`, replay message to fallback provider |
| `src/handlers.ts` | OpenCode event handlers for `message.updated`, `session.status`, `session.error`, etc. |
| `src/messages.ts` | Message part normalization and user-message extraction for replay |
| `src/reporting.ts` | Toast formatting, `buildStatusReport`, failover event log |
| `src/tools.ts` | MCP tool definitions (`failover_status`, `failover_now`, `failover_set_model`, etc.) |
| `src/watchdog.ts` | Stall watchdog timer: fires failover if session idles too long |
| `src/index.ts` | Plugin entry point: wires handlers and tools, re-exports detection functions |

### Which module to read for a given task

- **Add/change a model**: `src/catalog.ts` only
- **Change tier inference**: `src/catalog.ts` (`tierPatterns` field on each model)
- **Change context window estimate**: `src/catalog.ts` (`contextWindow` field)
- **Change failover trigger conditions**: `src/detection.ts`
- **Change failover dispatch logic**: `src/failover.ts`
- **Add/change an MCP tool**: `src/tools.ts`
- **Change toast or status output**: `src/reporting.ts`
- **Change settings schema**: `src/types.ts` (RuntimeSettings interface) + `src/settings.ts`
- **Change default provider chain**: `src/constants.ts`

## How to Add a New Model

All model data lives in `src/catalog.ts` — add a `ModelDefinition` entry to `MODEL_CATALOG`. Everything else is derived automatically.

### Step 1 — Verify the model exists

```bash
opencode models <provider>
```

Use the exact model ID string from that output.

### Step 2 — Add to MODEL_CATALOG in src/catalog.ts

```typescript
{
  id: 'gpt-5.4',
  provider: 'openai',
  tier: 'opus',
  isDefault: true,
  contextWindow: 1050000,
  tierPatterns: ['gpt-5.4'],
},
```

Key fields:
- `id`: exact model ID as returned by `opencode models <provider>`
- `provider`: `'anthropic'` | `'amazon-bedrock'` | `'openai'`
- `tier`: `'opus'` | `'sonnet'` | `'haiku'`
- `isDefault`: `true` if this should be the default model for this provider+tier
- `contextWindow`: token limit (optional but recommended)
- `tierPatterns`: substrings used by `inferTierFromModel()` to classify this model

**Watch for substring collisions** — longer, more specific patterns must come before shorter ones because the catalog uses longest-pattern-first matching. Put `'gpt-5.3-codex'` before `'gpt-5.3'` if both exist.

### Step 3 — Run tests

```bash
bun test
```

Catalog parity tests in `src/catalog.test.ts` will catch missing fields, duplicate defaults, or broken tier patterns. All 151 tests must pass.

## How to Run Tests

```bash
# Run all tests (both test files)
bun test

# Type-check without running tests
bunx tsc --noEmit
```

Two test files:
- `index.test.js` — end-to-end plugin behavior, failover flow, MCP tools, settings
- `src/catalog.test.ts` — catalog parity: tier coverage, default uniqueness, pattern validity

## Runtime Settings

Persisted at `~/.config/opencode/plugins/opencode-quota-failover/settings.json`. The `modelByProviderAndTier` object there overrides the code defaults at runtime. Users can also change mappings via the `failover_set_model` MCP tool without editing code.

## MCP Tools

| Tool | Purpose |
|------|---------|
| `failover_status` | Current state, chain, context headroom |
| `failover_now` | Manual failover to next/specific provider |
| `failover_set_model` | Change tier mapping at runtime |
| `failover_set_providers` | Reorder the failover chain |
| `failover_list_models` | Show available models and active mappings |
| `failover_set_debug` | Toggle debug toast notifications |
| `failover_add_model` | Register a new model at runtime without code changes |
