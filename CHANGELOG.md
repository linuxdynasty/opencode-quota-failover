# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- TypeScript strict mode with `tsconfig.json`
- Model catalog (`src/catalog.ts`) as single source of truth for all model definitions
- Catalog lookup functions (`src/catalog-lookups.ts`) for data-driven model queries
- `failover_add_model` MCP tool for runtime model registration without code changes
- Catalog parity tests (`src/catalog.test.ts`) covering tier coverage, default uniqueness, and pattern validity
- GitHub Actions CI pipeline (`.github/workflows/test.yml`)
- 17 new tests (151 total, up from 134)
- Architecture documentation with Mermaid diagrams (`docs/architecture.md`)
- Contributor guide for adding models (`docs/add-a-model.md`)
- Contributor guide for adding providers (`docs/add-a-provider.md`)
- MCP tools reference documentation (`docs/mcp-tools.md`)
- Troubleshooting guide (`docs/troubleshooting.md`)

### Changed
- Refactored 2,409-line `index.js` monolith into 15 focused TypeScript modules under `src/`
- All model data now derived from `MODEL_CATALOG` in `src/catalog.ts` (no hardcoded arrays)
- `inferTierFromModel()` uses longest-pattern-first matching from catalog `tierPatterns` fields
- `estimateModelContextLimit()` uses catalog `contextWindow` fields
- `index.js` is now a 9-line re-export bridge compiled from `src/index.ts`

### Fixed
- `gpt-5.2-codex` was incorrectly classified as sonnet tier (now correctly haiku)
- `gpt-5.1-codex-mini` was incorrectly classified as sonnet tier (now correctly haiku)

## [1.0.0] - 2025-03-01

### Added
- Automatic quota exhaustion detection with definitive and ambiguous signal tiers
- Multi-provider failover chain (Anthropic, Amazon Bedrock, OpenAI)
- Tier-aware model mapping (opus/sonnet/haiku) preserved across providers
- Global cooldown to prevent cascade failovers across concurrent subagent sessions
- Stall watchdog timer for sessions that go idle without a quota error
- 6 MCP tools for direct control: `failover_status`, `failover_now`, `failover_set_providers`, `failover_set_model`, `failover_set_debug`, `failover_list_models`
- Dispatch error diagnostics with `Reason`, `Category`, and `Hint` fields in toast notifications
- Settings persistence to `settings.json` with hot-reload on each failover event
- 134 tests, 0 failures
