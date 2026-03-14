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

## Architecture (single file)

All logic lives in `index.js`. Key constants at the top of the file:

| Constant | Purpose |
|---|---|
| `<PROVIDER>_AVAILABLE_MODELS` | Allowlist of model IDs the plugin accepts per provider |
| `<PROVIDER>_MODEL_BY_TIER` | Default tier mapping (opus/sonnet/haiku → model ID) |
| `inferTierFromModel()` | Classifies any model ID into a tier for fallback routing |
| `estimateModelContextLimit()` | Returns token context window size for headroom estimates |

## How to Add a New Model

All changes are in `index.js` (and corresponding test assertions in `index.test.js`).

### Step 1 — Verify the model exists

```bash
opencode models <provider>
```

Use the exact model ID string from that output.

### Step 2 — Add to the available models list

Add the model ID to the appropriate `*_AVAILABLE_MODELS` array (top of `index.js`):

```javascript
const OPENAI_AVAILABLE_MODELS = [
  "gpt-5.4",        // ← add new models here
  "gpt-5.3-codex",
  // ...
];
```

### Step 3 — Set the tier mapping (if it should be a default)

Update the `*_MODEL_BY_TIER` object if this model should be the default for a tier:

```javascript
const OPENAI_MODEL_BY_TIER = {
  opus: "gpt-5.4",       // ← flagship
  sonnet: "gpt-5.3-codex",
  haiku: "gpt-5.2-codex",
};
```

### Step 4 — Update tier inference

In `inferTierFromModel()`, add a `modelID.includes(...)` check so the plugin can classify the model when it appears in error/status messages:

```javascript
// opus tier
if (modelID.includes("gpt-5.4") || ...) { return "opus"; }

// sonnet tier
if (modelID.includes("gpt-5.3-codex") || ...) { return "sonnet"; }

// haiku tier
if (modelID.includes("codex-mini") || ...) { return "haiku"; }
```

**Watch for substring collisions** — `"gpt-5.3"` matches both `gpt-5.3-codex` and `gpt-5.3-codex-spark`. Put more specific patterns first or use the full suffix.

### Step 5 — Update context limit (if known)

In `estimateModelContextLimit()`, add the token limit:

```javascript
if (id.includes("gpt-5.4")) { return 1050000; }
```

### Step 6 — Update tests

In `index.test.js`, update:
- `writeDefaultTestSettings()` (line ~23) — the test baseline tier mapping
- Any assertions that hard-code model IDs in dispatch expectations

### Step 7 — Run tests

```bash
bun test
```

All 110 tests must pass.

## Runtime Settings

Persisted at `~/.config/opencode/plugins/opencode-quota-failover/settings.json`. The `modelByProviderAndTier` object there overrides the code defaults at runtime. Users can also change mappings via the `failover_set_model` MCP tool without editing code.

## MCP Tools

| Tool | Purpose |
|---|---|
| `failover_status` | Current state, chain, context headroom |
| `failover_now` | Manual failover to next/specific provider |
| `failover_set_model` | Change tier mapping at runtime |
| `failover_set_providers` | Reorder the failover chain |
| `failover_list_models` | Show available models and active mappings |
| `failover_set_debug` | Toggle debug toast notifications |
