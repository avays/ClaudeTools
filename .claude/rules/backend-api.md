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

When a service in this codebase fetches data from another service (the
registry, an OAuth provider, an integration API, an inbound webhook body we
verify against a provider schema, etc.), a schema mismatch is an **upstream
bug**, not a caller-input validation failure. The global error handler maps
raw `ZodError` → 400, which is wrong for upstream data.

**Rule:** any `.parse()` of data returned by `fetch()` / `app.inject()` / a
non-user source MUST use `safeParse` + a typed `PlatformError` with
`statusCode: 502`. Use a stable, greppable `UPSTREAM_X_INVALID` code.

```ts
// WRONG — ZodError → 400 Validation Error for the CALLER
const manifest = PackageManifestSchema.parse(bodyFromRegistry);

// RIGHT — schema mismatch on upstream data → 502 with a stable code
const parsed = PackageManifestSchema.safeParse(bodyFromRegistry);
if (!parsed.success) {
  throw new PlatformError(
    'REGISTRY_MANIFEST_INVALID',
    `Registry returned invalid manifest for ${name}@${version}`,
    502,
  );
}
const manifest = parsed.data;
```

Companion pattern for network failures (connection refused, DNS, timeout):
catch around the `fetch()` and rethrow `PlatformError('UPSTREAM_X_UNREACHABLE',
..., 502)`. Precedents: `packages/backend/src/core/registry-client.ts`
(`REGISTRY_UNREACHABLE`, `REGISTRY_ERROR`, `REGISTRY_MANIFEST_INVALID`,
`REGISTRY_BUNDLE_INVALID`).

This is separate from the user-input validation path where `.parse()` on
`request.body` / `request.query` / `request.params` is correct (those SHOULD
become 400).

## Response Envelope
- Success: `{ data, meta }` — use `buildResponse(data, meta?)`
- Error: `{ error: { code, message, details } }` — automatic from PlatformError
- Pagination meta: `buildPaginationMeta(page, pageSize, total)`

## Input Parsing
- Parse body with Zod: `Schema.parse(request.body)`
- Parse query with Zod: `Schema.parse(request.query)` — **never** `request.query as any` or `request.query as { ... }`
- Params: cast with `as { paramName: string }`
- Tenant: always `request.tenantId` (set by middleware)

**Query params must always be Zod-parsed.** Every `request.query` access in a route
handler MUST use `Schema.parse(request.query)` — no `as` casts. This ensures invalid
types and coercion failures (e.g. `page=abc`, out-of-range `pageSize`, wrong-shape
values) return a clean 400 instead of silently coercing or failing downstream. Note
that Zod is non-strict by default: unknown query keys are stripped, not rejected.
If a route needs to reject unknown keys it must opt in via `.strict()`. An
architecture test in `core/route-query-cast.test.ts` enforces this rule and will
fail CI if a cast is reintroduced. Reusable schemas: `PaginationQuerySchema`,
`ObjectApiNameFilterQuerySchema`, `FieldApiNameQuerySchema`, `NamespaceQuerySchema`,
`WebhookLogQuerySchema` (all from `@orm/shared`).

## LLM Tool Exposure (Architecture D)

Any authenticated Fastify route can be exposed to AI agents as an LLM tool by adding
two fields to its `schema` block:

```typescript
app.get('/api/v1/some/route', {
  schema: {
    operationId: 'unique_snake_case_name',    // ← unique across ALL routes
    tags: ['Category', 'llm-tool'],           // ← 'llm-tool' triggers auto-discovery
    summary: 'Description shown to the LLM',
    // Attach Zod schemas so the catalog builder can derive the input schema:
    'x-zod-body':   CreateThingSchema,        // optional — for POST/PATCH body
    'x-zod-query':  ListQuerySchema,          // optional — for GET query params
    'x-zod-params': ApiNameParamsSchema,      // optional — for path params
    'x-requires-permission': [],              // optional — system perm guard (default: [])
  },
}, handler);
```

