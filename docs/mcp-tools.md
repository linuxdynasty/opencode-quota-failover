# MCP Tools Reference

The plugin exposes twelve MCP tools for inspection and direct control. All tools are defined in `src/tools.ts` using the `tool()` helper from `@opencode-ai/plugin`.

---

## failover_status

Show the current failover configuration, provider chain, and context headroom estimate for a session.

**Arguments**

| Argument | Type | Required | Description |
|---|---|---|---|
| `sessionID` | `string` | No | Session to report on. Defaults to the session where the tool is called. |

**Example output**

```
Quota Failover Status
Debug toasts: on
Provider chain: amazon-bedrock -> openai
Stall watchdog timeout: 45s
Stall watchdog: disabled (default)
Global failover cooldown: 1m 0s
Min retry backoff threshold: 30m 0s
Tier mappings:
opus: amazon-bedrock/us.anthropic.claude-opus-4-6-v1 -> openai/gpt-5.4
sonnet: amazon-bedrock/us.anthropic.claude-sonnet-4-6 -> openai/gpt-5.3-codex
haiku: amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0 -> openai/gpt-5.2-codex
Session: ses_abc123
Pending failover: no
Stall watchdog: idle
Last trigger: none
Last retry backoff: none seen
Last failover latency: n/a
Last transition: none
Context headroom: unknown (no assistant usage snapshot seen yet).
```

---

## failover_now

Immediately trigger a manual failover for a session, bypassing the global cooldown. The last non-command user message is replayed on the target model.

**Arguments**

| Argument | Type | Required | Description |
|---|---|---|---|
| `sessionID` | `string` | No | Session to fail over. Defaults to the current session. |
| `provider` | `string` | No | Target provider ID. If omitted, follows the configured provider chain. |
| `modelID` | `string` | No | Specific model ID. Requires `provider` when set. |
| `tier` | `string` | No | Tier hint (`opus`, `sonnet`, `haiku`). Used when provider is specified without a model. |

**Example output**

```
Failover-now dispatched.
From: anthropic/claude-sonnet-4-6
To:   amazon-bedrock/us.anthropic.claude-sonnet-4-6
Tier: sonnet
Replay source: msg_xyz789
Latency: 312ms
```

**Error output** (dispatch failure)

```
Failed to dispatch failover to openai/gpt-5.3-codex.
Reason: 401 Incorrect API key provided
Category: auth_config
Hint: OpenAI authentication/config issue. ChatGPT account login is not OpenAI API auth here. Use a valid OpenAI API key/token with billing enabled (opencode auth login openai).

Check provider auth in OpenCode and ensure the selected model is available.
```

---

## failover_set_providers

Set the ordered provider failover chain. The plugin works through this list in order when picking a fallback.

**Arguments**

| Argument | Type | Required | Description |
|---|---|---|---|
| `providers` | `string[]` | Yes | Ordered list of provider IDs. Must contain at least one. Allowed values: `amazon-bedrock`, `openai`, `anthropic`. |

Changes are saved to `settings.json` immediately.

**Example**

```
failover_set_providers(providers: ["anthropic", "amazon-bedrock", "openai"])
```

**Example output**

```
Failover provider chain updated: anthropic -> amazon-bedrock -> openai
Tier mappings:
opus: anthropic/claude-opus-4-6 -> amazon-bedrock/us.anthropic.claude-opus-4-6-v1 -> openai/gpt-5.4
sonnet: anthropic/claude-sonnet-4-6 -> amazon-bedrock/us.anthropic.claude-sonnet-4-6 -> openai/gpt-5.3-codex
haiku: anthropic/claude-haiku-4-5 -> amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0 -> openai/gpt-5.2-codex
```

---

## failover_set_model

Change the fallback model for a specific provider and tier. Changes are saved to `settings.json` immediately.

**Arguments**

| Argument | Type | Required | Description |
|---|---|---|---|
| `provider` | `string` | Yes | Provider ID. One of `amazon-bedrock`, `openai`, `anthropic`. |
| `modelID` | `string` | Yes | Model ID. Must match a model returned by `failover_list_models` for the provider. |
| `tier` | `string` | No | Tier to update (`opus`, `sonnet`, `haiku`). If omitted, inferred from the model ID. |
| `allTiers` | `boolean` | No | Apply this model to all three tiers for the provider. Overrides `tier`. |

**Example**

```
failover_set_model(
  provider: "openai",
  modelID: "gpt-5.4",
  tier: "sonnet"
)
```

**Example output**

```
Failover model updated for openai.
Updated tiers: sonnet
sonnet: openai/gpt-5.4
...

Tier mappings:
opus: amazon-bedrock/us.anthropic.claude-opus-4-6-v1 -> openai/gpt-5.4
sonnet: amazon-bedrock/us.anthropic.claude-sonnet-4-6 -> openai/gpt-5.4
haiku: amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0 -> openai/gpt-5.2-codex
```

If the model ID has known caveats, a warning is appended to the output.

---

## failover_add_model

Register a custom model for use in the failover chain without modifying source code. The model is saved to the `customModels` array in `settings.json` and loaded on each restart.

**Arguments**

