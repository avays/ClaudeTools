---
name: create-spec
description: Create a detailed implementation spec before building a feature or phase. This should ALWAYS be the first step before writing any code.
argument-hint: "[feature-or-phase-name]"
---

# Create Implementation Spec: $ARGUMENTS

You are creating an implementation spec for **$ARGUMENTS**. This is always the first step before any code is written. The spec goes in `.ai/specs/`.

## Process

### 1. Understand the scope

- Read `.ai/context/IMPLEMENTATION_SPEC.md` for the relevant phase/feature section
- Read `.ai/context/PRODUCT_SPEC.md` for the referenced product spec sections
- Read `CLAUDE.md` for current implementation progress and architecture context

### 2. Understand existing state from context files

Read the context files in `.ai/context/` to understand what already exists:

**Core state:**
- `.ai/context/BUILD_STATE.md` — Phase status, key counts, current focus
- `.ai/context/SCHEMA.md` — All database tables, columns, relationships
- `.ai/context/API_ENDPOINTS.md` — All registered API routes
- `.ai/context/DOMAINS.md` — Domain module inventory and dependencies
- `.ai/context/INFRASTRUCTURE.md` — Core systems, middleware, plugins, error classes
- `.ai/context/SHARED_TYPES.md` — Shared package exports (schemas, types, constants)
- `.ai/context/DEFERRED_ITEMS.md` — Work deferred from prior phases

**System deep-dives (read the ones relevant to your feature):**
- `.ai/context/AI_AGENTS.md` — Agent definitions, skills, context builders, LLM providers, conversations
- `.ai/context/INTEGRATIONS.md` — Providers, connections, executor pipeline, OAuth, circuit breaker
- `.ai/context/AUTOMATION.md` — Triggers, flows, actions, scripts, approvals, state machines
- `.ai/context/AUTH_SECURITY.md` — JWT, RBAC model, middleware stack, MFA, rate limiting
- `.ai/context/FRONTEND.md` — Route map, UI components, hooks, stores, layout engine
- `.ai/context/REALTIME.md` — Socket.io rooms, events, Redis adapter
- `.ai/context/DEPLOYMENT.md` — Docker, Railway, migrations, BullMQ queues, MinIO
- `.ai/context/PACKAGES.md` — Manifest schema, install lifecycle, registry service

Only explore the codebase directly if context files are missing or you need implementation details beyond what they cover.

### 3. Write the spec

Create the spec file at `.ai/specs/{descriptive-name}.md` with this structure:

```markdown
# {Feature/Phase Name} Implementation Spec

**Branch:** `feature/{short-name}`

## Context
Why this is being built. What it depends on. What state the codebase is in.

## Existing Infrastructure
Bullet list of relevant things that already exist (tables, columns, utilities, patterns).

---

## Sub-Phase {X}A: {Name}
**Goal:** One sentence.

### New files
- List of files to create with brief description

### Modified files
- List of existing files to change and what changes

### Key implementation details
- Algorithms, data structures, SQL patterns, etc.

### Verify
- How to confirm this sub-phase works

---

(Repeat for each sub-phase)

## Dependency Order
ASCII diagram showing sub-phase dependencies.

## Key Files Summary
Table of all files with action (Create/Modify) and sub-phase.
```

### 4. Spec writing guidelines

- **Break large features into 3-6 sub-phases** that can each be independently committed and tested
- **Order sub-phases by dependency**: data model → domain CRUD → business logic → enforcement → wiring
- **Be specific about files**: list every file to create or modify, not just directories
- **Include SQL details** for migrations: table names, columns, constraints, indexes, RLS
- **Include Zod schemas** to define in shared types
- **Reference existing patterns**: note which existing domain to follow as a template
- **List API endpoints** with HTTP method, path, and description
- **Include verification steps** per sub-phase — what to run, what to test
- **Note cross-cutting concerns**: cache invalidation, event emission, error handling
- **Flag risks or decisions** that need clarification

### 4a. Pre-flight checklist (mandatory before finalising)

Work through every item. These are the mistakes specs have repeated and the
fixes took extra Copilot + audit rounds. See
`.claude/agents/spec-writer.md` for the canonical list; the abbreviated
version:

1. New `llm-tool` route → first tag is in `SKILL_CATEGORIES` (`admin`,
   `metadata`, `data`, `automation`, `security`, `integration`, `reporting`,
   `settings`). Grep `packages/shared/src/types/ai.ts` to confirm.
2. If the domain's existing routes also use an invalid category tag
   (`'Packages'`, `'Groups'`, `'Approval'`, …), retag them in the same spec.
3. Path-param routes tagged `llm-tool` require `x-zod-params`.
4. Provenance columns (source, origin, created_via) go through
   `repository.create()`, NOT a post-install `updateX()` call.
5. Upstream data parse → `safeParse` + `PlatformError('UPSTREAM_X_INVALID',
   502)`. Never let ZodError bubble to the 400 handler.
6. Any column add/remove also modifies `packages/backend/src/core/db.ts`
   (Kysely interface for the table).
7. New routes → register in `packages/backend/src/test/helpers.ts`
   `createTestApp()`.