**Rules:**
1. `operationId` MUST be globally unique — duplicate operationIds throw at boot.
2. `tags` MUST include `'llm-tool'` for auto-discovery.
3. Routes on the auth exclusion list (`PUBLIC_PATHS`, `AUTH_OPTIONAL_PATHS`) will be
   **rejected at boot** with an error — the server will not start. This is intentional.
4. Attach `x-zod-body`, `x-zod-query`, `x-zod-params` to enable the executor to split
   parameters by HTTP source (body / query / path). Without them, all params default to body.
5. Do NOT add a legacy `ApiSkillDefinition` entry for the same `operationId` — the collision
   check in `buildToolCatalog` will throw at boot.
6. Prefer `successResponse()` / `paginatedResponse()` from `core/utils/openapi-helpers.ts`
   for the `response` schema — these include `additionalProperties: true` so Fastify won't
   strip fields from responses that aren't explicitly declared in the JSON Schema.

## Composite Routes (Architecture D3)

Multi-step operations that internally orchestrate several API calls live in
`packages/backend/src/domains/llm-composites/`. They are regular tagged routes
with the secondary tag `'composite'`:

```typescript
app.post('/api/v1/llm/composites/my-composite', {
  schema: {
    tags: ['llm-tool', 'composite'],
    operationId: 'my_composite',
    // ... x-zod-body etc.
  },
}, async (request) => {
  const headers = forwardAuth(request);  // ALWAYS use this — never construct headers manually
  const res = await getAppInstance().inject({ method: 'GET', url: '/api/v1/...', headers });
  // ...
});
```

**Composite rules:**
- ALWAYS use `forwardAuth(req)` from `core/utils/forward-auth.ts` for sub-injects
- ALWAYS use `getAppInstance().inject()` (not `app.inject()` inside a plugin)
- NEVER import `signSkillToken` in a composite route file
- NEVER import domain services — orchestrate via inject only
- The `'composite'` tag is informational; it does NOT change dispatch behavior

## MCP Exposure (Architecture D7)

By default, routes tagged `llm-tool` are visible **only** to the in-platform agent — they
are NOT automatically exposed to external MCP clients (Claude Desktop, IDEs, third parties).

To additionally expose a route to external MCP clients, add the secondary tag `mcp-exposed`:

```typescript
app.get('/api/v1/some/route', {
  schema: {
    operationId: 'unique_snake_case_name',
    tags: ['Category', 'llm-tool', 'mcp-exposed'],  // ← mcp-exposed opts into MCP
    summary: 'Description shown to external MCP clients',
    // ... x-zod-* etc.
  },
}, handler);
```

**Rules:**
1. A route MUST also have `'llm-tool'` — `mcp-exposed` alone is ignored.
2. `mcp-exposed` adds the route to the external MCP server's tool list via
   `filterMcpExposed(catalog)` in `packages/mcp/src/catalog-sync.ts`.
3. Use `mcp-exposed` only for routes appropriate for external clients. Internal-only
   operations (e.g., `delegate_to_agent`, admin-only operations) should NOT be tagged.
4. Keep `mcp-exposed` usage intentional and audited. Existing exposed routes
   (including the containers read-only enumeration routes, data + composite
   routes tagged during phase 1, etc.) must stay appropriate for external
   MCP clients; new ones should be tagged only after the same review. A
   route's MCP exposure is part of the platform's external attack surface —
   treat additions like a public-API change.

## Record Access Checks (polymorphic record routes)

Any route or service operation that accepts `{recordObjectApiName, recordId}`
on behalf of a caller MUST verify the caller can actually read that record
before returning or mutating anything that references it. RBAC + FLS are
enforced on the records domain via `dataService.getRecord()` — it throws
on missing access. Call it up-front as the gate.

