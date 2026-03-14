# Add a Provider

This guide walks through adding support for a new AI provider. The example uses a hypothetical `google-vertex` provider throughout, but the steps apply to any provider.

Four files need to change. No other files require modification for a basic integration.

---

## Overview

| File | What changes |
|---|---|
| `src/catalog.ts` | Add model entries for the new provider |
| `src/constants.ts` | Add the provider ID to `KNOWN_PROVIDER_IDS` |
| `src/types.ts` | Add the provider ID to the `KnownProviderID` union type |
| `src/tools.ts` | Add the provider ID to every `tool.schema.enum` that lists providers |

---

## Step 1 — Add models to `src/catalog.ts`

Add at least three entries to `MODEL_CATALOG`, one for each tier (`opus`, `sonnet`, `haiku`), each with `isDefault: true`:

```typescript
{
  id: 'gemini-2-0-ultra',
  provider: 'google-vertex',
  tier: 'opus',
  isDefault: true,
  contextWindow: 1000000,
  tierPatterns: ['gemini-2-0-ultra', 'gemini-ultra'],
},
{
  id: 'gemini-2-0-pro',
  provider: 'google-vertex',
  tier: 'sonnet',
  isDefault: true,
  contextWindow: 1000000,
  tierPatterns: ['gemini-2-0-pro', 'gemini-pro'],
},
{
  id: 'gemini-2-0-flash',
  provider: 'google-vertex',
  tier: 'haiku',
  isDefault: true,
  contextWindow: 1000000,
  tierPatterns: ['gemini-2-0-flash', 'gemini-flash'],
},
```

All three tiers are required. `buildDefaultTierMapByProviderInternal` in `catalog-lookups.ts` throws at startup if any tier is missing a default for a provider that appears in the catalog.

---

## Step 2 — Register the provider ID in `src/constants.ts`

Add the new ID to `KNOWN_PROVIDER_IDS`:

```typescript
export const KNOWN_PROVIDER_IDS: KnownProviderID[] = [
  'amazon-bedrock',
  'openai',
  'anthropic',
  'google-vertex',   // add here
];
```

This array controls which values are accepted by `normalizeProviderList`, `isKnownProviderID`, and the model routing logic in `models.ts`.

---

## Step 3 — Extend the `KnownProviderID` type in `src/types.ts`

```typescript
export type KnownProviderID =
  | 'amazon-bedrock'
  | 'openai'
  | 'anthropic'
  | 'google-vertex';  // add here
```

The TypeScript compiler will flag any exhaustive switches or type narrowing that need updating after this change.

---

## Step 4 — Update provider enums in `src/tools.ts`

Every MCP tool argument that accepts a provider ID uses `tool.schema.enum([...])`. Update all four occurrences:

```typescript
// failover_set_debug: no provider arg, skip
// failover_set_providers:
providers: tool.schema
  .array(tool.schema.enum(['amazon-bedrock', 'openai', 'anthropic', 'google-vertex']))

// failover_list_models:
provider: tool.schema
  .enum(['amazon-bedrock', 'openai', 'anthropic', 'google-vertex'])

// failover_set_model:
provider: tool.schema
  .enum(['amazon-bedrock', 'openai', 'anthropic', 'google-vertex'])

// failover_add_model:
provider: tool.schema
  .enum(['amazon-bedrock', 'openai', 'anthropic', 'google-vertex'])

// failover_now:
provider: tool.schema
  .enum(['amazon-bedrock', 'openai', 'anthropic', 'google-vertex'])
```

---

## Step 5 — Verify and test

Confirm the provider is authenticated in OpenCode:

```bash
opencode auth list
opencode models google-vertex
```

Then run the full test suite:

```bash
bun test
```

### Tests to expect

- `buildDefaultProviderTierMatrix` should include `google-vertex` with all three tiers populated.
- `inferTierFromModelID` should resolve each new model ID to the correct tier.
- `availableModelsForProvider('google-vertex')` should return all catalog entries.
- `normalizeProviderList(['google-vertex'])` should pass through without filtering.

Add new test cases in `src/catalog.test.ts` covering tier inference and default mappings for the new provider's models.

---

## Default chain placement

The `DEFAULT_PROVIDER_CHAIN` in `constants.ts` is the out-of-box fallback order for users who haven't customised their chain:

```typescript
export const DEFAULT_PROVIDER_CHAIN: KnownProviderID[] = ['amazon-bedrock', 'openai'];
```

You can add `'google-vertex'` here if it should be part of the default chain. Users can always override this at runtime with `failover_set_providers`.