| Argument | Type | Required | Description |
|---|---|---|---|
| `provider` | `string` | Yes | Provider ID. One of `amazon-bedrock`, `openai`, `anthropic`. |
| `modelID` | `string` | Yes | Model ID string. Whitespace is trimmed. |
| `tier` | `string` | Yes | Performance tier: `opus`, `sonnet`, or `haiku`. |
| `contextWindow` | `number` | No | Token context window size. Used for headroom estimates. |
| `setDefault` | `boolean` | No | If `true`, sets this model as the default for the provider+tier mapping. |

**Example**

```
failover_add_model(
  provider: "amazon-bedrock",
  modelID: "us.anthropic.claude-opus-5-0-v1",
  tier: "opus",
  contextWindow: 200000,
  setDefault: true
)
```

**Example output**

```
Custom model registered: amazon-bedrock/us.anthropic.claude-opus-5-0-v1
Tier: opus
Context window: 200000
Default updated: amazon-bedrock/opus -> us.anthropic.claude-opus-5-0-v1

Active tier mapping:
opus: amazon-bedrock/us.anthropic.claude-opus-5-0-v1
sonnet: amazon-bedrock/us.anthropic.claude-sonnet-4-6
haiku: amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0
```

Calling this tool again with the same `provider` + `modelID` updates the existing entry in place.

---

## failover_set_debug

Enable or disable debug toast notifications. When enabled, the plugin shows a bounded number of toasts per session (capped at 5, controlled by `DEBUG_TOASTS_PER_SESSION` in `constants.ts`) whenever a quota signal is detected or a dispatch attempt is made.

**Arguments**

| Argument | Type | Required | Description |
|---|---|---|---|
| `enabled` | `boolean` | Yes | `true` to enable debug toasts, `false` to disable. |

**Example**

```
failover_set_debug(enabled: true)
```

Output:

```
Failover debug toasts are now enabled.
```

Changes are saved to `settings.json` immediately.

---

## failover_list_models

List every model in the catalog for one or all providers, along with the active tier mapping.

**Arguments**

| Argument | Type | Required | Description |
|---|---|---|---|
| `provider` | `string` | No | Filter output to one provider. Omit to see all providers. |

**Example**

```
failover_list_models(provider: "openai")
```

**Example output**

```
Failover Model Catalog
Provider: openai
Available models:
- gpt-5.4
- gpt-5.3-codex
- gpt-5.3-codex-spark
- gpt-5.2
- gpt-5.2-codex
- gpt-5.1-codex-max
- gpt-5.1-codex
- gpt-5.1-codex-mini
- gpt-5-codex
- codex-mini-latest
Active tier mapping:
opus: openai/gpt-5.4
sonnet: openai/gpt-5.3-codex
haiku: openai/gpt-5.2-codex

Tip: use failover_set_model to choose a provider/tier target model.
```

Runtime-registered models (added via `failover_add_model`) appear in the available models list alongside catalog entries.

---

## failover_set_error_patterns

Set custom error message patterns that force failover for a specific provider, or for all providers with `"*"`.

Patterns are case-insensitive, support `*` wildcards, and must contain at least 10 non-wildcard characters.

**Arguments**

| Argument | Type | Required | Description |
|---|---|---|---|
| `provider` | `string` | Yes | Provider ID or `"*"` for a global pattern. Allowed values: `amazon-bedrock`, `openai`, `anthropic`, `*`. |
| `patterns` | `string[]` | Yes | One or more substring/wildcard patterns to store. |
| `replace` | `boolean` | No | Replace existing patterns instead of appending. |

**Example**

```
failover_set_error_patterns(
  provider: "*",
  patterns: ["policy*billing*review*hold"],
  replace: true
)
```

---

## failover_clear_error_patterns

Clear custom failover patterns for a specific provider or for all providers.

**Arguments**

| Argument | Type | Required | Description |
|---|---|---|---|
| `provider` | `string` | No | Provider ID or `"*"`. Omit to clear all configured patterns. |

---

## failover_add_error_pattern

Add one custom failover pattern for a provider or for all providers with `"*"`.

**Arguments**

| Argument | Type | Required | Description |
|---|---|---|---|
| `provider` | `string` | Yes | Provider ID or `"*"` for a global pattern. |
| `pattern` | `string` | Yes | Case-insensitive substring/wildcard pattern. Minimum 10 non-wildcard characters. |

**Example**

```
failover_add_error_pattern(
  provider: "amazon-bedrock",
  pattern: "request body*not valid json"
)
```

---

## failover_remove_error_pattern

Remove one custom failover pattern from a provider.

**Arguments**

| Argument | Type | Required | Description |
|---|---|---|---|
| `provider` | `string` | Yes | Provider ID or `"*"` for a global pattern. |
| `pattern` | `string` | Yes | Pattern to remove. Matching is normalized case-insensitively. |

---

## failover_list_error_patterns

List configured custom failover error patterns by provider.

**Arguments**

| Argument | Type | Required | Description |
|---|---|---|---|
| `provider` | `string` | No | Optional provider filter. Allowed values: `amazon-bedrock`, `openai`, `anthropic`, `*`. |

**Example output**

```
Custom failover error patterns:
* (1):
  1. "policy*billing*review*hold"
amazon-bedrock (1):
  1. "request body*not valid json"
```
