---
globs:
  - "packages/backend/src/core/db.ts"
  - "packages/backend/src/domains/**/*.repository.ts"
  - "migrations/**"
---

# Database & Kysely Conventions

## Case Convention
- DB columns: `snake_case`
- API fields: `camelCase`
- Conversion at repository boundary via `snakeToCamelObject()` / manual mapping

## Tenant Isolation (Critical)
- Every tenant-scoped table MUST have `tenant_id UUID NOT NULL REFERENCES tenants(id)`
- Every tenant-scoped table MUST have RLS enabled + `tenant_isolation` policy
- **#543: every `tenant_isolation` policy uses `current_setting('app.current_tenant_id')::uuid`
  WITHOUT `missing_ok=true`.** When the var is unset, the policy raises rather than
  silently filtering rows. Every query path MUST first open one of the three
  transaction helpers (which run `SET LOCAL app.current_tenant_id`) before
  touching a tenant-scoped table.
- INSERT must explicitly include `tenant_id` in values (the transaction helpers'
  `trx.insertInto()` does NOT auto-inject the column).
- All transactions set `SET LOCAL app.current_tenant_id` so RLS sees the tenant.

### Five canonical DB access helpers (#543, #555)

| Helper | When to use | RLS context | Tx slot |
|--------|-------------|-------------|---------|
| `withTenant(tenantId).transaction(fn)` | Writes, JOIN queries (Pattern A), check-then-write, mixed read/write methods | SET via SET LOCAL | Yes (200/tenant default; circuit-breaker) |
| `withTenant(tenantId).readOnlyTransaction(fn)` | Reads (the default for getX/listX) — hot-path safe | SET via SET LOCAL | **No** — bypasses slot |
| `withTenant(tenantId).writeTransaction(fn)` | Narrow hot-path writes (autonumber upsert) — explicit slot opt-out, SQL guarantees correctness | SET via SET LOCAL | **No** — bypasses slot |
| `withoutTenant` | Non-tenant-scoped tables (tenants, platform_admins, migrations), cross-tenant background jobs | None (tables have no RLS) | No |
| `withAdmin()` | **Sharp tool — gated by `WITH_ADMIN_ALLOWLIST`.** Pre-tenant-context auth lookups, super-admin console reads, cross-tenant maintenance crons | **BYPASSRLS** (separate `pg.Pool` against `orm_admin`) | Separate pool (max 5) |

**The pre-#543 `withTenant().{selectFrom,insertInto,updateTable,deleteFrom}`
shims were removed from `TenantScopedDb` in #545 — typecheck now enforces the
rule structurally; the architecture test in `no-raw-db-in-repos.test.ts` is
defense-in-depth.** Use `transaction()` / `readOnlyTransaction()` /
`writeTransaction()` exclusively. Inside any of the three transaction helpers,
callers use `trx.selectFrom(...)` (auto-`WHERE tenant_id`) or
`trx.raw.selectFrom(...)` (no auto-injection, for JOINs that need per-table
predicates).

**`readOnlyTransaction`** — sets `SET LOCAL transaction_read_only = true` + `SET LOCAL app.current_tenant_id` but does NOT acquire a transaction slot. Safe for hot-path reads (called per-record, per-request). RLS is fully active. Returns the same `TenantScopedTrx` interface; use `trx.raw.selectFrom(...)`. Resolves #542.