8. New table with FK → add to `cleanupTenant()` table list.
9. Migration number: `ls packages/backend/migrations/ | sort -V | tail -1`
   — take the next number (duplicates exist; counting doesn't work).
10. Service sibling-method calls: `fooService.method()`, not `this.method()`.
11. **Registry primitive expression-shaped fields (#715).** If the spec adds
    a new primitive (flow step, action type, field type, layout component,
    criteria operator, container provider) AND that primitive has
    `configSchema.properties[X]` whose values pass through an interpolator
    at runtime, every such field needs (a) `expression: true`, (b) a
    canonical `example` containing `{{ ... }}`, AND (c) the example's
    root path MUST be verified against the actual resolver before the
    spec is approved — open `packages/shared/src/utils/expression-engine.ts`
    (or the action-side `resolveMergeTagsInString`) and confirm the root
    is in the accepted set. Arch test
    `registry-description-quality.test.ts` Rule 4 enforces this at CI
    time; if the registry doesn't yet have Rule 4 wired, the spec must
    include "extend Rule 4 to cover this registry" as a sub-phase.
    See `.claude/rules/registry.md` "Verify examples against the runtime
    engine — DON'T guess". Literal-lookup fields (API names, event
    names, variable names to BIND) whose names match the tripwire regex
    need a co-located `// expression-not-required: <reason>` comment.
12. **LLM-facing strings = runtime contract (#715 lesson).** Any string
    the spec ships that promises specific runtime behavior to an LLM
    consumer — registry descriptions, syntax footers, prompt templates,
    error-code copy — must be verified against the runtime, not against
    intuition. If the spec ships a class of such strings, the arch test
    for that class must runtime-verify each one. See
    `.claude/agents/auditor.md` dimension 5.
13. **Builtin-agent prompt edits require a tenant-migration sub-phase
    (#723).** If the spec touches `BUILTIN_AGENTS[i].systemPrompt` or
    any shared rule appended at seed time in
    `agent-definitions.service.ts` (`FAILURE_REPORTING_RULE`,
    `VERIFY_AFTER_MUTATE_RULE`, `VERIFY_AFTER_INVOKE_RULE`,
    `FLOW_VERSIONING_RULE`, future siblings), the spec MUST include a
    numbered migration that rewrites the inlined `system_prompt` column
    on `agent_definitions` for every tenant where the value still
    matches the previous canonical (strict equality, idempotent
    UPDATE). Migration 098 inlined per-tenant prompts — seed-time
    changes alone do NOT propagate to existing tenants. The spec must
    also update the drift-test target in `builtin-agents.test.ts`
    (`MIGRATION_xyz_PATH`) to point at the new migration, and verify
    every snake_case tool name in the new prompt by grepping for
    `operationId: '<name>'` before approval. The arch test
    `agent-prompts-vs-tool-catalog.test.ts` catches typos at CI time
    but is not a substitute for the grep check.
14. **Shared-helper generalization across call sites with different
    behavior policies (#1011).** If the spec generalizes existing logic
    into one shared helper called from ≥2 sites with different
    pre-existing edge-case semantics, either parameterize the helper per
    call site or document the delta explicitly. Never claim "no behavior
    change" without tracing every caller. See `.claude/agents/spec-writer.md`
    item 14 for the worked example.

### 4b. Architectural-posture checklist

Beyond the per-feature mistakes above, every spec must preserve the
maximalist dynamic posture. Answer each question; if any is "no", justify
in the spec or drop the feature.

1. Is each new primitive type **registered** (not switched on)? See
   `.claude/rules/registry.md`.
2. Is each new behavior **LLM-callable** via a tagged `llm-tool` route? See
   `.claude/rules/agent-skills.md`.
3. Does each new registry expose **list + describe** endpoints? See
   `.claude/rules/registry.md` "API endpoints".
4. Are contracts **Zod-first** with types inferred? See
   `.claude/rules/shared-types.md`.
5. Do new components **declare their prop schema** rather than relying on
   a renderer switch?
6. Is data **declared** (query / context-builder) rather than baked into
   the component?
7. Did you ask "is this a primitive others could compose?" (composition over
   specialization)
8. No **black-box** services — every service operation has a tagged route
   equivalent.
9. Do **labels and descriptions** in the catalog match the UI copy (LLM as
   peer)?
10. Does dispatch use **runtime registry lookup** instead of compile-time
    switch?

The full reasoning lives in `.claude/rules/architecture-principles.md`.

### 5. Update project board

After the spec is created, update the linked GitHub issue's status on the ORM Build project board to **Spec Created**.

See `.ai/context/PROJECT_BOARD.md` for the option IDs and GraphQL mutation commands.

Steps:
1. Get the issue's project item ID from the board
2. Set status to "Spec Created" (option ID from PROJECT_BOARD.md)
3. If the spec is immediately approved by the user, advance to "Ready for Code"

### 6. Update references

- Update `CLAUDE.md` current focus to reflect the new work
- If this spec replaces or supersedes an older one, note that in the Context section

## Spec Storage

All specs live in `.ai/specs/` with descriptive filenames:
- `phase-N-{short-name}.md` for implementation phases
- `feature-{short-name}.md` for standalone features
- `fix-{short-name}.md` for significant bug fix plans

## Key References
- Implementation spec: `.ai/context/IMPLEMENTATION_SPEC.md`
- Product spec: `.ai/context/PRODUCT_SPEC.md`
- Build state & context files: `.ai/context/BUILD_STATE.md` (index to all context files)
- Domain pattern: `packages/backend/src/domains/metadata/` (template)
- Existing specs: `.ai/specs/`