```typescript
import { getUserContext } from '../../core/utils/request-helpers.js';

// Route handler
app.post('/api/v1/containers/:id/links', { /* schema */ }, async (request, reply) => {
  const input = LinkRecordSchema.parse(request.body);
  // Access check — throws on missing read access (RBAC/FLS enforced).
  const { dataService } = await import('../data/data.service.js');
  await dataService.getRecord(
    request.tenantId,
    input.recordObjectApiName,
    input.recordId,
    getUserContext(request),
  );
  // Only now perform the cross-record association mutation.
  await containersService.linkRecord(request.tenantId, id, input, request.userId);
});
```

**Why** — without this gate a caller can create, list, or summarize
associations for records they have no access to, leaking cross-record
relationships. For link-style operations that atomically demote an existing
`primary` (container primary, owner, approver, etc.), the bypass lets the
caller mutate another record's canonical state.

**When to apply:**
- Any route that accepts `recordObjectApiName + recordId` in the body,
  query, or params (container links, share targets, audit attachments).
- Any service method that takes the same pair when invoked from a user
  context — including indirect paths like an auto-created container that
  links to an uploaded file's target record.
- When a system-internal code path (cron, worker, inter-service call)
  lacks a `UserContext`, **skip the association rather than mutate
  blindly**. Log a warning and rely on an explicit follow-up.

**Exceptions:**
- Platform-admin routes under `/api/v1/platform/*` — cross-tenant by design.
- Routes the caller obviously owns (their own user row, their own API key).

Precedents: PR #485 rounds 1–2 — three route-level bypasses (link, list,
summary) plus one service-layer bypass in `files.service.ts` upload, all
caught by Copilot.

## Registry Endpoints

Primitive type registries (flow steps, field types, layout components, etc.) expose
their entries via standard endpoints tagged `llm-tool`:

- `GET /api/v1/admin/{primitive}-types` — list all metadata (no runtime functions)
- `GET /api/v1/admin/{primitive}-types/:apiName` — describe one

See `.claude/rules/registry.md` for the full registry pattern, endpoint template, and
anti-patterns (no switch statements, no Redis caching, never serialize `execute`).

## Frontend-only skills (Architecture D4)

Skills that return UI directives (not server-side results) live in
`core/ai/tool-catalog/frontend-skills/` as `FrontendSkillDefinition` objects.
See `.claude/rules/agent-skills.md` "Frontend-only skills (D4)" for the full pattern.

## Permissions registry (#537)

Every system permission referenced in `requireSystemPermission(...)` or
`'x-requires-permission'` arrays MUST come from `PERMISSIONS` in
`@orm/shared`. The architecture test `permissions-registry.test.ts` rejects
bare camelCase string literals — both inside `requireSystemPermission()`
calls and anywhere in `'x-requires-permission'` array bodies (any
position, not just the first element).

```ts
import { PERMISSIONS } from '@orm/shared';

app.post('/api/v1/admin/users', {
  schema: {
    tags: ['Admin', 'llm-tool'],
    operationId: 'create_user',
    summary: 'Create a new user',
    'x-requires-permission': [PERMISSIONS.MANAGE_USERS],
  },
  preHandler: [requireAuth, requireSystemPermission(PERMISSIONS.MANAGE_USERS)],
}, handler);
```

Adding a new permission:

1. Add the entry to `packages/shared/src/constants/permissions.ts`
   (SCREAMING_SNAKE name, camelCase value).
2. `pnpm --filter @orm/shared build`.
3. Reference it as `PERMISSIONS.YOUR_NEW_PERM` at the call site. Multi-
   element arrays (`'x-requires-permission'`: `[PERMISSIONS.A, PERMISSIONS.B]`)
   are scanned end-to-end — every element must be a registered constant.

The frontend permission-set editor and AI tool-catalog filter both consume
the same registry, so a missing entry surfaces immediately (UI selector
omits the permission; agent-side tool gets filtered out).