**`writeTransaction`** — sets `SET LOCAL app.current_tenant_id` but does NOT acquire a transaction slot. Allows writes. Use ONLY for narrow single-row hot-path operations whose correctness is guaranteed by the SQL itself: an ON CONFLICT upsert on a partial unique index that includes `tenant_id` (the canonical case — e.g. autonumber sequence increment per-record-create), OR any single-statement single-row write whose tenant-correctness is SQL-guaranteed — an INSERT with explicit `tenant_id` in VALUES, or a PK-scoped UPDATE where RLS confines the row to the tenant (e.g. per-call integration execution logging, #1010). The regular `.transaction()` remains the default for all other writes. Callers MUST keep work tight: one indexed upsert / update / insert, no cross-table logic, no long loops. Misuse would let a runaway tenant saturate the pool without the per-tenant slot backpressure.

**`withoutTenant`** — direct pass-through to the raw `db` instance. No `SET LOCAL`, no auto-injected WHERE. Use for tables without `tenant_id` (`tenants`, `platform_admins`, `platform_admin_mfa_secrets`, `tool_embeddings`) and background cron jobs that read across all tenants. Never use in a user-request handler.

**`withAdmin()`** (#555) — opens a separate `pg.Pool` (max 5) against the
`orm_admin` role (NOSUPERUSER **BYPASSRLS**) using `ADMIN_DATABASE_URL`. The
pool is BYPASSRLS by design: every RLS policy on every table is bypassed —
including `tenant_isolation`. Treat as the platform's `eval()` equivalent.

**When to use:**
- Pre-tenant-context lookups where the lookup IS what determines the tenant
  (bearer-token API key lookup, OAuth client_credentials grant lookup).
- Super-admin console reads aggregating across all tenants by design
  (platform-admin tenant lists, analytics, impersonation lookup). Wrap in
  a file-local `crossTenantRead()` helper for clarity.
- Cross-tenant maintenance crons (e.g. zombie-cleanup of agent_executions
  across all tenants on worker reboot recovery).

**Hard requirements:**
- Add the calling file to `WITH_ADMIN_ALLOWLIST` in
  `packages/backend/src/__tests__/no-raw-db-in-repos.test.ts`. Adding a
  new file requires PR justification documenting why `withTenant()` cannot
  be used.
- Add a justification code comment at every call site explaining the
  cross-tenant intent.
- Falls back to the runtime `db` instance when `ADMIN_DATABASE_URL` is
  unset (single-role dev/CI setups). In production after the role
  rotation, `ADMIN_DATABASE_URL` MUST be set; without it, `withAdmin()`
  call sites raise `unrecognized configuration parameter
  "app.current_tenant_id"` under `orm_app`.
- Pool sizing is small (max 5) — not for hot paths. If a route serves
  per-request user traffic, do NOT reach for `withAdmin()` — it will
  saturate.

**Never import the raw `db` instance directly in domain code.** The architecture test (`no-raw-db-in-repos.test.ts`) rejects `(db as any)`, bare `db.selectFrom|...`, and `sql\`...\`.execute(db)` outside `core/db.ts` and `core/migrate.ts`. The ALLOWLIST is intentionally empty as of PR #538.

## Kysely Patterns
- Table interfaces live in `core/db.ts` — extend the `Database` interface for new tables
- `TenantScopedDb` returns `any` to avoid union type inference issues
- Repository callbacks use explicit `(r: any)` type annotations on `.map()` etc.
- For complex queries, use `sql` tagged template from kysely
- **Nullable columns are typed `T | null`, always — including `unknown | null`
  for nullable JSONB.** Yes, `unknown | null` collapses to `unknown` at the
  type level; keep the union anyway — the interface is the human/agent-read
  documentation of column nullability. Add a comment on the field noting the
  union is deliberate so an audit pass doesn't "simplify" it away. This is
  settled convention (PR #988 rounds 1→3 ping-ponged between two reviewers
  for lack of a written rule) — cite this section instead of re-litigating.

## Query fan-out and batched-lookup conventions (#947)

- **Bounded concurrency for per-item DB fan-out.** Never `Promise.all` over
  an unbounded list where each item opens its own
  `readOnlyTransaction`/`transaction` (each takes a pool connection). Chunk
  with a small constant (e.g. 5) or run sequentially:
  ```ts
  const CONCURRENCY = 5;
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    await Promise.all(items.slice(i, i + CONCURRENCY).map(processOne));
  }
  ```
- **Batched lookup variants preserve the singular method's index fast-path.**
  When adding `getXsByApiNames` next to a `getXByApiName` that does
  exact-then-`lower()` fallback, the batch does the same: indexed exact
  `IN (...)` first, `lower()` `IN (...)` only for the remainder, dedupe by
  id — not a single `lower()` `IN` that forces a scan for every call.
  Precedent: `metadataRepository.getObjectsByApiNames` (PR #988 round 2).

## JOIN queries across tenant-scoped tables

`withTenant()` auto-injects an **unqualified** `WHERE tenant_id = ?` on its
builder methods — when both joined tables have a `tenant_id` column, Postgres
rejects it as ambiguous. Do NOT drop back to the raw `db` client to work
around this: bare `db.selectFrom(...)` does not set
`SET LOCAL app.current_tenant_id`, so the `tenant_isolation` RLS policy
evaluates `current_setting('app.current_tenant_id')::uuid` and **raises**
when the variable is unset. Every code path MUST first open one of the
three transaction helpers (`transaction`/`readOnlyTransaction`/
`writeTransaction`) to set the var before touching a tenant-scoped table.
The pre-#543 `missing_ok=true` form silently filtered every row; #543
swapped that for a loud failure mode. The architecture test at
`packages/backend/src/__tests__/no-raw-db-in-repos.test.ts` rejects new
uses of bare `db` in domain code.

There are four approved patterns. **Pattern A is the default.** For hot-path reads that need RLS active, use **Pattern A-RO** (readOnlyTransaction). For narrow hot-path writes whose correctness is SQL-guaranteed (ON CONFLICT upserts on partial unique indexes including `tenant_id`), use **Pattern A-W** (writeTransaction). Use Pattern B only when no transaction at all is preferable (merge in JS). Pattern A-RO resolves #542 — use it instead of raw db for hot-path JOIN reads.

### Pattern A — `withTenant().transaction() + trx.raw` (default)

Active RLS (`SET LOCAL` fires) + explicit predicates on every joined table.
Use this for admin UI list pages, settings, rare operations, and anything
not on a per-request hot path.

```typescript
const rows = await withTenant(tenantId).transaction(async (trx: TenantScopedTrx) => {
  return trx.raw
    .selectFrom('record_container_links')
    .innerJoin('containers', 'containers.id', 'record_container_links.container_id')
    .select([
      'record_container_links.id',
      'record_container_links.container_id',
      'containers.api_name as c_api_name',
      // ... explicitly qualify every selected column
    ])
    // Qualify tenant_id on BOTH tables — defense-in-depth on top of RLS.
    .where('record_container_links.tenant_id', '=', tenantId)
    .where('containers.tenant_id', '=', tenantId)
    .where('record_container_links.record_id', '=', recordId)
    .execute();
});
```

Cost: takes one tx slot per call. The slot count is a circuit-breaker
(200 default) — a runaway tenant burst can still exhaust it and throw
`RATE_LIMITED`, but legitimate concurrent admin/repository writes do not.

### Pattern A-RO -- `withTenant().readOnlyTransaction() + trx.raw` (hot-path reads)

Same as Pattern A but the transaction is `SET LOCAL transaction_read_only = true`.
The per-tenant transaction slot is NOT acquired. Use for high-frequency JOIN reads
called per-record (e.g. sharing-evaluator.ts). RLS is fully active.

```typescript
const exists = await withTenant(tenantId).readOnlyTransaction(async (trx: TenantScopedTrx) => {
  const row = await sql`
    SELECT 1 FROM record_shares
    WHERE tenant_id = ${tenantId} AND record_id = ${recordId} AND user_id = ${userId}
  `.execute(trx.raw);
  return row.rows.length > 0;
});
```

### Pattern A-W — `withTenant().writeTransaction() + trx.raw` (narrow hot-path writes)

Like Pattern A but does NOT acquire a per-tenant write-tx slot. Allows writes.
Use ONLY for a single-row write whose tenant-correctness is guaranteed by the
SQL itself, called on every record create / message / turn / integration call
where the regular per-tenant write-tx slot circuit-breaker (200 default) would
throw `RATE_LIMITED` under bulk concurrency. Two shapes qualify:

1. **ON CONFLICT upsert** on a partial unique index that includes `tenant_id`
   (the canonical case — autonumber sequence increment).
2. **Single-statement INSERT / PK-scoped UPDATE** whose tenant-correctness is
   SQL-guaranteed — explicit `tenant_id` in the INSERT VALUES, or a
   `WHERE id = ?` UPDATE where the `tenant_isolation` RLS policy confines the
   row to the tenant. Example: per-call integration execution logging
   (`createExecutionLog`, `updateConnectionHealth`, `touchConnectionLastUsed`,
   #1010) — written on every integration call, so Pattern A would exhaust the
   slot budget from logging alone.

Adding new call sites requires a PR that justifies why `.transaction()` would
cause slot pressure, AND that the operation can't tolerate the fix from #542
landing and removing the constraint later.

```typescript
// packages/backend/src/domains/metadata/metadata.repository.ts
const result = await withTenant(tenantId).writeTransaction(async (trx: TenantScopedTrx) => {
  return sql`
    INSERT INTO sequences (tenant_id, object_id, field_id, last_value)
    VALUES (${tenantId}, ${objectId}, ${fieldId}, ${startValue})
    ON CONFLICT (tenant_id, object_id, field_id) WHERE field_id IS NOT NULL
    DO UPDATE SET last_value = sequences.last_value + 1
    RETURNING last_value
  `.execute(trx.raw);
});
```

**Pattern A-W rules:**
- Correctness must be guaranteed by the SQL: explicit `tenant_id` in VALUES
  (and in the ON CONFLICT target, for upserts), or a PK-scoped `WHERE` that RLS
  confines to the tenant. No cross-table logic, no loops.
- Keep the transaction body tight — ideally one statement.
- A guardrail arch test (`write-transaction-usage-count.test.ts`) asserts the
  number of call sites stays at the approved baseline. Adding a new site
  requires bumping the baseline with reviewer sign-off.

### Pattern B — split queries + JS merge (hot-path escape valve)

Split the JOIN into separate `readOnlyTransaction` reads on each
table, merge in JS. Two short read-only transactions instead of one tx
covering a join. RLS is **active** in both transactions because each one
sets `SET LOCAL app.current_tenant_id`; security is two layers
(SET LOCAL + the tenant predicate inside `trx.selectFrom`'s auto-injected
`WHERE tenant_id`). Use when even Pattern A-RO's single multi-table
transaction is undesirable — typically for hot paths where the second
fetch is conditional on the first result set being non-empty, so combining
into one tx wastes the conditional fetch's setup cost.

```typescript
// Query 1 — primary table, in its own readOnlyTransaction. RLS active.
const flows = await withTenant(tenantId).readOnlyTransaction(async (trx) =>
  trx
    .selectFrom('flows')
    .select(['id', 'api_name', 'trigger_object_api_name', 'active_version_id'])
    .where('trigger_type', '=', 'recordCreated')
    .where('is_active', '=', true)
    .execute(),
);

// Query 2 — related table by FK, filtered to the IDs we actually need.
// Guard: empty input to `in` MUST return empty output, not skip the filter.
const versionIds = flows.map((f) => f.active_version_id).filter((id): id is string => !!id);
const versions = versionIds.length
  ? await withTenant(tenantId).readOnlyTransaction(async (trx) =>
      trx
        .selectFrom('flow_versions')
        .select(['id', 'steps'])
        .where('id', 'in', versionIds)
        .execute(),
    )
  : [];

// Merge
const versionById = new Map(versions.map((v) => [v.id, v]));
return flows.map((f) => ({ ...f, steps: versionById.get(f.active_version_id)?.steps ?? [] }));
```

**Pattern B rules:**
- Always fetch the primary table first with the filter predicates; then
  batch-fetch related rows by FK id with a `WHERE id in (...)` clause.
- Always guard the related fetch on `ids.length > 0`. Some drivers emit
  `WHERE id in ()` which is a syntax error; Postgres is lenient but the
  guard is still required for correctness when future rows need them.
- All four patterns require a transaction wrapper because the post-#543
  `tenant_isolation` policy raises on unset `app.current_tenant_id`.
  Pattern B differs from Pattern A-RO only in that it serializes two
  short read transactions instead of holding one across both reads.

### When to pick A / A-RO / A-W / B

| Characteristic | Pattern A | Pattern A-RO | Pattern A-W | Pattern B |
|---|---|---|---|---|
| Operation | read or write | read only | narrow SQL-safe write | read |
| RLS active (SET LOCAL) | ✅ | ✅ | ✅ | ✅ (per-tx) |
| Takes per-tenant tx slot (200/tenant default, circuit-breaker) | ✅ yes | ❌ no | ❌ no | ❌ no |
| Called per-request / per-record | ❌ will 429 | ✅ correct | ✅ correct for narrow writes | ✅ correct |
| Called from admin UI or one-shot job | ✅ correct | Acceptable | ❌ overkill | Acceptable but unnecessary |
| Needs transactional atomicity (check-then-write) | ✅ required | ❌ read-only | ❌ single-stmt only | ❌ no shared tx |
| Returns N rows of JOINed data | ✅ single query | ✅ single query | N/A | Two queries + JS merge |

If you are unsure, **start with A**. If load testing or prod metrics show
tx-slot pressure for a specific method, convert reads to A-RO. Use A-W only
for the narrow ON-CONFLICT case and bump the guardrail test's baseline.
Use B only if even A-RO's tx overhead is undesirable.

### What the architecture test catches

`no-raw-db-in-repos.test.ts` rejects:

- `(db as any)` casts anywhere in `src/` (outside `core/db.ts`, `core/migrate.ts`)
- `sql\`...\`.execute(db)` — raw db passed to a tagged-template executor
- Bare `db.selectFrom|updateTable|deleteFrom|insertInto|transaction(` in
  domain files — the "no-cast but still bypass" pattern the auditor caught
  in audit.repository.ts
- `withTenant(tid).{selectFrom|insertInto|updateTable|deleteFrom}(` outside
  `core/db.ts` — the chained "non-transaction tenant query" pattern.
  Caught both inline (`withTenant(tid).selectFrom(...)`) and multi-line
  (`withTenant(tid)\n  .selectFrom(...)`). Use
  `withTenant(tid).{transaction|readOnlyTransaction|writeTransaction}` and
  access the methods via the `trx` parameter instead. The bound-variable
  form (`const tdb = withTenant(tid); tdb.X(`) is also caught — see the
  `BOUND_TDB_PATTERN` in the test. Once the codemod is complete and the
  four methods are removed from the `TenantScopedDb` interface, typecheck
  enforces the rule structurally.

The ALLOWLIST is intentionally empty as of PR #538. Every new raw-db bypass
fails CI immediately. Use withTenant, withoutTenant, or trx.raw inside
a transaction -- not the raw db import.

Precedents: listLinksForRecord (PR #485 rounds 2-3) established Pattern A.
PR #538 (issue #536) added withoutTenant for non-tenant-scoped tables,
readOnlyTransaction for hot-path reads, and migrated all 17 production files to
zero raw-db usage. Issue #542 is resolved by readOnlyTransaction.

### Async functions must NEVER return a Kysely builder directly

If an `async` function returns a Kysely builder (e.g. the object returned
by the `sql` tagged template, a query builder, an insert builder), the
caller's `await` runs `Promise.resolve(builder)` which inspects the
builder's `.then` property. Kysely 0.27 enforced this with a throwing
`.then` getter (`preventAwait`) on every builder so the bug failed
loudly. **Kysely 0.28 removed `preventAwait`** — the builder no longer
has a throwing `.then`, so an `async` function that returns one now
silently resolves to the builder object itself. Downstream code that
expects a fragment receives a builder instance instead, no error
raised. That is harder to diagnose than the old loud throw.

```typescript
// BROKEN — Kysely 0.27: throws "don't await RawBuilder instances directly"
//          Kysely 0.28+: silently resolves to the RawBuilder object,
//          no error, downstream sees a builder where it expected a fragment
async function buildFragment(tenantId: string): Promise<ReturnType<typeof sql>> {
  return sql`AND tenant_id = ${tenantId}`;
}
```

**Rule:** wrap the builder in a plain object or tuple so the fulfilled
value is not the builder itself:

```typescript
// Correct — the fulfillment value is a plain object with no .then
async function buildFragment(tenantId: string): Promise<{ fragment: ReturnType<typeof sql> }> {
  return { fragment: sql`AND tenant_id = ${tenantId}` };
}
// Caller destructures:
const { fragment } = await buildFragment(tenantId);
```

The rule applies to any Kysely builder — raw, query, insert, update,
delete. The wrapping pattern is now defensive only (the loud `preventAwait`
guard is gone in 0.28) but it's the only thing keeping the silent-resolve
bug out of the codebase. Precedent:
`sharing-evaluator.ts buildQueueMembershipCondition` (caught in PR #538
under Kysely 0.27; rationale updated for 0.28 in #639).

## JSONB Record Storage
- Records store field values in typed JSONB columns: `text_values`, `number_values`, `boolean_values`, `date_values`, `datetime_values`, `lookup_values`
- Mapping is in `JSONB_COLUMN_MAP` from `@orm/shared`
- `routeToColumns()` distributes field values to correct JSONB columns
- `flattenRecord()` extracts JSONB values back to flat object
- JSONB queries use `->>`  operator: `sql\`column ->> \${fieldName}\``

## Migrations
- Files: `NNN_description.sql` (zero-padded 3-digit prefix) in `/migrations/`
- Each runs in a transaction (handled by `core/migrate.ts`, auto-run on startup)
- Always include RLS setup for tenant-scoped tables
- Never modify existing migration files — create new ones

## Adding a New Tenant-Scoped Domain (#555)

When adding a new tenant-scoped domain (table + repository + routes), follow
the five-step checklist in [`.ai/context/RLS_NEW_DOMAIN_CHECKLIST.md`](../../.ai/context/RLS_NEW_DOMAIN_CHECKLIST.md):

1. **Migration** — `tenant_id NOT NULL`, `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, canonical strict policy (no `missing_ok=true`)
2. **Kysely interface** — add `XxxTable` to `Database` in `core/db.ts` in the same commit as the migration
3. **Repository** — use `withTenant().{transaction|readOnlyTransaction|writeTransaction}`, never raw `db` or `withoutTenant` for tenant-scoped tables
4. **Test helpers** — add the new table to `cleanupTenant()` in `test/helpers.ts` before its parent tables
5. **Cross-tenant test** — add `<entity>.cross-tenant.integration.test.ts` using the template in the checklist

The architecture test `no-raw-db-in-repos.test.ts` enforces rules 1–3 at CI time.
