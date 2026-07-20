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
context builders, permissions) use a unified registry pattern. Each primitive
is a data-driven definition with metadata, schemas, and a runtime function.

New primitive types (Phases 2-7) MUST follow this pattern exactly. Zero switch
statements, zero hardcoded type strings outside definition files.

## The PrimitiveDefinition shape

Every registry entry has:
- `apiName: string` — unique camelCase identifier; must match the stored `type` field in persisted configs
- `label: string` — human-readable name shown in the UI toolbar and config panels
- `category: string` — grouping for UI palette + agent filtering
- `icon: string` — Lucide icon name (e.g. `'Database'`, `'GitBranch'`)
- `description: string` — LLM-readable prose, one sentence, present tense
- `configSchema: Record<string, unknown>` — JSON Schema for the configuration object; drives form generation and AI skill params
- `outputSchema?: Record<string, unknown>` — JSON Schema for outputs (optional); drives variable completions
- `execute` / `render` / `evaluate` — the runtime function (NEVER serialized — strip before API responses)
- `describeTemplate?: string` — one-line summary with `{fieldName}` placeholders (optional)

### Reference implementation

`packages/backend/src/domains/automation/flows/flow-steps/registry.ts` — `FlowStepRegistry` + `FlowStepDefinition`
`packages/backend/src/domains/automation/flows/flow-steps/definitions/index.ts` — 17 builtin definitions

## Registry class pattern

- **Singleton per primitive type** (e.g. `flowStepRegistry`, `fieldTypeRegistry`, `layoutComponentRegistry`)
- `register(def)` — adds entry; throws `Error` with descriptive message on duplicate `apiName`
- `registerMany(defs)` — batch register; calls `register()` for each
- `get(apiName)` — returns full definition including runtime function
- `getHandler(apiName)` — returns just the runtime function (undefined if missing)
- `list()` — returns all definitions (includes runtime function — internal use only)
- `listMetadata()` — returns definitions WITHOUT the runtime function; safe for API responses and logs
- `has(apiName)` — existence check
- `size()` — count; use in tests to assert expected registration count
- `_clearForTests()` — guarded by `NODE_ENV === 'test'`; throws in production

## Boot-time registration

- `registerBuiltin{Primitives}()` called once from `packages/backend/src/index.ts` and `packages/backend/src/worker.ts`
- Registration failure is FATAL — the server must not start with missing or partially registered primitives
- Use dynamic `import()` if definition files have circular dependency chains at module load time (see `registerBuiltinFlowSteps`)
- Test helper: call `_clearForTests()` in `beforeEach` or `beforeAll`, then re-register with `registerMany(builtinDefinitions)`

## API endpoints

Every registry exposes two endpoints:

```typescript
// List all — tagged llm-tool so agents can enumerate available types
app.get('/api/v1/admin/{primitive}-types', {
  schema: {
    operationId: 'list_{primitive}_types',
    tags: ['{Primitive}', 'llm-tool'],
    summary: 'List all available {primitive} types',
  },
}, async (request) => {
  return buildResponse(registry.listMetadata());
});

// Describe one — tagged llm-tool so agents can inspect a specific type
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
- Tag both list and describe endpoints `llm-tool` so agents auto-discover available types

## Adding a new builtin entry

1. Create `definitions/{apiName}.ts` (or add to `definitions/index.ts` for small definitions)
2. Export a `{Primitive}Definition` object with all required fields
3. Import and add to the `builtin{Primitive}Definitions` array in `definitions/index.ts`
4. The entry auto-appears in the API, frontend palette, and agent tools — no other files change

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
    properties: {
      someField: { type: 'string', description: 'What it does' },
    },
    required: ['someField'],
  },
  execute: builtinStepHandlers.myNewStep,
};
```

## Architecture tests (required per primitive)

Every primitive's test file (`registry.test.ts`) MUST include:

```typescript
it('every definition has required fields', () => {
  for (const def of builtinDefinitions) {
    expect(def.apiName).toBeTruthy();
    expect(def.label).toBeTruthy();
    expect(def.category).toBeTruthy();
    expect(def.icon).toBeTruthy();
    expect(def.description).toBeTruthy();
    expect(def.configSchema).toBeTruthy();
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
  for (const m of metas) {
    expect('execute' in m).toBe(false);
  }
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

**Tautological tripwire anti-pattern** (caught in PR #485 round 1):

```typescript
// WRONG — always passes, no matter how many definitions you drop
const EXPECTED_COUNT = builtinDefinitions.length;
expect(builtinDefinitions.length).toBeGreaterThanOrEqual(EXPECTED_COUNT);
```

## Expression-shaped fields (#715)

Any `configSchema.properties[X]` whose value the executor passes through
`interpolate()` (`packages/shared/src/utils/expression-engine.ts`) MUST be
marked `expression: true` and carry a canonical `example` containing
`{{ ... }}` mustache syntax. Two patterns then come for free:

1. The registry's `listMetadata()` appends a shared `EXPRESSION_SYNTAX_FOOTER`
   to the description so the LLM catalog tells callers exactly which syntax
   to use. The footer is one source of truth in
   `packages/backend/src/core/registry/expression-syntax-footer.ts` — if
   `interpolate()` grows new syntax later, every catalog entry picks it up
   automatically.
2. The arch test `registry-description-quality.test.ts` enforces three rules
   at CI time: every property has a non-trivial description (≥ 20 chars),
   every `expression: true` field has an `example` containing `{{`, and any
   field whose name matches the expression-suggestive regex (e.g. `collection`,
   `where`, `values`, `url`, `body`, etc.) must either be marked, allowlisted,
   or carry a co-located `// expression-not-required: <reason>` comment.

### Canonical example

```typescript
const loopDef: FlowStepDefinition = {
  apiName: 'loop',
  // ...
  configSchema: {
    type: 'object',
    properties: {
      collection: {
        description: 'Array to iterate over. Almost always a reference to an upstream queryRecords step\'s outputVariable.',
        example: '{{ variables.repositories }}',  // namespaced root — engine requires it
        expression: true,                          // marker — opt-in to footer
      },
      // iteratorVariable is a NAME, not an expression — no marker.
      iteratorVariable: { type: 'string', description: 'Variable name for the current item (literal, e.g. "currentRepo").' },
    },
  },
};
```

### When NOT to mark `expression: true`

Fields that store a literal name (an API name lookup, a SCREAMING_SNAKE_CASE
event name, a variable name to BIND not READ) should NOT be marked even if
their key name matches the tripwire regex. Add an `expression-not-required:`
comment within ±5 lines explaining why:

```typescript
// expression-not-required: `actionName` is a literal action API name lookup,
// not a mustache expression — the LLM should type the action's apiName here,
// not `{{ ... }}`.
actionName: { type: 'string', description: 'API name of the action to invoke (literal).' },
```

If no co-located comment is feasible, add the `<registry>.<primitiveApiName>.<fieldName>`
key to `NAME_TRIPWIRE_ALLOWLIST` in
`packages/backend/src/__tests__/registry-description-quality.allowlist.ts`
with a justification.

### Verify examples against the runtime engine — DON'T guess

The single failure mode this section exists to prevent: an author writes
`example: '{{ repositories }}'` based on intuition, ships it, and an LLM
that reads the catalog tries to use the same form. The engine doesn't
resolve bare names — it requires a namespace prefix (`{{ variables.repositories }}`).
The example was wrong. The arch test that passed the example was wrong-too
because it only checked for the literal `{{`, not whether the engine
resolves the path.

**Rule:** when you write an `example` value, open the resolver you're
documenting. Trace the root path. Confirm the engine returns a non-undefined
result for that path. If you can't trace it in under a minute, run the
example through the resolver in a scratch test.

- **Flow-step / layout-component fields** are interpolated by
  `packages/shared/src/utils/expression-engine.ts:interpolate()`. The
  `resolvePath` switch accepts these roots: `inputs`, `record`, `steps`,
  `variables`, `env`, `user`, `tenant`, `route`. **Bare names without a
  namespace prefix DON'T resolve** — they fall through to `default:
  return undefined`. An example like `{{ foo }}` interpolates to empty
  string at runtime.
- **Action-type fields** are interpolated by a DIFFERENT resolver:
  `domains/automation/actions/action-executors.ts:resolveMergeTagsInString`.
  Accepted tokens: `record.<field>`, `user.{id,name,email}`, bare `{{ now }}`,
  bare `{{ today }}`, legacy whole-string `$NOW` / `$USER`. The flow-step
  namespaces (`variables.*`, `inputs.*`, `steps.*`, `env.*`) do **NOT** work
  here even though both contexts use `{{ }}` mustache.
- **Two primitives sharing `expression: true`** does NOT mean they share a
  resolver. Verify each.

**Enforcement:** the arch test `registry-description-quality.test.ts` has a
**Rule 4** that extracts every `{{ token }}` from every `example` value and
validates the root namespace against the engine's accepted set per registry
context. Run this test BEFORE shipping examples — it's the contract check
the audit chain otherwise has to manually re-derive. Adding a new primitive
registry that ships `expression: true` examples MUST extend the Rule 4
allowed-roots table in the test for that registry's context.

Precedent: PR #716 (this PR) shipped 12 broken examples in the first pass
across `loop.collection`, `assignment.value`, `fieldUpdate.{recordId,updates}`,
`callWebhook.{url,headers,body}`, `httpRequest.*`, `email.*`,
`sendNotification.*`, action-type `sendNotification.title`, action-type
`callWebhook.headers`. None of them resolved under the actual engine. The
arch test added Rule 4 in response — anyone writing `example` values for
the next primitive can lean on it instead of re-deriving by hand.

### `describeTemplate`: single-brace `{fieldName}` placeholders

The human-readable label template (`describeTemplate`) uses single-brace
`{fieldName}` placeholders, per the shared `FlowStepMetadataSchema` /
`ActionTypeMetadataSchema` contracts in `@orm/shared/types`. It is NOT
interpolated by the `interpolate()` engine — it is a display string the
admin UI may substitute via its own renderer.

```typescript
describeTemplate: 'Loop over {collection} → {iteratorVariable}'
```

This is intentionally distinct from the `{{ ... }}` mustache used for
real expression interpolation in `configSchema.properties[X].example`.
The two systems have different rules; keep them visually distinct so a
reader doesn't infer that `describeTemplate` accepts the same syntax.

The LLM is taught the real expression syntax via the field-level
`description` + `example` + the `EXPRESSION_SYNTAX_FOOTER` — not via
`describeTemplate`.

Precedent: production incident 2026-05-11, conversation `49769710-…` — agent
burned 22 turns guessing the loop step's expected variable syntax because
the `collection` description was thin and the syntax was inferred from
existing flow JSON that the agent could read but couldn't disambiguate.
The fix lives in the configSchema property, not in describeTemplate.

## Frontend pattern

- `use{Primitive}Types()` hook fetches from the list endpoint using TanStack Query
- Include a `FALLBACK` constant array for offline/loading states (avoids empty palette flash)
- Components render dynamically from registry data — no `switch` statements, no hardcoded type arrays
- Use `DynamicIcon` from `@orm/ui` to render icons by name string

## Anti-patterns

These will cause bugs or architecture drift — never do them:

- **Do NOT add switch statements** on primitive type strings to dispatch behavior — use `registry.getHandler(type)` instead
- **Do NOT hardcode type strings** in files outside `definitions/` — the definitions file is the single source of truth
- **Do NOT write new `ApiSkillDefinition` entries** — the type is deleted; use tagged Fastify routes instead
- **Do NOT cache registry data in Redis** — it's already in-process memory (O(1) Map lookup)
- **Do NOT serialize the execute/render/evaluate function** in API responses or logs — always use `listMetadata()`
- **Do NOT import the runtime function** into route handlers — route handlers call `registry.listMetadata()`, not `registry.list()`
- **Do NOT skip `_clearForTests()`** in test setup — re-registration without clearing causes false "duplicate" errors
