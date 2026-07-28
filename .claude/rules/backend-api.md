---
globs:
  - "packages/backend/src/domains/**/*.routes.ts"
---

# API Route Conventions

## URL Structure
- All routes under `/api/v1/` prefix
- Admin/metadata: `/api/v1/metadata/...`, `/api/v1/admin/...`
- Data CRUD: `/api/v1/data/:objectApiName/...`

## Route Handler Pattern
```typescript
app.post('/api/v1/...', {
  schema: { tags: ['TagName'], summary: 'Description' },
}, async (request, reply) => {
  const input = SomeSchema.parse(request.body);  // Zod validation
  const result = await someService.method(request.tenantId, ...);
  reply.code(201);  // Only for POST
  return buildResponse(result);
});
```

## Status Codes
- `200` — GET, PATCH (success with body)
- `201` — POST (created, with body)
- `204` — DELETE (no body)
- `400` — Validation errors (automatic via error handler)
- `404` — Not found (automatic via NotFoundError)
- `409` — Conflict / locked record
- `502` — Upstream service returned invalid or unreachable (see "Upstream Data" below)

## Upstream Data — always 502, never 400

Data from another service (the registry, an OAuth provider, an integration
API, an inbound webhook body verified against a provider schema) that fails
schema validation is an **upstream bug**, not caller input — but the global
error handler maps a raw `ZodError` → 400. **Rule:** any `.parse()` of data
returned by `fetch()` / `app.inject()` / a non-user source MUST use
`safeParse` + a typed `PlatformError` with `statusCode: 502` and a stable,
greppable `UPSTREAM_X_INVALID` code.

```ts
// Trap: PackageManifestSchema.parse(bodyFromRegistry) throws ZodError → the
// CALLER gets a 400 Validation Error for an upstream defect. Use safeParse:
const parsed = PackageManifestSchema.safeParse(bodyFromRegistry);
if (!parsed.success) {
  throw new PlatformError('REGISTRY_MANIFEST_INVALID',
    `Registry returned invalid manifest for ${name}@${version}`, 502);
}
const manifest = parsed.data;
```

- Network failures (connection refused, DNS, timeout): catch around the
  `fetch()` and rethrow `PlatformError('UPSTREAM_X_UNREACHABLE', ..., 502)`.
- Precedents: `packages/backend/src/core/registry-client.ts` —
  `REGISTRY_UNREACHABLE`, `REGISTRY_ERROR`, `REGISTRY_MANIFEST_INVALID`,
  `REGISTRY_BUNDLE_INVALID`.
- Separate from the user-input path: `.parse()` on `request.body` /
  `request.query` / `request.params` is correct there and SHOULD become 400.

## Response Envelope
- Success: `{ data, meta }` — use `buildResponse(data, meta?)`
- Error: `{ error: { code, message, details } }` — automatic from PlatformError
- Pagination meta: `buildPaginationMeta(page, pageSize, total)`

## Input Parsing
- Body: `Schema.parse(request.body)`. Params: cast `as { paramName: string }`.
- Tenant: always `request.tenantId` (set by middleware) — **except under
  `/api/v1/platform-admin/*`, see below**.
- **Query params must always be Zod-parsed:** `Schema.parse(request.query)` —
  **never** `request.query as any` or `request.query as { ... }`. Casts let
  invalid types and coercion failures (`page=abc`, out-of-range `pageSize`,
  wrong-shape values) coerce silently or fail downstream instead of returning
  a clean 400. The architecture test `core/route-query-cast.test.ts` fails CI
  if a cast is reintroduced.
- Zod is non-strict by default: unknown query keys are stripped, not rejected;
  a route that must reject them opts in via `.strict()`.
- Reusable query schemas (from `@orm/shared`): `PaginationQuerySchema`,
  `ObjectApiNameFilterQuerySchema`, `FieldApiNameQuerySchema`,
  `NamespaceQuerySchema`, `WebhookLogQuerySchema`.

### `request.tenantId` is always `''` under `/api/v1/platform-admin/*` (#1162)

Mechanism: `tenant-resolution.ts` lists `/api/v1/platform-admin/` in
`PUBLIC_PATHS` (tenant resolution skipped for the whole prefix), and
`middleware/auth.ts`'s JWT branch assigns `request.tenantId` ONLY when
`claims.tid === null` (setting `''`) — the non-null `tid` branch only
*compares*, never assigns. So every request under the prefix — dedicated
`platform_admins` accounts (`tid: null`) and tenant-scoped
`users.is_super_admin` accounts alike — has `request.tenantId === ''`; there
is no "admin's own tenant" on the request. Two consequences:

