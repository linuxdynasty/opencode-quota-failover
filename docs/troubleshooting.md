# Troubleshooting

Each section follows a decision tree: check the most likely cause first, then narrow down.

---

## Failover not triggering

**1. Does the provider chain contain more than one provider?**

Run `failover_status` and check the `Provider chain` line. If only one provider is listed, failover has nowhere to go. Add a fallback:

```
failover_set_providers(providers: ["anthropic", "amazon-bedrock"])
```

**2. Is the error a hard quota error or a transient rate limit?**

The plugin distinguishes two signal tiers:

- **Definitive quota errors** (`isDefinitiveQuotaError`) trigger failover immediately. Examples: `insufficient_quota`, `quota_exceeded`, `billing_hard_limit`, HTTP 402 with billing language.
- **Ambiguous rate-limit signals** (`isAmbiguousRateLimitSignal`) only trigger failover when the retry backoff meets or exceeds `minRetryBackoffMs` (default 30 minutes). Short-backoff rate limits are intentionally ignored.

If your error is a transient "429 Too Many Requests" with a short backoff, the plugin treats it as a platform-side throttle and does not fail over.

**3. Enable debug toasts to see what the plugin is detecting:**

```
failover_set_debug(enabled: true)
```

With debug toasts on, a "Failover Debug" toast appears each time a quota signal matches (up to 5 per session). The toast shows the trigger source and a normalised snippet of the error text. If no toast appears, the error text is not matching any of the quota patterns.

**4. Is the session reaching `session.idle` after the error?**

The automatic path queues the failover on error, then dispatches it when the session becomes idle. If OpenCode's session never transitions to idle (for example, it stays in an error state), `processFailover` is never called. Use `failover_now` to dispatch manually in that case.

---

## Unwanted failovers are happening

**1. Check whether a transient rate limit is matching an ambiguous signal.**

Enable debug toasts and reproduce the issue. The toast shows the detection source (`message.updated`, `session.status`, etc.) and the matched text. If you see `session.status(retry)` as the source, the retry backoff from the provider is at or above `minRetryBackoffMs`.

Lower the threshold to reduce sensitivity (the default is 30 minutes):

```
# settings.json — increase to require a longer backoff before failover fires
"minRetryBackoffMs": 3600000   # 1 hour
```

Or disable ambiguous-signal handling entirely by setting a very large value.

**2. Verify the global cooldown is preventing cascade failovers.**

`globalCooldownMs` (default 60 seconds) prevents multiple sessions from failing over in rapid succession. If you have many concurrent subagents, one session's failover blocks the others until the cooldown expires. This is intentional. Increase the value if cascade failovers are still happening with heavy subagent loads:

```
# settings.json
"globalCooldownMs": 120000   # 2 minutes
```

---

## Dispatch fails immediately

**1. Check provider authentication.**

```bash
opencode auth list
```

Every provider in your failover chain must be authenticated. Being logged into a chat interface (ChatGPT, Claude.ai) does not authenticate the API in OpenCode. You need API credentials with billing enabled.

```bash
opencode auth login openai
opencode auth login amazon-bedrock
opencode auth login anthropic
```

**2. Read the Failover Dispatch Error toast.**

When dispatch fails, the plugin shows a structured error toast:

```
Failover Dispatch Error
openai/gpt-5.3-codex failed
Reason: 401 Incorrect API key provided
Category: auth_config
Hint: OpenAI authentication/config issue. ChatGPT account login is not OpenAI API auth here. ...
```

The `Category` field maps to one of four buckets:

| Category | Meaning | Next step |
|---|---|---|
| `auth_config` | 401, 403, invalid API key, model not found | Re-authenticate with `opencode auth login <provider>`. Confirm the model ID exists. |
| `quota` | 402, `insufficient_quota`, `billing_hard_limit` | The fallback provider is also quota-exhausted. Add a third provider or wait for reset. |
| `transient` | 429, 500, 502, 503, network errors | Temporary provider-side issue. Retry manually with `failover_now` after a pause. |
| `unknown` | Unclassified error | Check raw error text in the "Reason" field. Run `failover_status` for the recent event log. |

**3. Confirm the model is available for your account.**

```bash
opencode models <provider>
```

If the configured model ID is not returned, your account may not have access to it. Use `failover_set_model` to switch to a model that appears in the list.

---

## Settings not persisting

**1. Verify the settings file path.**

The default path is:

```
~/.config/opencode/plugins/opencode-quota-failover/settings.json
```

You can override this with the environment variable `OPENCODE_FAILOVER_SETTINGS_PATH`.

**2. Check file permissions.**

```bash
ls -la ~/.config/opencode/plugins/opencode-quota-failover/settings.json
```

The file must be writable by the process running OpenCode. If the directory was created by root or a different user, change ownership:

```bash
chown -R $(whoami) ~/.config/opencode/plugins/opencode-quota-failover/
```

**3. Confirm the write completed.**

MCP tool calls save settings with `saveRuntimeSettings`, which writes atomically using `writeFile`. If the directory does not exist, it is created with `mkdir({ recursive: true })`. Check for disk-full errors if saves are silently failing.

Settings changes made via MCP tools take effect in memory immediately and are written to disk in the same call. You do not need to restart OpenCode.

---

## Provider chain exhausted

When all providers in the chain have failed, you see:

```
Model Failover
All fallback providers failed. Check provider configuration and API keys.
```

Or, after too many bounce cycles:

```
Model Failover
Stopped: failover bounced 3 times between providers. All providers may be at quota.
```

**Options:**

1. Add a provider that still has quota:
   ```
   failover_set_providers(providers: ["amazon-bedrock", "openai", "anthropic"])
   ```

2. Wait for quota to reset on one of the existing providers, then use `failover_now` to resume on that provider once it recovers.

3. Increase `MAX_BOUNCE_COUNT` in `src/constants.ts` (default 3) if you have a long chain and legitimate retry cycles. This is a code change, not a runtime setting.

---

## Failover log

Structured events are written to:

```
~/.config/opencode/plugins/opencode-quota-failover/failover.log
```

Each line is in key=value format with a timestamp and log level:

```
2026-01-15T10:23:44.001Z [TRIGGER] session=ses_abc123456 source=message.updated from=anthropic/claude-sonnet-4-6 reason="insufficient_quota"
2026-01-15T10:23:44.050Z [DISPATCH] session=ses_abc123456 from=anthropic/claude-sonnet-4-6 to=amazon-bedrock/us.anthropic.claude-sonnet-4-6 tier=sonnet
2026-01-15T10:23:44.360Z [DISPATCH_OK] session=ses_abc123456 from=anthropic/claude-sonnet-4-6 to=amazon-bedrock/us.anthropic.claude-sonnet-4-6 tier=sonnet latency=310ms
```

Common log levels:

| Level | Meaning |
|---|---|
| `TRIGGER` | Quota signal detected; failover queued |
| `DISPATCH` | Dispatch attempt initiated |
| `DISPATCH_OK` | Dispatch succeeded |
| `DISPATCH_ERROR` | Dispatch attempt failed (may retry next candidate) |
| `EXHAUSTED` | All fallback candidates failed |
| `BOUNCE_LIMIT` | Bounce counter exceeded `MAX_BOUNCE_COUNT` |
| `MANUAL` | Dispatch from `failover_now` |

The in-memory ring buffer holds the last 100 events and is shown at the bottom of `failover_status` output.
