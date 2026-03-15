# opencode-quota-failover

Automatic AI provider failover for OpenCode — when your quota runs out, your session keeps going.

[![CI](https://github.com/linuxdynasty/opencode-quota-failover/actions/workflows/test.yml/badge.svg)](https://github.com/linuxdynasty/opencode-quota-failover/actions/workflows/test.yml)
![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Version](https://img.shields.io/badge/version-2.0.0-green.svg)

---

## What it does

When you hit a quota limit on your primary AI provider (Claude Max, ChatGPT Pro, Amazon Bedrock), this plugin detects the error and automatically switches your session to the next provider in your configured chain. The failover is seamless: your last message is replayed to the fallback provider, and you continue without manual intervention.

The plugin distinguishes real quota exhaustion from transient rate limits. Short-lived throttling is left to the platform's built-in retry logic. Only definitive quota errors trigger a provider switch.

---

## Key features

- Automatic quota exhaustion detection (strict signal analysis, not trigger-happy on transient limits)
- Multi-provider failover chain — configure Anthropic, Amazon Bedrock, and OpenAI in any order
- Tier-aware model mapping — opus/sonnet/haiku tiers are preserved across providers
- Global cooldown prevents cascade failovers across concurrent subagent sessions
- Manual failover via MCP tools when you want direct control
- Exact dispatch-failure diagnostics in toasts (`Reason`, `Category`, `Hint`) for faster debugging
- Bedrock request-rejection detection for hard blocks like `The request body is not valid JSON`
- Custom provider-scoped or global (`*`) error patterns that can trigger failover
- All settings persisted to disk; no re-configuration on restart
- 151 tests, 0 failures

---

## Quick start

**Prerequisites**

- [OpenCode CLI](https://opencode.ai) installed
- At least two AI providers configured in OpenCode

**1. Clone the plugin**

```bash
git clone https://github.com/linuxdynasty/opencode-quota-failover.git \
  ~/.config/opencode/plugins/opencode-quota-failover
```

**2. Install dependencies**

```bash
cd ~/.config/opencode/plugins/opencode-quota-failover
bun install   # or: npm install
```

**3. Restart OpenCode**

The plugin loads automatically on startup. No additional configuration required to get started with default settings.

---

## Platform compatibility

This plugin is built exclusively for **[OpenCode CLI](https://opencode.ai)** (`anomalyco/opencode`). It uses the `@opencode-ai/plugin` SDK, which is specific to OpenCode's plugin system.

| Platform | Compatible | Notes |
|---|---|---|
| [OpenCode CLI](https://opencode.ai) | **Yes** | Full support — this is the target platform |
| Claude Code (Anthropic) | No | Completely different plugin architecture |
| Cursor | No | No compatible plugin system |
| Aider | No | No compatible plugin system |
| Goose (Block) | No | No compatible plugin system |
| Gemini CLI (Google) | No | No compatible plugin system |
| Codex CLI (OpenAI) | No | No compatible plugin system |

**Runtime**: OpenCode loads plugins via [Bun](https://bun.sh). Node.js is also supported for dependency installation (`npm install`), but the plugin runs under Bun at runtime.

**Installation paths**:
- Global: `~/.config/opencode/plugins/opencode-quota-failover/`
- Project-level: `.opencode/plugins/opencode-quota-failover/`

---

## How it works

The plugin subscribes to three OpenCode events: `message.updated`, `session.status`, and `session.error`.

**Detection**

Every incoming event is scanned for quota signals. Detection uses two tiers:

- `isDefinitiveQuotaError` — matches hard quota/billing errors (e.g., `insufficient_quota`, `billing_hard_limit`). Triggers failover immediately.
- `isAmbiguousRateLimitSignal` — matches rate-limit language that *could* indicate quota exhaustion. Failover is deferred until `session.status` confirms the session stalled, and only fires if the retry backoff is 30 minutes or longer.

**Failover flow**

1. A definitive quota error is detected in any event stream.
2. The failover is queued (a global cooldown prevents the same session from triggering multiple failovers).
3. When the session reaches `idle`, the plugin replays the user's last message to the next provider in the configured chain.
4. The model for the new provider is selected by matching the current model's tier (opus/sonnet/haiku) against the tier map.

**What does NOT trigger failover**

Transient rate limits — "too many requests", short retry backoffs under 30 minutes, server overload errors, and context length exceeded — are ignored. These resolve on their own and do not warrant switching providers.

---

## Architecture

The plugin is built as 15 focused TypeScript modules compiled to a re-export bridge (`index.js`). The model catalog (`src/catalog.ts`) is the single source of truth for all model definitions, tier mappings, and context windows. No model data is hardcoded elsewhere.

See [docs/architecture.md](./docs/architecture.md) for a full module map and Mermaid dependency diagram.

---

## Supported providers

| Provider | Provider ID | Example models |
|---|---|---|
| Anthropic | `anthropic` | claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5 |
| Amazon Bedrock | `amazon-bedrock` | us.anthropic.claude-opus-4-6-v1, us.anthropic.claude-sonnet-4-6, moonshotai.kimi-k2.5 |
| OpenAI | `openai` | gpt-5.4, gpt-5.3-codex, gpt-5.2-codex |

---

## Configuration

Settings are stored at:

```
~/.config/opencode/plugins/opencode-quota-failover/settings.json
```

The file is created with defaults on first run. You can edit it directly or use the MCP tools to update individual values.

**Example settings.json**

```json
{
  "providerChain": ["amazon-bedrock", "openai"],
  "modelByProviderAndTier": {
    "amazon-bedrock": {
      "opus": "us.anthropic.claude-opus-4-6-v1",
      "sonnet": "us.anthropic.claude-sonnet-4-6",
      "haiku": "us.anthropic.claude-haiku-4-5-20251001-v1:0"
    },
    "openai": {
      "opus": "gpt-5.4",
      "sonnet": "gpt-5.3-codex",
      "haiku": "gpt-5.2-codex"
    },
    "anthropic": {
      "opus": "claude-opus-4-6",
      "sonnet": "claude-sonnet-4-6",
      "haiku": "claude-haiku-4-5"
    }
  },
  "customFailoverPatterns": {
    "*": ["policy*billing*review*hold"],
    "openai": ["account*suspended"]
  },
  "debugToasts": true,
  "stallWatchdogEnabled": false,
  "stallWatchdogMs": 45000,
  "globalCooldownMs": 60000,
  "minRetryBackoffMs": 1800000
}
```

**Settings reference**

| Setting | Type | Default | Description |
|---|---|---|---|
| `providerChain` | `string[]` | `["amazon-bedrock", "openai"]` | Ordered list of fallback providers. When failover triggers, the plugin moves to the next provider in this list. |
| `modelByProviderAndTier` | `object` | See above | Maps each provider and tier (opus/sonnet/haiku) to a specific model ID. |
| `customFailoverPatterns` | `object` | `{}` | Optional provider-keyed error patterns that force failover when matched. Use provider IDs (`anthropic`, `amazon-bedrock`, `openai`) or `"*"` for a global match. Patterns are case-insensitive and support `*` wildcards. |
| `debugToasts` | `boolean` | `true` | Show toast notifications when quota signals are detected. Useful for diagnosing unexpected failovers. |
| `stallWatchdogEnabled` | `boolean` | `false` | Enable a watchdog timer that fires failover if the session stalls for longer than `stallWatchdogMs`. |
| `stallWatchdogMs` | `number` | `45000` | Milliseconds before the stall watchdog fires. Only applies when `stallWatchdogEnabled` is true. |
| `globalCooldownMs` | `number` | `60000` | Minimum time (ms) between failovers across all sessions. Prevents cascade failovers when multiple subagents hit quota simultaneously. |
| `minRetryBackoffMs` | `number` | `1800000` | Minimum retry backoff (ms) that classifies an ambiguous rate-limit signal as a quota error. Default is 30 minutes. |

---

## MCP tools

The plugin exposes twelve MCP tools for direct control and inspection. See [docs/mcp-tools.md](./docs/mcp-tools.md) for the full reference with argument schemas and example outputs.

**`failover_status`**

Show the current failover state, provider chain, and estimated context headroom for the active session.

```
Arguments: none (optional: sessionID)
```

**`failover_now`**

Manually trigger failover to a specific provider, bypassing the global cooldown.

```
Arguments:
  sessionID  string   (optional) Session to fail over
  provider   string   (optional) Target provider ID
  modelID    string   (optional) Specific model to use
  tier       string   (optional) Tier hint: opus | sonnet | haiku
```

**`failover_set_providers`**

Set the provider failover chain order.

```
Arguments:
  providers  string[]  Ordered list of provider IDs
```

**`failover_set_model`**

Set the fallback model for a specific provider and tier.

```
Arguments:
  provider   string   Provider ID (anthropic | amazon-bedrock | openai)
  tier       string   Tier: opus | sonnet | haiku
  modelID    string   Model ID to use for this provider/tier
  allTiers   boolean  (optional) Apply modelID to all tiers for this provider
```

**`failover_set_debug`**

Enable or disable debug toast notifications for quota signal detection.

```
Arguments:
  enabled  boolean
```

**`failover_list_models`**

List available failover models and the active tier mappings.

```
Arguments:
  provider  string  (optional) Filter by provider ID
```

**`failover_add_model`**

Register a new model at runtime without editing code. The model is added to the in-memory catalog and optionally set as the default for its provider/tier.

```
Arguments:
  provider       string   Provider ID (anthropic | amazon-bedrock | openai)
  modelID        string   Model ID to register
  tier           string   Tier: opus | sonnet | haiku
  setDefault     boolean  (optional) Set as default for this provider/tier
  contextWindow  number   (optional) Token context window size
```

**`failover_set_error_patterns`**

Set one or more custom error patterns for a provider or for all providers via `"*"`.

```
Arguments:
  provider  string     Provider ID (anthropic | amazon-bedrock | openai | *)
  patterns  string[]   Case-insensitive substring/wildcard patterns
  replace   boolean    (optional) Replace existing patterns instead of appending
```

**`failover_clear_error_patterns`**

Clear custom error patterns for a provider or all providers.

```
Arguments:
  provider  string  (optional) Provider ID (anthropic | amazon-bedrock | openai | *)
```

**`failover_add_error_pattern`**

Add one custom error pattern for a provider or for all providers via `"*"`.

```
Arguments:
  provider  string  Provider ID (anthropic | amazon-bedrock | openai | *)
  pattern   string  Case-insensitive substring/wildcard pattern
```

**`failover_remove_error_pattern`**

Remove one custom error pattern for a provider.

```
Arguments:
  provider  string  Provider ID (anthropic | amazon-bedrock | openai | *)
  pattern   string  Pattern to remove
```

**`failover_list_error_patterns`**

List configured custom failover error patterns by provider.

```
Arguments:
  provider  string  (optional) Provider ID (anthropic | amazon-bedrock | openai | *)
```

---

## Contributing a model

To add a new model to the failover catalog, edit `src/catalog.ts` and add a `ModelDefinition` entry. The catalog is the single source of truth — tier inference, context window estimates, and available model lists are all derived from it automatically.

See [docs/add-a-model.md](./docs/add-a-model.md) for a step-by-step walkthrough.

For adding an entirely new provider, see [docs/add-a-provider.md](./docs/add-a-provider.md).

---

## Quota detection

**These errors trigger failover**

| Signal | Example |
|---|---|
| `insufficient_quota` | OpenAI quota exhausted |
| `quota_exceeded` | Generic quota error |
| `billing_hard_limit` | Billing cap reached |
| "out of credits" | Account credits depleted |
| HTTP 402 + billing language | Payment required with billing context |
| Retry backoff >= 30 min + account/quota words | Ambiguous signal with long backoff |
| Bedrock request rejection: `The request body is not valid JSON` | Hard provider-side request block on Bedrock models |

**These errors do NOT trigger failover**

| Signal | Reason |
|---|---|
| `429 Too Many Requests` (short backoff) | Transient rate limit — resolves automatically |
| Retry backoff under 30 minutes | Short-lived throttle, not quota exhaustion |
| Server overload / 503 errors | Infrastructure issue, not account quota |
| Context length exceeded | Model limit, not quota |
| Generic throttling without quota language | Not quota-related |

---

## Troubleshooting

For a more complete troubleshooting reference, see [docs/troubleshooting.md](./docs/troubleshooting.md).

**Failover isn't triggering**

Check that your `providerChain` contains at least one provider other than your current provider. Verify the error you're seeing is a hard quota error, not a transient rate limit. Enable `debugToasts` to see which signals the plugin is detecting in real time.

**Unwanted failovers are happening**

A transient rate limit may be matching an ambiguous signal pattern. Enable `debugToasts` to inspect what triggered the failover. If the backoff is short (under 30 minutes), the detection logic should not fire — if it is, check your `minRetryBackoffMs` setting.

**"No fallback available" or failover loops**

Your provider chain is exhausted. All configured providers have hit their quota or are unreachable. Add more providers to `providerChain` or wait for quota to reset on one of the existing providers.

**OpenAI failover dispatch fails immediately**

If failover to OpenAI fails right away, check the **Failover Dispatch Error** toast. It now includes:

- `Reason`: the exact provider error (including status/message)
- `Category`: `auth_config`, `quota`, `transient`, or `unknown`
- `Hint`: provider-specific next action

For OpenAI specifically, being logged into ChatGPT does **not** authenticate OpenAI API usage in OpenCode. Use a valid OpenAI API key/token with billing enabled, then re-authenticate with:

```bash
opencode auth login openai
```

**Settings changes aren't taking effect**

The plugin reads settings from disk on each failover event. You don't need to restart OpenCode after editing `settings.json`, but you do need to save the file. If using MCP tools to update settings, changes are applied immediately.

---

## License

MIT. See [LICENSE](./LICENSE) for the full text.