- **Never write a self-referential guard** (`targetId === request.tenantId`)
  expecting it to catch "the caller acting on their own tenant" — it can never
  fire, because a real tenant UUID never equals `''`. Gate on a designated
  id/slug read from config instead.
- **`logAudit(request, ...)` (see `{{PATHS_RULES_DIR}}/backend-general.md`
  "Provenance columns") cannot persist an `audit_logs` row here** — `''` would
  queue a row for `withTenant('').transaction()`, an invalid-UUID cast on
  `SET LOCAL app.current_tenant_id`. Since #1162 the helper instead emits a
  structured `request.log.info` line (category/entity/action/userId/ip, no
  `details`) when `request.tenantId === ''`, and warns when tenantId is
  genuinely undefined. Calling it is therefore safe (log-based signal); for
  richer context (e.g. a purge's row counts) add an explicit `logger.warn(...)`
  in the service with the target tenant id, or use `withoutTenant` / a
  non-tenant-scoped audit table when a durable DB record is required.

Precedent: `{{PATHS_SPECS_DIR}}/tenant-purge-delete-cascade.md` spec-audit r1 (HIGH) — a drafted
`TENANT_PURGE_SELF` guard and its `logAudit()`-based audit-trail claim were
both dead on arrival for this reason.

## LLM Tool Exposure (Architecture D)

Any authenticated Fastify route becomes an agent tool by tagging its `schema`
block. Full pattern: `{{PATHS_RULES_DIR}}/agent-skills.md`.

```typescript
app.get('/api/v1/some/route', {
  schema: {
    operationId: 'unique_snake_case_name',    // ← unique across ALL routes
    tags: ['Category', 'llm-tool'],           // ← 'llm-tool' triggers auto-discovery
    summary: 'Description shown to the LLM',
    // x-zod-* is what the catalog builder derives the tool's input schema from:
    'x-zod-body':   CreateThingSchema,        // optional — POST/PATCH body
    'x-zod-query':  ListQuerySchema,          // optional — GET query params
    'x-zod-params': ApiNameParamsSchema,      // optional — path params
    'x-requires-permission': [],              // optional — system perm guard (default: [])
  },
}, handler);
```

**Rules:**
1. `operationId` MUST be globally unique — duplicates throw at boot.
2. `tags` MUST include `'llm-tool'` for auto-discovery.
3. A tagged route on the auth exclusion list (`PUBLIC_PATHS`,
   `AUTH_OPTIONAL_PATHS`) is **rejected at boot** — the server will not start.
   Intentional.
4. Attach `x-zod-body` / `x-zod-query` / `x-zod-params` so the executor splits
   params by HTTP source; without them all params default to body.
5. Do NOT add a legacy `ApiSkillDefinition` entry for the same `operationId` —
   `buildToolCatalog`'s collision check throws at boot.
6. Prefer `successResponse()` / `paginatedResponse()` from
   `core/utils/openapi-helpers.ts` for `response` — they set
   `additionalProperties: true` so Fastify won't strip undeclared fields.

## Composite Routes (Architecture D3)

Multi-step operations orchestrating several API calls live in
`packages/backend/src/domains/llm-composites/`, as tagged routes carrying the
secondary tag `'composite'`:

```typescript
app.post('/api/v1/llm/composites/my-composite', {
  schema: { tags: ['llm-tool', 'composite'], operationId: 'my_composite' /* + x-zod-body etc. */ },
}, async (request) => {
  const headers = forwardAuth(request);  // ALWAYS — never construct auth headers manually
  const res = await getAppInstance().inject({ method: 'GET', url: '/api/v1/...', headers });
});
```

- ALWAYS `forwardAuth(req)` from `core/utils/forward-auth.ts` for sub-injects
- ALWAYS `getAppInstance().inject()` (not `app.inject()` inside a plugin)
- NEVER import `signSkillToken` in a composite route file
- NEVER import domain services — orchestrate via inject only
- The `'composite'` tag is informational; it does NOT change dispatch behavior

## MCP Exposure (Architecture D7)

`llm-tool` routes are visible **only** to the in-platform agent — NOT to
external MCP clients (Claude Desktop, IDEs, third parties). The secondary tag
`mcp-exposed` opts a route into that external surface:

```typescript
tags: ['Category', 'llm-tool', 'mcp-exposed'],  // same schema block as above
```

**Rules:**
1. A route MUST also have `'llm-tool'` — `mcp-exposed` alone is ignored.
2. `mcp-exposed` adds the route to the external MCP server's tool list via
   `filterMcpExposed(catalog)` in `packages/mcp/src/catalog-sync.ts`.
3. Tag only routes appropriate for external clients; internal-only operations
   (e.g. `delegate_to_agent`, admin-only operations) should NOT be tagged.
4. Keep `mcp-exposed` usage intentional and audited: already-exposed routes (containers
   read-only enumeration, data + composite routes tagged in phase 1, …) must
   stay appropriate, and new ones are tagged only after the same review — MCP
   exposure is external attack surface, so treat additions like a public-API
   change.

## Record Access Checks (polymorphic record routes)

Any route or service operation accepting `{recordObjectApiName, recordId}` on
behalf of a caller MUST verify the caller can read that record before
returning or mutating anything that references it. `dataService.getRecord()`
enforces RBAC + FLS and throws on missing access — call it up-front as the
gate:

```typescript
import { getUserContext } from '../../core/utils/request-helpers.js';

// Route handler, after parsing input (parse → gate → mutate, in that order):
const input = LinkRecordSchema.parse(request.body);
// Lazy dynamic import — avoids a module cycle with the data domain.
const { dataService } = await import('../data/data.service.js');
// Access check — throws on missing read access (RBAC/FLS enforced).
await dataService.getRecord(
  request.tenantId, input.recordObjectApiName, input.recordId, getUserContext(request),
);
// Only now perform the cross-record association mutation.
await containersService.linkRecord(request.tenantId, id, input, request.userId);
```

Without it a caller can create, list, or summarize associations for records
they cannot access (leaking cross-record relationships) and, on link-style operations that
atomically demote an existing `primary` (container primary, owner, approver),
mutate another record's canonical state.

**When to apply:**
- Any route taking `recordObjectApiName + recordId` in body, query, or params
  (container links, share targets, audit attachments).
- Any service method taking the same pair from a user context — including
  indirect paths, e.g. an auto-created container linking an uploaded file's
  target record.
- When a system-internal path (cron, worker, inter-service call) lacks a
  `UserContext`, **skip the association rather than mutate blindly** — log a
  warning and rely on an explicit follow-up.

**Exceptions:** platform-admin routes under `/api/v1/platform/*` (cross-tenant
by design); routes the caller obviously owns (own user row, own API key).

Precedents: PR #485 r1–2 — three route-level bypasses (link, list, summary) +
a service-layer bypass in `files.service.ts` upload, all caught by Copilot.

## Child-resource list routes must filter by the child's own owner, not just the parent's

When a child resource carries its own ownership field (`created_by_user_id`,
`owner_id`) DISTINCT from the parent's owner (a plan's creator vs. the
conversation's owner), a route that authorizes on the parent alone and then
returns ALL of that parent's children discloses another user's child content —
the list-route shape of the same IDOR class the single-resource ownership
check (#1103's plan-ownership fix) already closes.

```ts
// WRONG — verifies the caller owns the conversation, then returns every
// plan attached to it regardless of who created each plan
await conversationsService.get(tenantId, userId, conversationId);
const plans = await plansRepository.listByConversation(tenantId, conversationId);

// RIGHT — parent-ownership check gates access to the conversation itself;
// the child query ALSO filters by the child's own owner field
await conversationsService.get(tenantId, userId, conversationId);
const plans = await plansRepository.listByConversationAndOwner(tenantId, conversationId, userId);
```

**When to apply:** any new list/history/enumerate route for a resource with
its own `created_by_user_id`/`owner_id`-style column, nested under a parent
the caller merely has to own or access. Grep the resource's existing
single-item read/write routes for an ownership filter first — if a sibling
single-item route filters by owner, the list route MUST apply the identical
filter, not just the parent's access check.

Precedent: PR #1196 (#1186) — `list_conversation_plans` gated only on
conversation ownership and returned plans purely by `conversation_id`;
Copilot flagged it as weakening the #1103 plan-ownership model, fixed with a
`created_by_user_id = request.userId` filter on the repository query.

## Registry Endpoints

Primitive type registries (flow steps, field types, layout components, …)
expose their entries via endpoints tagged `llm-tool`:
`GET /api/v1/admin/{primitive}-types` (list all metadata, no runtime
functions) and `GET /api/v1/admin/{primitive}-types/:apiName` (describe one).
Full pattern, endpoint template, and anti-patterns (no switch statements, no
Redis caching, never serialize `execute`): `{{PATHS_RULES_DIR}}/registry.md`.

## Frontend-only skills (Architecture D4)

Skills that return UI directives (not server-side results) live in
`core/ai/tool-catalog/frontend-skills/` as `FrontendSkillDefinition` objects.
See `{{PATHS_RULES_DIR}}/agent-skills.md` "Frontend-only skills (D4)".

## Permissions registry (#537)

Every system permission in `requireSystemPermission(...)` or
`'x-requires-permission'` MUST come from `PERMISSIONS` in `@orm/shared`. The
architecture test `permissions-registry.test.ts` rejects bare camelCase
literals — inside `requireSystemPermission()` calls AND anywhere in an
`'x-requires-permission'` array body: multi-element arrays are scanned
end-to-end, so every element must be a registered constant, not just the first.

```ts
import { PERMISSIONS } from '@orm/shared';

app.post('/api/v1/admin/users', {
  schema: {
    tags: ['Admin', 'llm-tool'],
    operationId: 'create_user',
    'x-requires-permission': [PERMISSIONS.MANAGE_USERS],
  },
  preHandler: [requireAuth, requireSystemPermission(PERMISSIONS.MANAGE_USERS)],
}, handler);
```

Adding one: (1) add the entry to `packages/shared/src/constants/permissions.ts`
(SCREAMING_SNAKE name, camelCase value); (2) `{{PKG_BUILD}}`;
(3) reference it as `PERMISSIONS.YOUR_NEW_PERM`. The frontend permission-set
editor and the AI tool-catalog filter consume the same registry, so a missing
entry surfaces immediately (UI selector omits it; agent tool filtered out).

## Public / unauthenticated endpoints — sweep the rate-limit allowList, not just the auth exclusion list

A new **public, unauthenticated endpoint** (provider webhook-ingest, a
compliance/challenge-response endpoint) MUST be reconciled with TWO app-wide
exclusion mechanisms, not one: the auth/tenant exclusion path (`PUBLIC_PATHS`
in `tenant-resolution.ts`) — the obvious half — AND the **rate-limit plugin's
`allowList`** (`packages/backend/src/plugins/rate-limit.ts`), which applies
app-wide and defaults unauthenticated / no-tenant traffic to 100 req/min keyed
by `anon:<ip>`. Miss it and a signature-verified provider shares that bucket
with every anonymous caller and hits legitimate 429s — and providers (eBay,
GitHub, …) commonly treat any non-2xx as a delivery failure, flagging the
endpoint. If the
precedent you copied (`/api/v1/repositories/webhooks/`) is in the allowList
with a "routes are HMAC-verified" justification, the new endpoint needs the
same entry — or the spec must state explicitly why it should NOT be exempted.
Two correctness details on the entry itself:

1. **Match the exact path, not a `startsWith` prefix.**
   `request.url.startsWith('/api/v1/x/account-deletion')` also exempts
   `…/account-deletion-foo` — broader than intended. Use the exact-match form
   (`cleanUrl === '/api/v1/…'`, mirroring the auth-side `PUBLIC_PATHS_EXACT`
   convention) unless the precedent's trailing-slash-prefix semantics are
   deliberately wanted.
2. **The justification comment must be per-verb accurate.** One exempted
   prefix often carries an authenticated POST (signature-verified) AND an
   intentionally-open GET (a challenge handshake with no prior verification by
   protocol design). Never write a blanket "signature-verified" comment
   implying uniform protection — say which verb is verified, which is
   open-by-design.

Precedent: PR #1229 (#1215) — the eBay account-deletion endpoint's `allowList`
entry was missing from the spec's exclusion-file list (spec-audit sonnet r1
HIGH), then shipped with a `startsWith` prefix (code-audit sonnet r3 LOW) and
a blanket "signature-verified" comment over an open-by-design GET (spec-audit
sonnet r3 LOW).
