---
globs:
  - "**/registry.ts"
  - "**/definitions/**"
  - "**/*-registry.ts"
  - "**/*Registry.ts"
---

# Registry Pattern Conventions

## Overview

Platform primitives (flow steps, field types, layout components, action types,
context builders, permissions) share one registry pattern: a data-driven
definition carrying metadata, schemas, and a runtime function. New primitive
types MUST follow it exactly — zero switch statements, zero hardcoded type
strings outside definition files.

## The PrimitiveDefinition shape

- `apiName: string` — unique camelCase id; MUST match the stored `type` in persisted configs
- `label: string` — human-readable name shown in the UI toolbar and config panels
- `category: string` — grouping for UI palette + agent filtering
- `icon: string` — Lucide icon name (e.g. `'Database'`, `'GitBranch'`)
- `description: string` — LLM-readable prose, one sentence, present tense
- `configSchema: Record<string, unknown>` — JSON Schema for the config object; drives form generation + AI skill params
- `outputSchema?: Record<string, unknown>` — JSON Schema for outputs; drives variable completions
- `execute` / `render` / `evaluate` — the runtime function (NEVER serialized — strip before API responses)
- `describeTemplate?: string` — one-line summary with `{fieldName}` placeholders

### Reference implementation

`packages/backend/src/domains/automation/flows/flow-steps/registry.ts`
(`FlowStepRegistry` + `FlowStepDefinition`) and
`packages/backend/src/domains/automation/flows/flow-steps/definitions/index.ts`
(17 builtin definitions).

## Registry class pattern

- **Singleton per primitive type** (`flowStepRegistry`, `fieldTypeRegistry`, `layoutComponentRegistry`)
- `register(def)` — adds entry; throws `Error` with a descriptive message on duplicate `apiName`
- `registerMany(defs)` — batch register; calls `register()` for each
- `get(apiName)` — full definition, including the runtime function
- `getHandler(apiName)` — just the runtime function (undefined if missing)
- `list()` — all definitions (includes runtime function — internal use only)
- `listMetadata()` — definitions WITHOUT the runtime function; the only form safe for API responses and logs
- `has(apiName)` — existence check
- `size()` — count; use in tests to assert the expected registration count
- `_clearForTests()` — guarded by `NODE_ENV === 'test'`; throws in production

## Boot-time registration

- `registerBuiltin{Primitives}()` called once from `packages/backend/src/index.ts` and `packages/backend/src/worker.ts`
- Registration failure is FATAL — the server must not start with missing or partially registered primitives
- Use dynamic `import()` when definition files have circular dependency chains at module load (see `registerBuiltinFlowSteps`)
- Test setup: `_clearForTests()` in `beforeEach`/`beforeAll`, then re-register via `registerMany(builtinDefinitions)`

## API endpoints

Every registry exposes two endpoints, both tagged `llm-tool`:

```typescript
// List all — agents enumerate available types
app.get('/api/v1/admin/{primitive}-types', {
  schema: {
    operationId: 'list_{primitive}_types',
    tags: ['{Primitive}', 'llm-tool'],
    summary: 'List all available {primitive} types',
  },
}, async (request) => buildResponse(registry.listMetadata()));

// Describe one — agents inspect a specific type
app.get('/api/v1/admin/{primitive}-types/:apiName', {
  schema: {
    operationId: 'get_{primitive}_type',
    tags: ['{Primitive}', 'llm-tool'],
    summary: 'Get a single {primitive} type by apiName',
    'x-zod-params': z.object({ apiName: z.string() }),
  },
}, async (request) => {
  const { apiName } = request.params as { apiName: string };
  const def = registry.get(apiName);
  if (!def) throw new NotFoundError(`{Primitive} type not found: ${apiName}`);
  const { execute: _execute, ...meta } = def;
  return buildResponse(meta);
});
```

**Rules:**
- NEVER expose the `execute`/`render`/`evaluate` function in API responses
- Registry is in-memory — do NOT cache in Redis (Map lookup is O(1); caching adds stale-data risk)
- Tag BOTH endpoints `llm-tool` so agents auto-discover available types

## Adding a new builtin entry

1. Create `definitions/{apiName}.ts` (or add to `definitions/index.ts` for small definitions)
2. Export a `{Primitive}Definition` object with all required fields
3. Import and add it to the `builtin{Primitive}Definitions` array in `definitions/index.ts`
4. It auto-appears in the API, frontend palette, and agent tools — no other files change

```typescript
// definitions/myNewStep.ts
import type { FlowStepDefinition } from '../registry.js';
import { builtinStepHandlers } from '../index.js';

export const myNewStepDef: FlowStepDefinition = {
  apiName: 'myNewStep',
  label: 'My New Step',
  category: 'record-ops',
  icon: 'Zap',
  description: 'Does something useful.',
  configSchema: {
    type: 'object',
    properties: { someField: { type: 'string', description: 'What it does' } },
    required: ['someField'],
  },
  execute: builtinStepHandlers.myNewStep,
};
```

## Architecture tests (required per primitive)

Every primitive's `registry.test.ts` MUST include:

```typescript
it('every definition has required fields', () => {
  for (const def of builtinDefinitions) {
    for (const k of ['apiName', 'label', 'category', 'icon', 'description', 'configSchema'] as const) {
      expect(def[k], k).toBeTruthy();
    }
    expect(typeof def.execute).toBe('function');
  }
});

it('has no duplicate apiNames', () => {
  const names = builtinDefinitions.map((d) => d.apiName);
  expect(new Set(names).size).toBe(names.length);
});

it('listMetadata returns serializable objects (no functions)', () => {
  const registry = new PrimitiveRegistry();
  registry.registerMany(builtinDefinitions);
  const metas = registry.listMetadata();
  expect(() => JSON.stringify(metas)).not.toThrow();
  for (const m of metas) expect('execute' in m).toBe(false);
});

// EXPECTED_COUNT MUST be a hardcoded number. Deriving it from the array
// under test (`const EXPECTED_COUNT = builtinDefinitions.length`) is
// tautological — the assertion can never fail. Bump the number
// intentionally when adding a new definition.
const EXPECTED_COUNT = 3; // native, google_drive, sharepoint

it('count matches expected (catches accidental drops)', () => {
  expect(builtinDefinitions.length).toBeGreaterThanOrEqual(EXPECTED_COUNT);
});
```

Reference: `packages/backend/src/domains/automation/flows/flow-steps/registry.test.ts`

