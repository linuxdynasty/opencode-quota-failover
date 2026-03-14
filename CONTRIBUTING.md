# Contributing to opencode-quota-failover

Contributions are welcome. This is an OpenCode plugin that provides automatic quota failover between AI providers, and there's always room to improve error detection, add provider support, and sharpen the test coverage.

## Development Setup

```bash
git clone https://github.com/linuxdynasty/opencode-quota-failover
cd opencode-quota-failover
bun install
```

Verify TypeScript compiles without errors:

```bash
bunx tsc --noEmit
```

Run the test suite:

```bash
bun test
```

## Project Structure

The plugin is organized into 15 focused TypeScript modules under `src/`. The compiled output is a single `index.js` re-export bridge.

| Module | Description |
|--------|-------------|
| `src/catalog.ts` | Single source of truth for all model definitions — IDs, tiers, context windows, tier patterns |
| `src/catalog-lookups.ts` | Data-driven query functions derived from the catalog (available models, tier maps, context limits) |
| `src/types.ts` | Shared TypeScript types and interfaces used across all modules |
| `src/constants.ts` | Plugin-wide constants: provider IDs, tiers, default chain, cooldown values |
| `src/state.ts` | In-process runtime state: session maps, cooldown timestamps, watchdog handles |
| `src/settings.ts` | Disk persistence for runtime settings; read/write `settings.json` |
| `src/models.ts` | Model selection logic: tier inference, fallback chain construction, provider/tier resolution |
| `src/detection.ts` | Quota signal detection: `isDefinitiveQuotaError`, `isAmbiguousRateLimitSignal`, `isUsageLimitError` |
| `src/failover.ts` | Core failover orchestration: queue, process, replay user message to fallback provider |
| `src/handlers.ts` | OpenCode event handlers bound to `message.updated`, `session.status`, `session.error`, etc. |
| `src/messages.ts` | Message part normalization and user-message extraction for replay |
| `src/reporting.ts` | Toast formatting, status reports, and failover event log |
| `src/tools.ts` | MCP tool definitions exposed to the plugin host |
| `src/watchdog.ts` | Stall watchdog timer: fires failover if session is idle for too long |
| `src/index.ts` | Plugin entry point: wires handlers and tools, re-exports key detection functions |

`index.js` at the repo root is a 9-line re-export bridge generated from `src/index.ts`.

## Running Tests

Two test files cover the full plugin surface:

```bash
bun test
```

| Test file | What it covers |
|-----------|----------------|
| `index.test.js` | End-to-end plugin behavior: detection, failover flow, MCP tools, settings |
| `src/catalog.test.ts` | Catalog parity: every model has valid tier, default uniqueness, tier pattern coverage |

The suite runs 151 tests with 0 failures. All PRs must pass the full suite before merge.

- Tests use the `bun:test` framework
- New features must include tests
- Bug fixes should include a regression test

## Adding Models

To add a new model, edit `src/catalog.ts` and add a `ModelDefinition` entry to `MODEL_CATALOG`. Everything else (tier inference, available-model lists, context window estimates) is derived from the catalog automatically.

See [docs/add-a-model.md](./docs/add-a-model.md) for a complete walkthrough.

## Adding Providers

Adding a new provider requires changes in `src/constants.ts` (add to `KNOWN_PROVIDER_IDS`) and `src/catalog.ts` (add models with the new `provider` value). No other files need per-provider hardcoding.

See [docs/add-a-provider.md](./docs/add-a-provider.md) for a complete walkthrough.

## Adding New Error Patterns

If you find a quota or rate-limit error format that isn't handled:

1. Add it to `isDefinitiveQuotaError()` in `src/detection.ts` if it unambiguously signals quota exhaustion
2. Add it to `isAmbiguousRateLimitSignal()` if it could be a transient rate limit
3. Write positive AND negative test cases for the new pattern
4. Include the full error message you observed in the PR description

## Code Style

- TypeScript strict mode (`tsconfig.json` with `strict: true`)
- Go-style JSDoc for exported functions: one sentence starting with the function name, e.g. `/** inferTierFromModel does classify a model ID into opus/sonnet/haiku. */`
- No `as any` casts in production code
- Keep files under 500 lines; split if growing larger
- Prefer pure functions for testability; export what you need to test
- No external runtime dependencies beyond `@opencode-ai/plugin`

## PR Guidelines

Before opening a PR:

- `bun test` passes with 0 failures
- `bunx tsc --noEmit` exits clean
- No file exceeds 500 lines
- New models have catalog entries and tests
- Commit messages follow conventional commits (see below)

## How to Contribute

1. Fork the repo
2. Create a branch: `git checkout -b feat/your-feature` or `git checkout -b fix/your-fix`
3. Make your changes and write tests
4. Run `bun test` and `bunx tsc --noEmit` — both must pass
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
