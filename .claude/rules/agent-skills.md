# Agent Skills Architecture

## Overview

**The REST API is the agent tool catalog.** Any authenticated Fastify route can be
exposed as an LLM tool by adding three fields to its `schema` block. The platform
automatically derives the tool's input schema from the Zod validators already on the
route — no separate skill definition, no registry file, no hand-written JSON Schema.

**Security invariant**: Agent tool execution is identical to UI execution. The skill
executor mints a 30-second user-scoped JWT and calls `app.inject()`. The full Fastify
middleware stack runs: tenant resolution → auth → RBAC → FLS → Zod validation →
audit logging → rate limiting. **If a user cannot perform an action in the UI, their
agent cannot perform it either.**

**Abort semantics (#474)**: `executeSkill` wraps every tool call in
`withAbortableTimeout`, which creates an `AbortController` and forwards its
signal to the tool implementation. The signal aborts on per-tool timeout (45s)
OR when an external cancel signal fires (`SkillExecutionRequest.signal`).
Custom-skill handlers receive the signal via `SkillExecutionContext.signal`
and SHOULD forward it into any outbound IO (HTTP fetch, DB calls, child
processes) so a timed-out or cancelled tool stops applying side-effects.
D-catalog routes pick up the signal automatically via `app.inject({ signal })`.
Frontend skills (D4) are pure sync and do not receive the signal.

See `.claude/rules/backend-api.md` for the route-level tagging reference.

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
| `tags: [..., 'llm-tool']` | Opts the route into the tool catalog. Without this, the route is invisible to agents. |
| `operationId` | The tool name the LLM sees. Must be globally unique — duplicate `operationId` values throw at boot. Use `snake_case`. |
| `description` | One-line description shown to the LLM. Be specific about what the tool does and when to use it. |

### Optional fields

| Field | Purpose |
|-------|---------|
| `x-zod-body` | Zod schema for the request body (POST/PATCH). Enables the executor to split params by HTTP source. |
| `x-zod-query` | Zod schema for query string params (GET). |
| `x-zod-params` | Zod schema for path params. |
| `x-requires-permission` | System-level permission check in addition to the route's `preHandler`. Defaults to `[]`. |
| `x-read-only` | When `true`, tool is dispatched in Phase 1 (no confirmation dialog). Defaults to `false`. |
| `response` | Response schema. Use `successResponse()` for single objects, `paginatedResponse()` for arrays. Both set `additionalProperties: true` so Fastify won't strip undeclared fields. |

Without `x-zod-*` fields, all LLM params default to the request body.

**⚠️ `x-zod-params` is effectively mandatory on any route with path params.** The
catalog-builder uses it to mark keys as `x-source: 'path'`; without it the executor
sends `:id` / `:apiName` / `:version` in the body and the URL placeholder stays
literal, making the call 404 on the first try. Every tagged route that has
`:foo` in its URL needs `'x-zod-params': SomeParamsSchema`. Common reusable
schemas live in `@orm/shared/types/common.ts`:

- `UuidParamsSchema` — `{ id }`
- `ApiNameParamsSchema` — `{ apiName }`
- `ObjectApiNameParamsSchema` — `{ objectApiName }`
- `UuidAndObjectApiNameParamsSchema`, `ApiNameAndVersionParamsSchema`, `IdAndUserIdParamsSchema` — compound variants

Attach `x-zod-body` / `x-zod-query` for the same reason whenever the route has
those request shapes.

---

## Boot-Time Security Gate

The catalog builder (`core/ai/tool-catalog/catalog-builder.ts`) runs at server startup
and validates every route tagged `llm-tool`. Two guards fire:

**1. Auth exclusion check** — Any route on the auth exclusion list (`PUBLIC_PATHS`,
`AUTH_OPTIONAL_PATHS`) that is tagged `llm-tool` will **crash the server at boot**.
This is intentional. LLM-callable routes must be authenticated. If this fires, either:
- Remove `llm-tool` from the route's tags (the tool should not be agent-callable), or
- Move the route off the exclusion list (add proper `requireAuth` preHandler).

**2. Zod-shape validator** — Any `x-zod-body`, `x-zod-query`, or `x-zod-params` value
that is not a Zod schema (e.g., a plain JSON Schema object left accidentally) throws
at boot with the offending route and field name. Fix by replacing with a proper
`z.object({...})` schema.

Both checks run before the server accepts traffic — there is no "degraded mode" where
an insecure route silently becomes an agent tool.

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
produce categories that are NOT in `SKILL_CATEGORIES` — use the mapped equivalents
above instead. Fixed in #412 round 2 and #420; don't reintroduce.

**`mcp-exposed`** — Add this secondary tag to routes that should be visible to
external MCP clients (Claude Desktop, Cursor, IDEs). The `@orm/mcp` package's
`buildMcpToolsFromCatalog()` function filters on this tag. Example:

```typescript
tags: ['Data', 'llm-tool', 'mcp-exposed'],
```

The `mcp-exposed` route set is pinned by an explicit reviewed allowlist —
`packages/backend/src/__tests__/mcp-exposed.allowlist.ts`, enforced by
`mcp-exposed-allowlist.test.ts` (the single source of truth for the current
set; ~70 routes as of #1103). A route tagged `mcp-exposed` that is not on the
allowlist fails CI, and a stale allowlist entry fails CI too. **Adding a route
to the external MCP surface is a deliberate, reviewed change** — it expands the
platform's external attack surface. Do not tag admin/internal mutators
`mcp-exposed`; `update_agent` was removed from the surface in #1103 because it
can rewrite an in-platform agent's system prompt (a persistence vector from a
compromised external client).

**`composite`** — Informational tag on multi-step composite routes in
`domains/llm-composites/`. Does not change dispatch behavior.

---

## Composites (D3)

Some operations cannot be expressed as a single REST call: they require orchestrating
multiple API calls, or bridging schema impedance (e.g., wrapping a plain string as
`{ en: string }` for an i18n field). These live in `packages/backend/src/domains/llm-composites/`
as regular tagged Fastify routes.

**When to write a composite:**
- The operation requires 2+ API calls that must be sequenced or merged (e.g., GET-then-PATCH)
- The LLM sends a simpler input than the underlying API expects (i18n label wrapping)
- The operation is an orchestration (e.g., `batch_execute`, `preview_plan`)

**Composite route rules:**

```typescript
// packages/backend/src/domains/llm-composites/my-composite.routes.ts
import { forwardAuth } from '../../core/utils/forward-auth.js';
import { getAppInstance } from '../../core/app-instance.js';

app.post('/api/v1/llm/composites/my-composite', {
  schema: {
    tags: ['llm-tool', 'composite'],
    operationId: 'my_composite',
    description: 'Does X then Y, returning Z.',
    'x-zod-body': MyCompositeInputSchema,
    response: { 200: successResponse(MyCompositeOutputSchema) },
  },
  preHandler: [requireAuth],
}, async (request, reply) => {
  const headers = forwardAuth(request);  // MANDATORY — forwards caller's JWT
  const res = await getAppInstance().inject({
    method: 'GET',
    url: '/api/v1/...',
    headers,
  });
  // ...
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

The default composite pattern orchestrates via `app.inject()` only, which
inherits each target route's RBAC/FLS automatically. Some composites
genuinely need an aggregate or JOIN that no existing API exposes (e.g.
audit-log per-field rollups, cross-object record counts, flow_versions
JOINs). In those cases, `withTenant().readOnlyTransaction()` /
`.transaction()` / `.writeTransaction()` is allowed as a controlled
exception — but **each raw SQL read bypasses the route-level permission
gate that would normally protect that table**.

If a composite uses raw DB reads, you MUST:

1. **Enumerate the bypassed permissions** in a file-level comment at the
   top of the route plugin. Each direct-SQL table read gets a row with
   "normal route gate" and "this composite's gate."
2. **Set `'x-requires-permission'`** (and the matching `preHandler`
   `requireSystemPermission(...)` calls) to the **union** of every
   permission that would be required to read those tables via the
   corresponding route. Reviewer should be able to map each entry in
   the array to a row in the comment.
3. **Never loosen the route-level perm to lean on degraded-mode.**
   Degraded-mode is an `app.inject()` mechanism — sub-inject failures
   inherit the target route's RBAC and land in `degradedSources[]` on
   any non-2xx. Raw SQL reads are not routed through the inject stack
   and therefore bypass the route-level permission gates that would
   normally protect the table. Even when wrapped in `try/catch` that
   degrades query failures (e.g. statement_timeout) to
   `degradedSources[]`, a successful read returns data regardless of
   whether the caller has the equivalent route-level permission. The
   degradation path handles *query failures*, not *permission
   failures* — those still leak.

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
async function auditUnusedFieldsPlugin(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/llm/composites/audit-unused-fields', {
    schema: {
      // ...
      'x-requires-permission': [
        PERMISSIONS.VIEW_AUDIT_LOG,
        PERMISSIONS.VIEW_ALL_DATA,
        PERMISSIONS.MANAGE_AUTOMATION,
      ],
      // ...
    },
    preHandler: [
      requireAuth,
      requireSystemPermission(PERMISSIONS.VIEW_AUDIT_LOG),
      requireSystemPermission(PERMISSIONS.VIEW_ALL_DATA),
      requireSystemPermission(PERMISSIONS.MANAGE_AUTOMATION),
    ],
  }, /* handler */);
}
```

Precedent: PR #707 (issue #705). Round 9–10 cycle:
- R9: composite gated on `[VIEW_AUDIT_LOG, MANAGE_CUSTOM_OBJECTS]`.
- Initial post-merge fix dropped `MANAGE_CUSTOM_OBJECTS` to lean on
  degraded-mode — silently introduced a HIGH-severity RBAC bypass on
  the records + flow_versions direct reads.
- R10: Copilot caught it; fixed by gating on the full union of all
  three permissions that the bypassed routes would have required.

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

Current composite routes: `get_current_user`, `preview_plan`, `batch_execute`,
`describe_object_full`, `describe_schema`, `organize_layout`,
`parse_natural_language_query` (D3); `create_field`, `create_list_view`,
`delegate_to_agent`, `add_object_to_app`, `remove_object_from_app` (D6b+).
(#899 retired the 10 pure-i18n shim composites — `create_object`, `update_object`,
`update_field`, `create_layout`, `update_layout`, `create_validation_rule`,
`create_script`, `update_script`, `create_custom_page`, `update_list_view` — their
operationId + `llm-tool` tag now live on the canonical CRUD routes, which accept
plain-string labels via `LocalizedField()`. `create_field` and `create_list_view`
remain composites because they curate the schema / do a read-modify-write.)

---

## Frontend-Only Skills (D4)

Some "tools" produce UI directives rather than server-side results. They do not call
any API — they build a `FrontendActionPayload` directive the frontend interprets via
`useFrontendActionBridge.ts`. These are called **frontend skills**.

Frontend skills live in `packages/backend/src/core/ai/tool-catalog/frontend-skills/`
as `FrontendSkillDefinition` objects.

**When to write a frontend skill:**
- The action is UI-only (navigate to a page, open a dialog, fill a form field)
- No tenant data is read or written
- The operation makes no sense as a server call

**Creating a frontend skill:**

1. Create `core/ai/tool-catalog/frontend-skills/{api-name}.ts`
2. Export a `FrontendSkillDefinition` with `category: 'frontend'`
3. Implement a pure `buildDirective(params)` function — **no DB access, no service imports, no `withTenant`**
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
    properties: {
      path: { type: 'string', description: 'The URL path to navigate to' },
    },
    required: ['path'],
  },
  buildDirective(params) {
    return {
      __frontendAction: true,
      action: 'navigate',
      params: { path: params.path },
      description: `Navigating to ${params.path}`,
    };
  },
};
```

`buildDirective()` MUST be pure. The architecture test in `registry.test.ts` asserts
no frontend skill file imports domain services or accesses the DB.

Boot-time `assertNoFrontendSkillCollisions()` guards against name conflicts across all
three tool sources (D catalog, frontend registry, legacy).

Current frontend skills (6): `navigate_to_page`, `open_create_dialog`,
`fill_form_fields`, `toggle_edit_mode`, `change_list_view`, `show_toast`.

---

## Custom Tenant Skills

Tenants can create custom skills via the admin UI (`/admin/ai/skills`). Custom skills
are stored in the `agent_skills` table and have two handler types:

**Script-backed skills** (`executeScriptHandler` in `agent-skills.service.ts`):
The `platformApis` object passed to `executeScript()` uses `app.inject()` with a 30-second
user JWT. The full middleware stack runs (RBAC, FLS, Zod, audit). Triggers fire
normally since these are user-initiated operations.

**Flow-backed skills** (`executeFlowHandler`): Uses `flowService.manualRun()` directly
— system-level execution, no per-user context. The `modifyAllData` permission gate
(enforced in `resolveCustomSkill`) prevents privilege escalation. This is intentional;
do not convert to inject.

**Automation scripts (flow-steps, trigger-executor, actions.service.ts)**: Keep DIRECT
service calls with `skipFlowTrigger: true`. These are automation-context operations,
not user-initiated. Converting to inject removes the `skipFlowTrigger` guard and would
cause infinite flow execution loops.

Rule summary:
- `agent-skills.service.ts executeScriptHandler` → use `app.inject()` (user context)
- Flow-backed custom skills → keep `flowService.manualRun()` (system context)
- Automation/flow/trigger/action scripts → keep direct calls + `skipFlowTrigger: true`

---

## Registry API Endpoints as LLM Tools

Primitive type registries (flow steps, field types, layout components, etc.) expose
their metadata via endpoints tagged `llm-tool`. This means agents automatically
discover available types without any hand-written skill definitions:

- `GET /api/v1/admin/flow-step-types` → lists all flow step types with descriptions + configSchema
- `GET /api/v1/admin/flow-step-types/:apiName` → describes a single step type

These registry endpoints follow the same tagging rules as any other LLM tool route.
See `.claude/rules/registry.md` for the full pattern.

## System-prompt tool references must match the catalog (#723)

Every snake_case tool name referenced in an agent's system prompt — whether in
the per-agent `BUILTIN_AGENTS[i].systemPrompt` body or in a shared appended rule
(e.g. `VERIFY_AFTER_INVOKE_RULE` in `agent-definitions.service.ts`) — MUST exist
in the runtime tool catalog. The LLM treats the prompt as ground truth and will
call whatever it sees there. A typo or hallucinated tool name in the prompt is
how the model learns to fail (production conversation `fd85234d-…` repeatedly
called `describe_object`, which does not exist — the real composite is
`describe_object_full`).

Guards in place:

- **Arch test:** `packages/backend/src/__tests__/agent-prompts-vs-tool-catalog.test.ts`
  scans every builtin agent's seeded prompt (including all four shared
  rules) AND every context-builder file listed in `CONTEXT_BUILDER_FILES`
  (tenant / user / app / object / record / page context builders plus the
  registry at `core/ai/context/builtin-context-builders.ts`) for
  snake_case identifiers appearing in tool-invocation context (backticks
  or after `use`/`call`/`via`/`invoke`/`using`/`calling`/`invoking`).
  Each candidate must exist in the universe of harvested `operationId` /
  `apiName` strings. A typo fails CI.
- **Migration coupling:** because migration 098 inlined per-tenant prompts,
  the prompt-update flow is two-sided. Whenever you change BUILTIN_AGENTS or
  a shared rule, you must also (a) write a new numbered migration that
  rewrites the inlined prompts for the OLD canonical to the NEW canonical
  (idempotent strict-match, dollar-quoted with a bumped tag like
  `$admin_prompt_vN$`), and (b) extend the migration-drift test in
  `builtin-agents.test.ts` to validate that migration. The current
  drift-test target is migration 131 (chain: 098 → 105 → 106 → 108 → 131).
  - **WHERE-vs-SET continuity:** migration N's SET block IS migration
    (N+1)'s WHERE block. They MUST be byte-equal or the next migration
    no-ops for every tenant on the previous canonical. The test "migration
    N+1 WHERE block matches migration N SET block byte-for-byte" in
    `builtin-agents.test.ts` enforces this; replicate it for every new
    N → N+1 transition.
  - **Belt-and-suspenders, not duplicate:** `seedBuiltinAgents()` runs on
    every boot and overwrites `system_prompt` for `is_system=true` rows via
    its `onConflict … doUpdateSet`. The prompt-rewrite migrations
    (105/106/108/131) are
    functionally redundant after one boot cycle on the new code — they
    exist because they leave the DB in the new canonical state IMMEDIATELY
    after the migration runner, BEFORE the seed loop runs, which matters
    for a process that crashes between the two. Both paths must produce
    the same canonical; the drift test guarantees that.
  - **`data_analyst` (and future builtins) catch up via the seed loop.**
    Migrations 105/106/108/131 only target `api_name = 'admin_assistant'`. Other
    builtins' system prompts are NOT rewritten by migration; they update
    on the next boot via the seed-loop overwrite. Document the carve-out
    in the migration header comment if you add a new builtin.

When editing a system prompt or shared rule:

1. Grep the catalog (`grep -r "operationId: '<name>'" packages/backend/src`)
   before referencing a tool name you didn't just verify.
2. Reword to fit existing tool names rather than invent shorthand.
3. Run the arch test locally: `pnpm --filter @orm/backend test
   src/__tests__/agent-prompts-vs-tool-catalog.test.ts`.

### Semantic-claim verification: prompt claims must match the runtime contract

Catalog symbol existence is necessary but NOT sufficient. A prompt may
reference a real tool name and still mis-describe what that tool does —
the same dimension-5 mistake #715 fixed at the field-example level.

Pass-1 audit of #723 caught this in the first FLOW_VERSIONING_RULE:
the rule claimed `update_flow` "creates a new ACTIVE version". The route
exists (`update_flow`), so the symbol-existence arch test passed — but
the SERVICE method strips `steps`/`inputs` and only updates header
columns. An agent following the rule would call `update_flow` with new
steps, see a 200 response that doesn't reflect the change, and loop on
VERIFY_AFTER_MUTATE_RULE.

When editing a rule that asserts runtime behavior:

1. Open the SERVICE method the rule names (e.g. `flow.service.ts:update`)
   and confirm the verbs in the rule match what the method actually does.
2. Open the ROUTE description for the same operationId — if the route's
   own description and the rule disagree, fix one. They MUST agree.
3. If the rule's recommended workflow involves multiple tools, every
   tool in that workflow MUST be `llm-tool`-tagged. A rule that says
   "use X then Y" while Y is missing from the catalog leaves the agent
   stranded — symptomatically equivalent to a hallucinated tool name.
4. Add (or extend) an integration regression test that walks the
   prompt's recommended sequence end-to-end. If the test fails, the
   rule is wrong; if it passes, the rule's claims are runtime-verified.
   For #723 this lives at
   `packages/backend/src/domains/automation/flows/flow-version-edit-sequence.integration.test.ts`.

## Anti-Patterns

**Do not write `ApiSkillDefinition` entries.** The `ApiSkillDefinition` interface and
`api-skill-executor.ts` were deleted in D6. The `builtins/*.ts` skill files are all
deleted. The `registry.ts` skill registry is effectively empty. If you find yourself
writing `{ apiName, api: { method, pathTemplate } }`, stop — tag the route instead.

**Do not bypass `requireAuth`.** Every LLM-callable route must have `requireAuth` in
its `preHandler` array. The boot-time security gate will crash the server if you tag
a route on the auth exclusion list, but a custom preHandler that "looks like auth" but
isn't will pass the boot check and create a silent security hole.

**Do not tag routes the agent should not call.** Not every route needs to be a tool.
Internal routes, admin-only routes, and routes with destructive side-effects should be
tagged only after deliberate review. `llm-tool` is opt-in for a reason.

**Do not embed business logic in the catalog builder.** `catalog-builder.ts` is a pure
traversal of the route registry — it derives JSON Schema from `x-zod-*` extensions and
collects metadata. It must never make DB calls, import services, or run user code.

**Do not add `mcp-exposed` indiscriminately.** The MCP surface is external-facing.
Only tag routes where external clients (Claude Desktop, Cursor, IDEs) have a genuine
need. Over-exposing increases the attack surface.