**Tautological tripwire anti-pattern** (PR #485 r1):

```typescript
// WRONG — always passes, no matter how many definitions you drop
const EXPECTED_COUNT = builtinDefinitions.length;
expect(builtinDefinitions.length).toBeGreaterThanOrEqual(EXPECTED_COUNT);
```

## Expression-shaped fields (#715)

Any `configSchema.properties[X]` whose value the executor passes through
`interpolate()` (`packages/shared/src/utils/expression-engine.ts`) MUST be marked
`expression: true` and carry a canonical `example` containing `{{ ... }}` mustache
syntax. Two patterns then come for free:

1. `listMetadata()` appends the shared `EXPRESSION_SYNTAX_FOOTER` to the
   description, so the LLM catalog states the exact syntax. It is one source of
   truth (`packages/backend/src/core/registry/expression-syntax-footer.ts`) —
   when `interpolate()` grows new syntax, every catalog entry picks it up.
2. The arch test `registry-description-quality.test.ts` enforces three rules at CI
   time: every property has a non-trivial description (≥ 20 chars); every
   `expression: true` field has an `example` containing `{{`; any field whose name
   matches the expression-suggestive regex (`collection`, `where`, `values`, `url`,
   `body`, …) is marked, allowlisted, or carries a co-located
   `// expression-not-required: <reason>` comment.

### Canonical example

```typescript
// loop step — configSchema.properties
collection: {
  description: 'Array to iterate over. Almost always a reference to an upstream queryRecords step\'s outputVariable.',
  example: '{{ variables.repositories }}',  // namespaced root — engine requires it
  expression: true,                          // marker — opt-in to footer
},
// iteratorVariable is a NAME, not an expression — no marker.
iteratorVariable: { type: 'string', description: 'Variable name for the current item (literal, e.g. "currentRepo").' },
```

### When NOT to mark `expression: true`

A field storing a literal name (an API name lookup, a SCREAMING_SNAKE_CASE event
name, a variable name to BIND not READ) is NOT marked even when its key matches
the tripwire regex — add an `expression-not-required:` comment within ±5 lines:

```typescript
// expression-not-required: `actionName` is a literal action API name lookup,
// not a mustache expression — the LLM should type the action's apiName here,
// not `{{ ... }}`.
actionName: { type: 'string', description: 'API name of the action to invoke (literal).' },
```

Where no co-located comment is feasible, add the
`<registry>.<primitiveApiName>.<fieldName>` key to `NAME_TRIPWIRE_ALLOWLIST` in
`packages/backend/src/__tests__/registry-description-quality.allowlist.ts` with a
justification.

### Verify examples against the runtime engine — DON'T guess

**Rule:** writing an `example` means opening the resolver you are documenting,
tracing the root path, and confirming the engine returns a non-undefined result;
if you can't trace it in a minute, run the example through the resolver in a
scratch test. An intuition-written example (`{{ repositories }}`) ships a form the
engine never resolves — and every LLM reading the catalog copies it. A
`{{`-presence check (Rule 2) passing is NOT evidence the root resolves;
that is Rule 4's job.

- **Flow-step / layout-component fields** — interpolated by
  `packages/shared/src/utils/expression-engine.ts:interpolate()`, whose
  `resolvePath` switch accepts these roots ONLY: `inputs`, `record`, `steps`,
  `variables`, `env`, `user`, `tenant`, `route`. **Bare names without a namespace
  prefix DON'T resolve** — they hit `default: return undefined`, so `{{ foo }}`
  interpolates to the empty string at runtime.
- **Action-type fields** — a DIFFERENT resolver,
  `domains/automation/actions/action-executors.ts:resolveMergeTagsInString`.
  Accepted tokens: `record.<field>`, `user.{id,name,email}`, bare `{{ now }}`,
  bare `{{ today }}`, legacy whole-string `$NOW` / `$USER`. The flow-step
  namespaces (`variables.*`, `inputs.*`, `steps.*`, `env.*`) do **NOT** work here,
  even though both contexts use `{{ }}` mustache.
- **Two primitives sharing `expression: true`** does NOT mean they share a
  resolver. Verify each.

**Enforcement:** `registry-description-quality.test.ts` **Rule 4** extracts every
`{{ token }}` from every `example` and validates its root namespace against the
engine's accepted set for that registry's context. Run it BEFORE shipping
examples. A new primitive registry shipping `expression: true` examples MUST
extend the Rule 4 allowed-roots table for its own context.

Precedent: PR #716 shipped 12 examples resolving to nothing under the real engine
— `loop.collection`, `assignment.value`, `fieldUpdate.{recordId,updates}`,
`callWebhook.{url,headers,body}`, `httpRequest.*`, `email.*`, `sendNotification.*`,
plus action-type `sendNotification.title` and `callWebhook.headers`. Rule 4 was
added in response — lean on it instead of re-deriving the contract by hand.

### `describeTemplate`: single-brace `{fieldName}` placeholders

`describeTemplate` is a display string with single-brace `{fieldName}`
placeholders, per the `FlowStepMetadataSchema` / `ActionTypeMetadataSchema`
contracts in `@orm/shared/types`. It is NOT interpolated by `interpolate()` — the
admin UI substitutes it with its own renderer.

```typescript
describeTemplate: 'Loop over {collection} → {iteratorVariable}'
```

Keep it visually distinct from the `{{ ... }}` mustache used for real
interpolation in `configSchema.properties[X].example` — different systems,
different rules; a reader must never infer shared syntax. The LLM learns the real
syntax from the field-level `description` + `example` + `EXPRESSION_SYNTAX_FOOTER`,
never from `describeTemplate`. Precedent: production incident 2026-05-11
(conversation `49769710-…`) — an agent burned 22 turns guessing the loop step's
variable syntax because the `collection` description was thin, inferring it from
flow JSON it could read but not disambiguate; the fix belongs in the configSchema
property, not in `describeTemplate`.

## Asymmetric per-definition behavior — encode as data, not an inferred type-string branch (#1031)

When two entries in a definition map (`LEDGER_STAMP_MAP`-style registries, not
just the primitive registries above) produce a **structurally identical result**
from their runtime function — e.g. two resolvers both returning an empty `Map` —
but the caller must treat those results DIFFERENTLY per the definition that
produced them, do NOT disambiguate by checking `apiName`/`type` against a
hardcoded name (`if (type === 'stateMachine') ...`). That is a switch statement in
disguise, violating the same "zero switch statements on primitive type strings"
rule as hand-dispatching `execute`/`render` (see Anti-patterns) — it just moves
the switch from "which function to call" to "how to read the result." Instead,
add an explicit boolean/enum field to the definition interface encoding the
caller-visible distinction, and gate the caller's branch on it:

```typescript
interface LedgerStampDefinition {
  resolveIds: (...) => Promise<Map<string, string>>;
  // true ONLY for definitions with no storage identity at all (an empty
  // map means "this type never has a row to point at" rather than "every
  // key in this batch failed to resolve"). Data-driven signal — the
  // caller branches on this field, never on the definition's apiName.
  stampWhenUnresolved: boolean;
}
```

The tell that you need this pattern: the two "empty result" cases are reachable
from different intents ("resolver ran and everything missed" vs. "this type
structurally has nothing to resolve"), and a shape-only check on the result
(`idMap.size === 0`) can't tell them apart. Precedent:
`deployment/provenance-ledger.ts`'s `LedgerStampDefinition.stampWhenUnresolved`
(#1031, PR #1207 spec-audit opus r7) — the original sketch had no such field,
forcing an implementer toward `if (type === 'stateMachine')` to tell "skip this
unresolved key" from "stamp it with `entity_id` NULL" — exactly the by-name
branch this file's registry pattern exists to eliminate.

## Frontend pattern

- `use{Primitive}Types()` hook fetches the list endpoint via TanStack Query
- Include a `FALLBACK` constant array for offline/loading states (avoids empty palette flash)
- Components render dynamically from registry data — no `switch` statements, no hardcoded type arrays
- Use `DynamicIcon` from `@orm/ui` to render icons by name string

## Anti-patterns

These cause bugs or architecture drift — never do them:

- **Do NOT add switch statements** on primitive type strings to dispatch behavior — use `registry.getHandler(type)`
- **Do NOT hardcode type strings** outside `definitions/` — the definitions file is the single source of truth
- **Do NOT write new `ApiSkillDefinition` entries** — the type is deleted; use tagged Fastify routes instead
- **Do NOT cache registry data in Redis** — it's already in-process memory (O(1) Map lookup)
- **Do NOT serialize the execute/render/evaluate function** in API responses or logs — always use `listMetadata()`
- **Do NOT import the runtime function** into route handlers — they call `registry.listMetadata()`, never `registry.list()`
- **Do NOT skip `_clearForTests()`** in test setup — re-registration without clearing causes false "duplicate" errors
