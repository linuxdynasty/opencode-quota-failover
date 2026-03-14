# Add a Model

This guide covers adding a new model to the failover catalog. All catalog changes live in one file: `src/catalog.ts`.

---

## Step 1 — Confirm the model ID

Run the OpenCode CLI to get the exact model ID string for the provider:

```bash
opencode models amazon-bedrock
opencode models openai
opencode models anthropic
```

Use the ID exactly as returned. The catalog is case-sensitive; wrong casing will cause `canonicalModelID` lookups to fail.

---

## Step 2 — Add the entry to `src/catalog.ts`

Open `src/catalog.ts` and append a new `ModelDefinition` object to the `MODEL_CATALOG` array:

```typescript
{
  id: 'us.anthropic.claude-opus-5-0-v1',   // exact string from `opencode models <provider>`
  provider: 'amazon-bedrock',               // 'amazon-bedrock' | 'openai' | 'anthropic'
  tier: 'opus',                             // 'opus' | 'sonnet' | 'haiku'
  isDefault: false,                         // true only if this should be the default for provider+tier
  contextWindow: 200000,                    // token context window, omit if unknown
  tierPatterns: ['claude-opus-5-0', 'claude-opus'],  // lowercase substrings for tier inference
  notes: 'Optional: caveats shown in failover_list_models output.',
}
```

### Field reference

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | `string` | Yes | Exact model ID from `opencode models <provider>`. |
| `provider` | `KnownProviderID` | Yes | One of `amazon-bedrock`, `openai`, `anthropic`. |
| `tier` | `KnownTier` | Yes | One of `opus`, `sonnet`, `haiku`. |
| `isDefault` | `boolean` | Yes | If `true`, becomes the default for this provider+tier. Only one entry per provider+tier can be the default. |
| `contextWindow` | `number` | No | Token context window. Used for headroom estimates in `failover_status`. |
| `tierPatterns` | `string[]` | Yes | Lowercase substrings used by `inferTierFromModelID`. Longer patterns are matched first. |
| `notes` | `string` | No | Caveats shown in `failover_list_models` output and returned by `failover_set_model` as a warning. |

### Setting a new default

If `isDefault: true`, the existing default entry for the same provider+tier must be set to `isDefault: false`. There can be exactly one default per provider+tier combination. `buildDefaultTierMapByProviderInternal` in `catalog-lookups.ts` will throw at startup if any tier is missing a default.

### Substring collision in `tierPatterns`

Patterns are sorted by length (longest first) and matched with `String.includes`. If your new model ID contains a substring that also appears in an existing pattern, put the more specific pattern earlier in the array or use a longer unique prefix:

```typescript
// gpt-5.3-codex-spark and gpt-5.3-codex both match 'gpt-5.3-codex'.
// Put the longer, more specific pattern first.
tierPatterns: ['gpt-5.3-codex-spark', 'gpt-5.3-codex'],
```

---

## Step 3 — Run the tests

```bash
bun test
```

All tests must pass before opening a pull request. If you added a new default, the test suite will catch provider+tier mapping errors immediately.

---

## Validation checklist

Before opening a PR, verify:

- [ ] `bun test` passes with no failures
- [ ] No two catalog entries have `isDefault: true` for the same `provider` + `tier`
- [ ] All `tierPatterns` strings are lowercase
- [ ] The `id` field matches the exact string from `opencode models <provider>`
- [ ] If `contextWindow` is provided, the value is in tokens (not bytes)

---

## Runtime Registration (no code change required)

If you want to add a model without modifying the source, use the `failover_add_model` MCP tool at runtime. Changes are persisted to `settings.json` and survive restarts:

```
failover_add_model(
  provider: "amazon-bedrock",
  modelID: "us.anthropic.claude-opus-5-0-v1",
  tier: "opus",
  contextWindow: 200000,
  setDefault: true
)
```

Setting `setDefault: true` updates the `modelByProviderAndTier` mapping for that provider+tier. Runtime-registered models are stored in the `customModels` array in `settings.json` and loaded back into the catalog on each restart.

This path is intended for users. Contributors adding models that should ship in the default catalog should use the `src/catalog.ts` approach described above.
