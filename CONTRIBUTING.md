# Contributing to opencode-quota-failover

Contributions are welcome. This is an OpenCode plugin that provides automatic quota failover between AI providers, and there's always room to improve error detection, add provider support, and sharpen the test coverage.

## Development Setup

```bash
git clone https://github.com/linuxdynasty/opencode-quota-failover
cd opencode-quota-failover
bun install
```

Run the test suite:

```bash
bun test
```

The plugin is a single `index.js` file (~1576 lines). All plugin logic lives there — that's an OpenCode plugin convention. Tests are in `index.test.js`. Runtime settings are loaded from `settings.json` at startup and can be updated via MCP tools without restarting.

## Architecture Overview

**Single-file plugin** — OpenCode plugins are self-contained. Everything is in `index.js`.

**Error detection** uses a two-tier system:

- `isDefinitiveQuotaError()` — hard quota signals that always trigger failover: `insufficient_quota`, `billing_hard_limit`, HTTP 402, and similar unambiguous exhaustion signals
- `isAmbiguousRateLimitSignal()` — signals that could be transient rate limits (e.g., 429s without a clear quota message); these only trigger failover via the `session.status` path after a backoff check
- `isUsageLimitError()` — union of both, used by the `session.status` handler

**Event handlers** — the plugin listens to:
- `message.updated`
- `session.status`
- `session.error`
- `session.idle`
- `session.deleted`
- `message.part.delta`

**Failover flow**: error detected -> `queueFailover()` -> on `session.idle` -> `processFailover()` -> replay the user message to the fallback provider.

**MCP tools** — 6 tools are exposed for runtime control:
- `failover_status`
- `failover_now`
- `failover_set_providers`
- `failover_set_model`
- `failover_set_debug`
- `failover_list_models`

**Settings** — loaded from and saved to `settings.json`, hot-reloadable via the MCP tools above.

## Running Tests

```bash
bun test
```

The suite currently runs 96 tests with 0 failures. All PRs must pass the full suite before merge.

- Tests use the `bun:test` framework
- Test file: `index.test.js`
- New features must include tests
- Bug fixes should include a regression test

## How to Contribute

1. Fork the repo
2. Create a branch: `git checkout -b feat/your-feature` or `git checkout -b fix/your-fix`
3. Make your changes and write tests
4. Run `bun test` and confirm 0 failures
5. Commit using conventional commits (see below)
6. Push and open a PR against `main`
7. In the PR description, explain what you changed and why

## Commit Convention

| Prefix | Use for |
|--------|---------|
| `feat:` | new feature |
| `fix:` | bug fix |
| `docs:` | documentation changes |
| `test:` | test additions or changes |
| `chore:` | maintenance, config changes |
| `refactor:` | code restructuring without behavior change |

Example: `fix: treat azure 429 with quota header as definitive quota error`

## Code Style

- ESM modules (`import`/`export`)
- Plain JavaScript — no TypeScript; JSDoc comments where helpful
- Single-file constraint: all plugin logic stays in `index.js`
- No external runtime dependencies beyond `@opencode-ai/plugin`
- Prefer pure functions for testability
- Export functions that need unit testing

## Adding New Error Patterns

If you find a quota or rate-limit error format that isn't handled:

1. Add it to `isDefinitiveQuotaError()` if it unambiguously signals quota exhaustion
2. Add it to `isAmbiguousRateLimitSignal()` if it could be a transient rate limit
3. Write positive AND negative test cases for the new pattern
4. Include the full error message you observed in the PR description — it helps reviewers verify the classification is correct

## Adding New Providers

1. Add the provider ID to `KNOWN_PROVIDER_IDS`
2. Add model tier mappings to `DEFAULT_MODEL_BY_PROVIDER_AND_TIER`
3. Add available model IDs to `AVAILABLE_MODEL_IDS_BY_PROVIDER`
4. Update `inferTierFromModel()` with the provider's model ID patterns
5. Add tests covering the new provider's failover flow

## Reporting Issues

Open a GitHub Issue and include:

- OpenCode version
- Plugin version
- Provider(s) in use
- Error message text (if applicable)
- Steps to reproduce

For **false-positive failovers** (failover triggered when it shouldn't be), include the exact error message that triggered it. That's the most important detail for diagnosing misclassification.

## License

By contributing, you agree your changes will be licensed under MIT, the same license as this project.
