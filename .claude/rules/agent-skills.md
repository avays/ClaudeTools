# Agent Skills Architecture

## Overview

**The REST API is the agent tool catalog.** Any authenticated Fastify route becomes an
LLM tool by adding three fields to its `schema` block; the tool's input schema is derived
from the route's existing Zod validators — no separate skill definition, no registry
file, no hand-written JSON Schema.

**Security invariant**: agent execution is identical to UI execution — the skill executor
mints a 30-second user-scoped JWT and calls `app.inject()`, so the full Fastify stack
runs (tenant resolution → auth → RBAC → FLS → Zod validation → audit logging → rate
limiting). **If a user cannot perform an action in the UI, their agent cannot either.**

**Abort semantics (#474)**: `executeSkill` wraps every call in `withAbortableTimeout` —
an `AbortController` whose signal reaches the tool and aborts on the 45s per-tool timeout
OR an external cancel (`SkillExecutionRequest.signal`). Custom-skill handlers receive it
as `SkillExecutionContext.signal` and SHOULD forward it into any outbound IO (HTTP fetch,
DB calls, child processes) so a timed-out or cancelled tool stops applying side-effects. D-catalog
routes pick it up via `app.inject({ signal })`; frontend skills (D4) are pure sync and
receive none.

Route-level tagging reference: `{{PATHS_RULES_DIR}}/backend-api.md`.

---

## Making a Route Agent-Callable

Add three fields to the route's `schema` block:

```typescript
app.post('/api/v1/data/:objectApiName', {
  schema: {
    tags: ['Data', 'llm-tool'],                    // 'llm-tool' triggers auto-discovery
    operationId: 'create_record',                  // unique snake_case — must be globally unique
    description: 'Create a new record in an object. Pass objectApiName and a fields map.',
    'x-zod-body':   CreateRecordBodySchema,        // optional — Zod schema for POST/PATCH body
    'x-zod-query':  ListQuerySchema,               // optional — Zod schema for GET query params
    'x-zod-params': ApiNameParamsSchema,           // optional — Zod schema for path params
    'x-requires-permission': ['manageData'],       // optional — system permission guard (default: [])
    'x-read-only': false,                          // optional — marks tool as readOnly (default: false)
    response: { 201: successResponse(RecordSchema) },  // use successResponse/paginatedResponse
  },
  preHandler: [requireAuth, requirePermission('manageData')],
}, handler);
```

### Required fields

| Field | Purpose |
|-------|---------|
| `tags: [..., 'llm-tool']` | Opts the route into the tool catalog. Without it the route is invisible to agents. |
| `operationId` | The tool name the LLM sees. Globally unique — duplicates throw at boot. Use `snake_case`. |
| `description` | One-line description shown to the LLM. Be specific about what it does and when to use it. |

### Optional fields

| Field | Purpose |
|-------|---------|
| `x-zod-body` | Zod schema for the request body (POST/PATCH). Lets the executor split params by HTTP source. |
| `x-zod-query` | Zod schema for query string params (GET). |
| `x-zod-params` | Zod schema for path params. |
| `x-requires-permission` | System-level permission check on top of the route's `preHandler`. Defaults to `[]`. |
| `x-read-only` | `true` dispatches the tool in Phase 1 (no confirmation dialog). Defaults to `false`. |
| `response` | Response schema. `successResponse()` for single objects, `paginatedResponse()` for arrays — both set `additionalProperties: true` so Fastify won't strip undeclared fields. |

Without `x-zod-*` fields, all LLM params default to the request body.

**⚠️ `x-zod-params` is effectively mandatory on any route with path params.** The
catalog-builder uses it to mark keys `x-source: 'path'`; without it the executor sends
`:id` / `:apiName` / `:version` in the body, the URL placeholder stays literal, and the
call 404s on the first try. Every tagged route with `:foo` in its URL needs
`'x-zod-params': SomeParamsSchema`. Reusable schemas in `@orm/shared/types/common.ts`:

- `UuidParamsSchema` — `{ id }`
- `ApiNameParamsSchema` — `{ apiName }`
- `ObjectApiNameParamsSchema` — `{ objectApiName }`
- `UuidAndObjectApiNameParamsSchema`, `ApiNameAndVersionParamsSchema`, `IdAndUserIdParamsSchema` — compound variants

Attach `x-zod-body` / `x-zod-query` for the same reason when the route has those shapes.

---

## Boot-Time Security Gate

The catalog builder (`core/ai/tool-catalog/catalog-builder.ts`) validates every
`llm-tool` route at startup. Both guards run before the server accepts traffic — there is
no "degraded mode" where an insecure route silently becomes an agent tool:

1. **Auth exclusion check** — a route on the auth exclusion list (`PUBLIC_PATHS`,
   `AUTH_OPTIONAL_PATHS`) tagged `llm-tool` **crashes the server at boot**, by design:
   LLM-callable routes must be authenticated. Fix by removing `llm-tool` from its tags
   (it should not be agent-callable), or moving the route off the exclusion list (add a
   proper `requireAuth` preHandler).
2. **Zod-shape validator** — an `x-zod-body` / `x-zod-query` / `x-zod-params` value that
   is not a Zod schema (e.g. a plain JSON Schema object left accidentally) throws at boot
   naming the route and field. Replace it with a `z.object({...})` schema.

---

## Categories and Tags

The secondary tag (after `llm-tool`) groups tools in the admin UI and in agent skill
filtering.

**⚠️ The secondary tag becomes the catalog category via `tag.toLowerCase()` and agents
filter tools by exact match against `SKILL_CATEGORIES` in `packages/shared/src/types/ai.ts`.
A tag that isn't in that enum produces tools that are *tagged* but *invisible to agents*
— the catalog still builds and the boot check passes, but the AI sees nothing.**

`SKILL_CATEGORIES` = `['metadata', 'data', 'utility', 'custom', 'automation', 'integration', 'frontend', 'admin', 'security', 'reporting', 'settings']`

Use one of these as the first non-special tag. Map ambiguous domains as follows:

| Tag | Domain | Example routes |
|-----|--------|----------------|
| `Data` | data, search, recycle-bin, list-views (execute) | `query_records`, `get_record`, `search_records` |
| `Metadata` | metadata, apps, list-views (CRUD), record-types | `list_objects`, `describe_field`, `delete_object` |
| `Automation` | automation, flows, triggers, actions, **approvals** | `list_flows`, `invoke_flow`, `create_approval_process` |
| `Integration` | integrations, **webhooks** | `list_connections`, `create_webhook`, `execute_integration` |
| `Reporting` | reporting, dashboards | `list_reports`, `run_report` |
| `Security` | rbac, auth, **groups**, **sharing rules** | `list_profiles`, `create_group`, `assign_permission_set` |
| `Admin` | ai (admin), agent-skills, **users**, **apps** | `list_agents`, `create_user`, `update_user`, `create_app` |
| `Settings` | secrets, deployment, tenant config | `list_secrets`, `export_metadata` |

Historical gotcha: the tags `Apps`, `Approval`, `Groups`, `RBAC`, `Users`, `Webhooks`
produce categories NOT in `SKILL_CATEGORIES` — use the mapped equivalents above. Fixed in
#412 round 2 and #420; don't reintroduce.

**`mcp-exposed`** — makes a route visible to external MCP clients (Claude Desktop,
Cursor, IDEs); `@orm/mcp`'s `buildMcpToolsFromCatalog()` filters on this tag:

```typescript
tags: ['Data', 'llm-tool', 'mcp-exposed'],
```

The route set is pinned by a reviewed allowlist —
`packages/backend/src/__tests__/mcp-exposed.allowlist.ts`, enforced by
`mcp-exposed-allowlist.test.ts` (single source of truth; ~70 routes as of #1103). A
tagged route missing from the allowlist fails CI, and so does a stale entry. **Adding a
route to the external MCP surface is a deliberate, reviewed change** — it expands the
platform's external attack surface. Never tag admin/internal mutators `mcp-exposed`:
`update_agent` was removed in #1103 because it can rewrite an in-platform agent's system
prompt (a persistence vector from a compromised external client).

**`composite`** — informational tag on multi-step composite routes in
`domains/llm-composites/`. Does not change dispatch behavior.

---

## Composites (D3)

Operations that can't be one REST call — orchestrating several, or bridging schema
impedance (wrapping a plain string as `{ en: string }` for an i18n field) — live in
`packages/backend/src/domains/llm-composites/` as regular tagged Fastify routes.

**When to write a composite:**
- The operation requires 2+ API calls that must be sequenced or merged (e.g. GET-then-PATCH)
- The LLM sends a simpler input than the underlying API expects (i18n label wrapping)
- The operation is an orchestration (e.g. `batch_execute`, `preview_plan`)

```typescript
// packages/backend/src/domains/llm-composites/my-composite.routes.ts
import { forwardAuth } from '../../core/utils/forward-auth.js';
import { getAppInstance } from '../../core/app-instance.js';

app.post('/api/v1/llm/composites/my-composite', {
  schema: { tags: ['llm-tool', 'composite'], operationId: 'my_composite',
            description: 'Does X then Y, returning Z.',
            'x-zod-body': MyCompositeInputSchema,
            response: { 200: successResponse(MyCompositeOutputSchema) } },
  preHandler: [requireAuth],
}, async (request) => {
  const headers = forwardAuth(request);  // MANDATORY — forwards caller's JWT
  const res = await getAppInstance().inject({ method: 'GET', url: '/api/v1/...', headers });
});
```

**Rules — strictly enforced by architecture tests:**
- Route URL MUST start with `/api/v1/llm/composites/`
- Tags MUST include `['llm-tool', 'composite']`
- Every sub-`inject()` call MUST use `forwardAuth(request)` — never construct auth headers manually
- NEVER import `signSkillToken` in a composite route file
- NEVER import domain services directly — orchestrate via `getAppInstance().inject()` only
- Register the route in `composites.routes.ts`

### Direct DB reads in composites — security gate (HIGH severity if wrong)

The default composite orchestrates via `app.inject()` only, inheriting each target
route's RBAC/FLS. Some composites genuinely need an aggregate or JOIN no API exposes
(audit-log per-field rollups, cross-object record counts, `flow_versions` JOINs); there
`withTenant().readOnlyTransaction()` / `.transaction()` / `.writeTransaction()` is a
controlled exception — but **each raw SQL read bypasses the route-level permission gate
that would normally protect that table**. So you MUST:

1. **Enumerate the bypassed permissions** in a file-level comment at the top of the route
   plugin — one row per direct-SQL table read, giving "normal route gate" and "this
   composite's gate."
2. **Set `'x-requires-permission'`** (and the matching `preHandler`
   `requireSystemPermission(...)` calls) to the **union** of every permission required to
   read those tables via the corresponding route. A reviewer must be able to map each
   array entry to a row in the comment.
3. **Never loosen the route-level perm to lean on degraded-mode.** Degraded-mode is an
   `app.inject()` mechanism: sub-inject failures inherit the target route's RBAC and land
   in `degradedSources[]` on any non-2xx. Raw SQL reads never enter the inject stack, so
   they bypass those gates entirely — and even inside a `try/catch` degrading query
   failures (e.g. `statement_timeout`) to `degradedSources[]`, a *successful* read returns
   data regardless of whether the caller has the equivalent route-level permission.
   Degradation handles *query failures*, not *permission failures* — those still leak.

Example mapping comment (from `audit-unused-fields.routes.ts`):

```ts
// Permission posture (intentional). This composite has THREE direct DB
// reads that bypass route-level RBAC gates (no app.inject() path exists
// for these aggregates):
//
//   Table read           | Normal route gate                | Required here
//   --------------------- | -------------------------------- | -----------------
//   audit_logs           | VIEW_AUDIT_LOG (audit.routes.ts) | VIEW_AUDIT_LOG
//   records (aggregate)  | RBAC/FLS via /api/v1/data/*      | VIEW_ALL_DATA
//   flow_versions JOIN   | MANAGE_AUTOMATION via /admin/flows | MANAGE_AUTOMATION
//
// Sub-app.inject() paths fail open via degradedSources[]; the route-level
// gate exists for the DIRECT-SQL paths only.
app.post('/api/v1/llm/composites/audit-unused-fields', {
  // (inside the route plugin function — MUST #1's file-level comment sits at its top)
  schema: {
    // ... tags, operationId, description per the composite template ...
    'x-requires-permission': [
      PERMISSIONS.VIEW_AUDIT_LOG, PERMISSIONS.VIEW_ALL_DATA, PERMISSIONS.MANAGE_AUTOMATION,
    ],
  },
  preHandler: [
    requireAuth,
    requireSystemPermission(PERMISSIONS.VIEW_AUDIT_LOG),
    requireSystemPermission(PERMISSIONS.VIEW_ALL_DATA),
    requireSystemPermission(PERMISSIONS.MANAGE_AUTOMATION),
  ],
}, /* handler */);
```

Precedent: PR #707 (#705) R9–R10 — gated on `[VIEW_AUDIT_LOG, MANAGE_CUSTOM_OBJECTS]`, a
post-merge fix dropped `MANAGE_CUSTOM_OBJECTS` to lean on degraded-mode and silently
opened a HIGH-severity RBAC bypass on the records + `flow_versions` direct reads; fixed
by gating on the full union of all three permissions the bypassed routes required.

Common mappings (extend as new direct-DB-read composites land):

| Direct read | Bypassed route gate |
|---|---|
| `audit_logs` | `VIEW_AUDIT_LOG` (audit.routes.ts) — or `VIEW_SYSTEM_LOGS` for system-event categories |
| `records` (cross-object aggregate) | `VIEW_ALL_DATA` — equivalent to a cross-object query bypassing per-object FLS |
| `flows`, `flow_versions` | `MANAGE_AUTOMATION` (admin/flows routes) |
| `permission_sets`, `profiles`, `roles` | `MANAGE_PERMISSIONS` / `MANAGE_ROLES` |
| `approval_*` tables | `MANAGE_APPROVAL_PROCESSES` |
| `integration_connections`, `integration_providers` | `MANAGE_INTEGRATIONS` |
| `files`, `file_versions` | `VIEW_ALL_DATA` + relevant container/file perms |

Current composites: `get_current_user`, `preview_plan`, `batch_execute`,
`describe_object_full`, `describe_schema`, `organize_layout`,
`parse_natural_language_query` (D3); `create_field`, `create_list_view`,
`delegate_to_agent`, `add_object_to_app`, `remove_object_from_app` (D6b+). #899 retired
the 10 pure-i18n shims (`create_object`, `update_object`, `update_field`,
`create_layout`, `update_layout`, `create_validation_rule`, `create_script`,
`update_script`, `create_custom_page`, `update_list_view`): their operationId +
`llm-tool` tag now live on the canonical CRUD routes, which take plain-string labels via
`LocalizedField()`. `create_field` / `create_list_view` stay composites — they curate the
schema / do a read-modify-write.

---

## Frontend-Only Skills (D4)

Some "tools" produce UI directives, not server-side results: they call no API, they build
a `FrontendActionPayload` the frontend interprets via `useFrontendActionBridge.ts`. These
**frontend skills** live in `packages/backend/src/core/ai/tool-catalog/frontend-skills/`
as `FrontendSkillDefinition` objects. Write one when the action is UI-only (navigate,
open a dialog, fill a form field), no tenant data is read or written, and it makes no
sense as a server call.

**Creating a frontend skill:**

1. Create `core/ai/tool-catalog/frontend-skills/{api-name}.ts`
2. Export a `FrontendSkillDefinition` with `category: 'frontend'`
3. Implement a pure `buildDirective(params)` — **no DB access, no service imports, no `withTenant`**
4. Register it in `index.ts`'s `registerBuiltinFrontendSkills()`
5. Do NOT add a tagged Fastify route for the same operation

```typescript
import type { FrontendSkillDefinition } from './types.js';

export const navigateToPage: FrontendSkillDefinition = {
  apiName: 'navigate_to_page',
  category: 'frontend',
  subCategory: 'navigation',
  description: 'Navigate to a page in the admin UI.',
  parametersSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'The URL path to navigate to' } },
    required: ['path'],
  },
  buildDirective(params) {
    return { __frontendAction: true, action: 'navigate', params: { path: params.path },
             description: `Navigating to ${params.path}` };
  },
};
```

`buildDirective()` MUST be pure — the architecture test in `registry.test.ts` asserts no
frontend skill file imports domain services or accesses the DB. Boot-time
`assertNoFrontendSkillCollisions()` guards name conflicts across all three tool sources
(D catalog, frontend registry, legacy).

Current frontend skills (6): `navigate_to_page`, `open_create_dialog`,
`fill_form_fields`, `toggle_edit_mode`, `change_list_view`, `show_toast`.

---

## Custom Tenant Skills

Tenants create custom skills via the admin UI (`/admin/ai/skills`), stored in the
`agent_skills` table with two handler types. Three execution modes exist; each MUST keep
its own mechanism:

- **Script-backed skills** (`executeScriptHandler` in `agent-skills.service.ts`) → use
  `app.inject()`: the `platformApis` object passed to `executeScript()` injects with a
  30-second user JWT, so the full middleware stack runs (RBAC, FLS, Zod, audit) and
  triggers fire normally — these are user-initiated.
- **Flow-backed custom skills** (`executeFlowHandler`) → keep `flowService.manualRun()`
  (system-level, no per-user context). The `modifyAllData` gate enforced in
  `resolveCustomSkill` prevents privilege escalation. Intentional; do NOT convert to inject.
- **Automation scripts** (flow-steps, trigger-executor, `actions.service.ts`) → keep
  DIRECT service calls with `skipFlowTrigger: true`. These are automation-context, not
  user-initiated; converting to inject removes the `skipFlowTrigger` guard and causes
  infinite flow execution loops.

---

## Registry API Endpoints as LLM Tools

Primitive type registries (flow steps, field types, layout components…) expose their
metadata via `llm-tool`-tagged endpoints, so agents discover available types with no
hand-written skill definitions:

- `GET /api/v1/admin/flow-step-types` → all flow step types with descriptions + configSchema
- `GET /api/v1/admin/flow-step-types/:apiName` → a single step type

They follow the same tagging rules as any other LLM tool route — see
`{{PATHS_RULES_DIR}}/registry.md` for the full pattern.

## System-prompt tool references must match the catalog (#723)

Every snake_case tool name in an agent's system prompt — in the per-agent
`BUILTIN_AGENTS[i].systemPrompt` body or a shared appended rule (e.g.
`VERIFY_AFTER_INVOKE_RULE` in `agent-definitions.service.ts`) — MUST exist in the runtime
tool catalog. The LLM treats the prompt as ground truth and calls whatever it sees, so a
typo or hallucinated name is how the model learns to fail. Precedent (#723): production
conversation `fd85234d-…` repeatedly called `describe_object`, which does not exist — the real
composite is `describe_object_full`.

Guards in place:

- **Arch test:** `packages/backend/src/__tests__/agent-prompts-vs-tool-catalog.test.ts`
  scans every builtin agent's seeded prompt (all four shared rules included) AND every
  context-builder file listed in `CONTEXT_BUILDER_FILES` (tenant / user / app / object /
  record / page builders plus the registry at
  `core/ai/context/builtin-context-builders.ts`) for snake_case identifiers in
  tool-invocation context (backticks, or after
  `use`/`call`/`via`/`invoke`/`using`/`calling`/`invoking`). Each candidate must exist in
  the harvested `operationId` / `apiName` universe. A typo fails CI.
- **Migration coupling:** migration 098 inlined per-tenant prompts, so prompt updates are
  two-sided. Changing BUILTIN_AGENTS or a shared rule MUST also (a) add a numbered
  migration rewriting the inlined prompts from the OLD canonical to the NEW one
  (idempotent strict-match, dollar-quoted with a bumped tag like `$admin_prompt_vN$`), and
  (b) extend the migration-drift test in `builtin-agents.test.ts` to validate it. Current
  drift-test target: migration 131 (chain: 098 → 105 → 106 → 108 → 131).
  - **WHERE-vs-SET continuity:** migration N's SET block IS migration (N+1)'s WHERE block.
    They MUST be byte-equal or the next migration no-ops for every tenant on the previous
    canonical. The test "migration N+1 WHERE block matches migration N SET block
    byte-for-byte" in `builtin-agents.test.ts` enforces this; replicate it per transition.
  - **Belt-and-suspenders, not duplicate:** `seedBuiltinAgents()` runs on every boot and
    overwrites `system_prompt` for `is_system=true` rows via its
    `onConflict … doUpdateSet`, so the prompt-rewrite migrations (105/106/108/131) are
    functionally redundant after one boot cycle on the new code. They exist to leave the
    DB in the new canonical state IMMEDIATELY after the migration runner, BEFORE the seed
    loop — which matters for a process that crashes between the two. Both paths MUST
    produce the same canonical; the drift test guarantees that.
  - **`data_analyst` (and future builtins) catch up via the seed loop.** Migrations
    105/106/108/131 only target `api_name = 'admin_assistant'`; other builtins' prompts
    are NOT rewritten by migration — they update on the next boot via the seed-loop
    overwrite. Document the carve-out in the migration header comment when adding a
    builtin.

When editing a system prompt or shared rule:

1. Grep the catalog (`grep -r "operationId: '<name>'" packages/backend/src`)
   before referencing a tool name you didn't just verify.
2. Reword to fit existing tool names rather than invent shorthand.
3. Run the arch test locally: `{{PKG_TEST}}
   src/__tests__/agent-prompts-vs-tool-catalog.test.ts`.

### Semantic-claim verification: prompt claims must match the runtime contract

Catalog symbol existence is necessary but NOT sufficient — a prompt can name a real tool
and still mis-describe what it does (the same dimension-5 mistake #715 fixed at the
field-example level). Precedent (#723 pass-1 audit): the first `FLOW_VERSIONING_RULE`
claimed `update_flow` "creates a new ACTIVE version" — the symbol exists so the arch test
passed, but the service method strips `steps`/`inputs` and updates header columns only,
so an agent following the rule sees a 200 that doesn't reflect its change and loops on
`VERIFY_AFTER_MUTATE_RULE`.

When editing a rule that asserts runtime behavior:

1. Open the SERVICE method the rule names (e.g. `flow.service.ts:update`) and confirm the
   verbs in the rule match what the method actually does.
2. Open the ROUTE description for the same operationId — if the route's description and
   the rule disagree, fix one. They MUST agree.
3. If the rule's workflow involves multiple tools, every tool in it MUST be
   `llm-tool`-tagged. A rule saying "use X then Y" while Y is missing from the catalog
   strands the agent — symptomatically equivalent to a hallucinated tool name.
4. Add (or extend) an integration regression test walking the prompt's recommended
   sequence end-to-end: if it fails the rule is wrong, if it passes the rule's claims are
   runtime-verified. For #723 that is
   `packages/backend/src/domains/automation/flows/flow-version-edit-sequence.integration.test.ts`.

## Anti-Patterns

**Do not write `ApiSkillDefinition` entries.** The `ApiSkillDefinition` interface and
`api-skill-executor.ts` were deleted in D6, the `builtins/*.ts` skill files are gone, and
the `registry.ts` skill registry is effectively empty. If you find yourself writing
`{ apiName, api: { method, pathTemplate } }`, stop — tag the route instead.

**Do not bypass `requireAuth`.** Every LLM-callable route must have `requireAuth` in its
`preHandler` array. The boot-time gate crashes the server on a tagged auth-exclusion-list
route, but a custom preHandler that "looks like auth" and isn't passes the boot check and
creates a silent security hole.

**Do not tag routes the agent should not call.** Internal routes, admin-only routes, and
routes with destructive side-effects are tagged only after deliberate review —
`llm-tool` is opt-in for a reason.

**Do not embed business logic in the catalog builder.** `catalog-builder.ts` is a pure
traversal of the route registry — it derives JSON Schema from `x-zod-*` extensions and
collects metadata. It must never make DB calls, import services, or run user code.

**Do not add `mcp-exposed` indiscriminately.** The MCP surface is external-facing. Only
tag routes where external clients (Claude Desktop, Cursor, IDEs) have a genuine need;
over-exposing increases the attack surface.
