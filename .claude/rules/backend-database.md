---
globs:
  - "packages/backend/src/core/db.ts"
  - "packages/backend/src/domains/**/*.repository.ts"
  - "migrations/**"
---

# Database & Kysely Conventions

## Case Convention
- DB columns: `snake_case`; API fields: `camelCase`
- Conversion at repository boundary via `snakeToCamelObject()` / manual mapping

## Tenant Isolation (Critical)
- Every tenant-scoped table MUST have `tenant_id UUID NOT NULL REFERENCES tenants(id)`,
  RLS enabled, and a `tenant_isolation` policy.
- **#543: every `tenant_isolation` policy uses `current_setting('app.current_tenant_id')::uuid`
  WITHOUT `missing_ok=true`.** When the var is unset the policy raises rather than
  silently filtering rows. Every query path MUST first open one of the three
  transaction helpers (which run `SET LOCAL app.current_tenant_id`) before
  touching a tenant-scoped table.
- INSERT must explicitly include `tenant_id` in values — the helpers'
  `trx.insertInto()` does NOT auto-inject the column.

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
`writeTransaction()` exclusively; inside them call `trx.selectFrom(...)`
(auto-`WHERE tenant_id`) or `trx.raw.selectFrom(...)` (no auto-injection — for
JOINs needing per-table predicates).

- **`readOnlyTransaction`** — also sets `SET LOCAL transaction_read_only = true`;
  same `TenantScopedTrx` interface (`trx.raw.selectFrom(...)`), RLS fully active,
  safe per-record / per-request. Resolves #542.
- **`writeTransaction`** — writes, no slot. ONLY for a narrow single-row hot-path
  write whose correctness the SQL itself guarantees — Pattern A-W below lists the
  two qualifying shapes and the usage rules. `.transaction()` remains the default
  for every other write; misuse of `writeTransaction` lets a runaway tenant
  saturate the pool without the per-tenant slot backpressure.
- **`withoutTenant`** — raw `db` pass-through: no `SET LOCAL`, no auto-injected
  WHERE. For tables without `tenant_id` (`tenants`, `platform_admins`,
  `platform_admin_mfa_secrets`, `tool_embeddings`) and background crons reading
  across all tenants. Never use in a user-request handler.
- **`withAdmin()`** (#555) — separate `pg.Pool` (max 5) against `orm_admin`
  (NOSUPERUSER **BYPASSRLS**) via `ADMIN_DATABASE_URL`. BYPASSRLS by design:
  every RLS policy on every table is bypassed, including `tenant_isolation` —
  the platform's `eval()` equivalent. Use for pre-tenant-context lookups where
  the lookup IS what determines the tenant (bearer-token API key, OAuth
  `client_credentials` grant); super-admin console reads aggregating across all
  tenants by design (platform-admin tenant lists, analytics, impersonation
  lookup — wrap in a file-local `crossTenantRead()` helper); and cross-tenant
  maintenance crons (`agent_executions` zombie-cleanup on worker reboot).
  **Hard requirements:** add the calling file to `WITH_ADMIN_ALLOWLIST` in
  `packages/backend/src/__tests__/no-raw-db-in-repos.test.ts` — a new file
  requires PR justification for why `withTenant()` cannot be used; add a
  justification comment at every call site explaining the cross-tenant intent;
  `ADMIN_DATABASE_URL` MUST be set in production after the role rotation (it
  falls back to the runtime `db` when unset, for single-role dev/CI — without it
  call sites raise `unrecognized configuration parameter
  "app.current_tenant_id"` under `orm_app`); never use the max-5 pool for hot
  paths or per-request user traffic, it saturates.

**Never import the raw `db` instance directly in domain code** — the architecture
test `no-raw-db-in-repos.test.ts` rejects every bypass shape (`(db as any)`, bare
`db.selectFrom|...`, `sql\`...\`.execute(db)`, chained `withTenant(tid).X(`)
outside `core/db.ts` and `core/migrate.ts`; see "What the architecture test
catches" below.

### `withoutTenant` is a hand-rolled object, NOT a Kysely instance — raw `sql` and `SET LOCAL` both have gotchas (#1059)

`withoutTenant` (`core/db.ts`) is a plain object exposing exactly five
methods — `selectFrom` / `insertInto` / `updateTable` / `deleteFrom` /
`transaction` — each a thin pass-through to the raw `db`. It is **not** a
Kysely instance, so two things that "read naturally" are wrong on the
platform-partition / non-tenant tables (`catalog_*`, `marketplace_*`,
`tool_embeddings`, etc.):

1. **Raw `sql`...`.execute()` cannot target `withoutTenant`.** It has no
   `executeQuery`/`Kysely` surface, so `sql\`...\`.execute(withoutTenant)`
   won't typecheck — and the tempting "fix," `sql\`...\`.execute(db)`, trips
   the `no-raw-db-in-repos.test.ts` arch test above. A raw-`sql` read/write
   on a non-tenant table MUST use one of:
   - the Kysely-builder + `sql`-fragment form **on the builder**
     (`withoutTenant.selectFrom('t').where(sql\`...\`)...`), or
   - `withoutTenant.transaction(async (trx) => sql\`...\`.execute(trx))` —
     `trx` IS a real `Transaction<Database>`, so `.execute(trx)` is valid.
   Pure Kysely-builder reads (no raw `sql`) need neither.

2. **`SET LOCAL` only affects the connection it runs on — so it MUST share a
   transaction with the query it bounds.** A bare `withoutTenant.selectFrom(...)`
   (or a `sql\`SET LOCAL statement_timeout = '30000'\`` issued separately)
   checks out its OWN pool connection independently, so a `SET LOCAL` run
   outside the query's transaction silently applies to nothing — the promised
   `statement_timeout` / read-only / tenant bound never takes effect. Issue the
   `SET LOCAL` as the FIRST statement inside the SAME
   `withoutTenant.transaction(async (trx) => { await sql\`SET LOCAL …\`.execute(trx); return trx.selectFrom(...)... })`
   that runs the query. Canonical precedent:
   `catalog.repository.ts:upsertCanonicalRows` / `findEmbeddingCandidates`.

Greppable proxy: any `sql\`...\`.execute(withoutTenant)` (won't compile) or a
`sql\`SET LOCAL ...\`` not immediately followed by `.execute(trx)` inside the
same `withoutTenant.transaction()` callback as the query it's meant to bound.

Precedent: PR #1241 (#1059) — spec-audit sonnet round 1 (MEDIUM) caught a
full-table `catalog_items` scan whose `SET LOCAL statement_timeout` was
documented as bounding the query but sketched as a bare non-transactional
`withoutTenant.selectFrom(...)`, so the timeout would never have applied;
opus round 1 (LOW) caught two read methods sketched as raw `sql` with no
valid `.execute()` target on `withoutTenant`.

## Kysely Patterns
- Table interfaces live in `core/db.ts` — extend the `Database` interface for new tables
- `TenantScopedDb` returns `any` to avoid union type inference issues
- Repository callbacks use explicit `(r: any)` type annotations on `.map()` etc.
- For complex queries, use `sql` tagged template from kysely
- **Nullable columns are typed `T | null`, always — including `unknown | null`
  for nullable JSONB.** Yes, `unknown | null` collapses to `unknown` at the type
  level; keep the union anyway — the interface is the human/agent-read
  documentation of column nullability. Add a comment on the field noting the
  union is deliberate so an audit pass doesn't "simplify" it away. Settled
  convention (PR #988 r1–3) — cite this section instead of re-litigating.

## Query fan-out and batched-lookup conventions (#947)

- **Natural-key lookups against a soft-deletable table must apply the same
  `is_deleted` (or equivalent scoping) filter as every sibling query resolving
  the same identity.** A partial unique index scoped `WHERE is_deleted = false`
  (e.g. `idx_records_email_template_api_name`) only forbids two LIVE rows from
  colliding, so a live row and a soft-deleted row CAN share the natural-key
  value: a resolver omitting the predicate its siblings (a backfill migration,
  the canonical service-layer getter) apply matches the wrong row
  nondeterministically, silently pointing ownership/derived state at a dead
  record. Grep the canonical lookup and diff the WHERE clauses before shipping a
  new resolver — sibling sweep, see `workflow.md` "Sibling sweep (canonical
  statement)"; the write-side analog is
  `{{PATHS_RULES_DIR}}/backend-general.md` "Partial-update / reconciliation helpers".
  Precedent: `deployment/provenance-ledger.ts`'s `emailTemplateResolver` missed
  `is_deleted = false` on the `templateApiName` key (#1031, PR #1207 spec-audit opus r2).
- **Bounded concurrency for per-item DB fan-out.** Never `Promise.all` over an
  unbounded list where each item opens its own
  `readOnlyTransaction`/`transaction` (each takes a pool connection). Chunk with
  a small constant (e.g. 5) or run sequentially:
  ```ts
  const CONCURRENCY = 5;
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    await Promise.all(items.slice(i, i + CONCURRENCY).map(processOne));
  }
  ```
- **Batched lookup variants preserve the singular method's index fast-path.**
  When adding `getXsByApiNames` next to a `getXByApiName` that does
  exact-then-`lower()` fallback, the batch does the same: indexed exact
  `IN (...)` first, `lower()` `IN (...)` only for the remainder, dedupe by id —
  not a single `lower()` `IN` that forces a scan for every call. Precedent:
  `metadataRepository.getObjectsByApiNames` (PR #988 r2).
- **Batch upserts: dedupe the values array by the conflict key BEFORE building
  the multi-row `INSERT ... ON CONFLICT`, and build ONE multi-row statement
  rather than one upsert per item.** The same conflict key (e.g. `(tenant_id,
  entity_type, entity_key)`) can legitimately appear twice in a changeset-derived
  list — one apiName in both the `added` and `modified` buckets, or twice within
  one — and Postgres then rejects the whole statement with `ON CONFLICT DO UPDATE
  command cannot affect row a second time`. Dedupe with a `Set`/`Map` keyed by
  the conflict key per type/bucket first, THEN build the rows array. Do NOT
  sidestep the collision with N sequential single-row upserts — that reintroduces
  the "N+1 query" anti-pattern the bullet above bans for reads.
  ```ts
  // WRONG — pushes into a plain array; a key appearing twice across
  // changeset.added/changeset.modified duplicates the conflict target and
  // 23505s the whole statement; also issues one upsert PER KEY.
  const keys: string[] = [];
  for (const item of [...changeset.added, ...changeset.modified]) keys.push(item.apiName);
  for (const key of keys) {
    await trx.insertInto('t').values({ tenant_id, entity_type: type, entity_key: key })
      .onConflict((oc) => oc.columns(['tenant_id', 'entity_type', 'entity_key']).doUpdateSet({...}))
      .execute();
  }

  // RIGHT — Set dedupes the conflict key per type; ONE multi-row upsert
  const keySet = new Set<string>();
  for (const item of [...changeset.added, ...changeset.modified]) keySet.add(item.apiName);
  const rows = [...keySet].map((key) => ({ tenant_id, entity_type: type, entity_key: key }));
  if (rows.length > 0) {
    await trx.insertInto('t').values(rows)
      .onConflict((oc) => oc.columns(['tenant_id', 'entity_type', 'entity_key']).doUpdateSet({...}))
      .execute();
  }
  ```
  Precedent: `deployment/provenance-ledger.ts` (#1031, PR #1207 — per-key upsert
  loop in code-audit opus r4, missing dedupe on the same values list in Copilot r1).

## A documented "identity = (…)" tuple must match the index, the ON CONFLICT target, AND the JS key helper (#1058)

A natural-key identity documented in prose (migration header comment,
repository/class docstring, `SCHEMA.md`, the spec's `CREATE TABLE` sketch) MUST
appear as the SAME column set in every place that operationally enforces or
derives it:

1. the `CREATE UNIQUE INDEX ... (col_a, COALESCE(col_b, ''), …)` in the migration,
2. the repository upsert's `ON CONFLICT (…)` target (every path — a fast-path
   lookup AND the natural-key upsert),
3. the JS key-builder helper (`itemNaturalKey()`-style) that dedupes a batch in
   memory before it hits the DB.

Drop a column from any one of the four (the prose plus those three) and two
genuinely-distinct rows collapse onto one identity: the second upsert changes
only `content_hash`, so it reports as a benign "content update" (`itemsChanged`)
while silently destroying the first row. Dormant until a real feed populates the
omitted column (a serial `print_run`, a variant discriminator) — so a test seeded
from a source that never sets it passes vacuously.

**Sweep discipline:** when you add or change an identity column, grep the table
name and the index name across `packages/backend/migrations/*.sql`, the
repository (`ON CONFLICT`, the JS key helper), `{{PATHS_CONTEXT_DIR}}/SCHEMA.md`, AND the
spec's `CREATE TABLE` sketch — updating the shipped migration but leaving the
spec sketch stale reintroduces the defect the moment the spec is used as a
re-implementation reference. Use a nullable column's sentinel
(`COALESCE(col, -1)` / `COALESCE(col, '')`) consistently in the index, the
`ON CONFLICT`, and the JS helper so `NULL` and a real value never alias.

Precedent: `catalog_items`'s documented tuple included `print_run` but
`idx_catalog_items_natural_key`, the `ON CONFLICT` target, and `itemNaturalKey()`
all omitted it — and the spec's `CREATE UNIQUE INDEX` sketch stayed 4-column a
round longer (PR #1228 / #1058, code-audit r1–2).

## JOIN queries across tenant-scoped tables

`withTenant()` auto-injects an **unqualified** `WHERE tenant_id = ?` on its
builder methods, which Postgres rejects as ambiguous when both joined tables have
a `tenant_id` column. Do NOT drop back to the raw `db` client: bare
`db.selectFrom(...)` never sets `SET LOCAL app.current_tenant_id`, so
`tenant_isolation` **raises** (pre-#543 `missing_ok=true` silently filtered every
row instead; #543 made it loud). Every code path MUST open one of the three
transaction helpers first. `packages/backend/src/__tests__/no-raw-db-in-repos.test.ts`
rejects new bare-`db` uses in domain code.

Four approved patterns; the decision table below is authoritative for choosing
between them — A-W additionally requires one of its two qualifying shapes and a
guardrail-baseline bump (see its section). **Pattern A is the default.** Pattern A-RO resolves #542 — use it instead of raw db for hot-path
JOIN reads.

### Pattern A — `withTenant().transaction() + trx.raw` (default)

Active RLS (`SET LOCAL` fires) + explicit predicates on every joined table. Costs
one tx slot — the 200/tenant circuit-breaker throws `RATE_LIMITED` on a runaway
burst, not on legitimate concurrent admin/repository writes.

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

### Pattern A-RO — `withTenant().readOnlyTransaction() + trx.raw` (hot-path reads)

Pattern A plus `SET LOCAL transaction_read_only = true`, minus the per-tenant
transaction slot. RLS fully active. For high-frequency JOIN reads called
per-record (e.g. `sharing-evaluator.ts`).

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

Pattern A without the per-tenant write-tx slot. ONLY for a single-row write whose
tenant-correctness is guaranteed by the SQL itself, on a path hit every record
create / message / turn / integration call where the 200/tenant circuit-breaker
would throw `RATE_LIMITED` under bulk concurrency. Two shapes qualify:

1. **ON CONFLICT upsert** on a partial unique index that includes `tenant_id`
   (canonical case — autonumber sequence increment).
2. **Single-statement INSERT / PK-scoped UPDATE** — explicit `tenant_id` in the
   INSERT VALUES, or a `WHERE id = ?` UPDATE where `tenant_isolation` confines
   the row to the tenant. Example: per-call integration execution logging
   (`createExecutionLog`, `updateConnectionHealth`, `touchConnectionLastUsed`,
   #1010) — Pattern A would exhaust the slot budget from logging alone.

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
- Correctness must be guaranteed by the SQL alone (per the two shapes above —
  and for an upsert, `tenant_id` must be in the ON CONFLICT target too). No
  cross-table logic, no loops; callers MUST keep the body tight — one indexed
  upsert / update / insert, ideally one statement.
- The guardrail arch test `write-transaction-usage-count.test.ts` pins the
  call-site count at the approved baseline. A new site requires bumping the
  baseline with reviewer sign-off, plus a PR justifying why `.transaction()`
  would cause slot pressure AND why the operation can't tolerate the #542 fix
  landing and removing the constraint later.

### Pattern B — split queries + JS merge (hot-path escape valve)

Split the JOIN into separate `readOnlyTransaction` reads per table, merge in JS.
RLS is **active** in both (each sets `SET LOCAL app.current_tenant_id`; security
is two layers — SET LOCAL plus the tenant predicate inside `trx.selectFrom`'s
auto-injected `WHERE tenant_id`). Use when even Pattern A-RO's single
multi-table transaction is undesirable — typically when the second fetch is
conditional on the first result set being non-empty, so one tx would waste that
fetch's setup cost.

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
- Always fetch the primary table first with the filter predicates, then
  batch-fetch related rows by FK id with a `WHERE id in (...)` clause.
- Always guard the related fetch on `ids.length > 0`. Some drivers emit
  `WHERE id in ()` (a syntax error); Postgres is lenient but the guard is still
  required for correctness.
- All four patterns require a transaction wrapper because the post-#543
  `tenant_isolation` policy raises on unset `app.current_tenant_id`. B differs
  from A-RO only in serializing two short read transactions instead of one.

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

If unsure, **start with A**; convert reads to A-RO when measured tx-slot pressure
justifies it, use A-W only for the narrow SQL-guaranteed case (bumping the
guardrail baseline), and B only if even A-RO's tx overhead is undesirable.

### What the architecture test catches

`no-raw-db-in-repos.test.ts` rejects:

- `(db as any)` casts anywhere in `src/` (outside `core/db.ts`, `core/migrate.ts`)
- `sql\`...\`.execute(db)` — raw db passed to a tagged-template executor
- Bare `db.selectFrom|updateTable|deleteFrom|insertInto|transaction(` in domain
  files — the "no-cast but still bypass" pattern caught in `audit.repository.ts`
- `withTenant(tid).{selectFrom|insertInto|updateTable|deleteFrom}(` outside
  `core/db.ts` — the chained "non-transaction tenant query" pattern. Caught
  inline (`withTenant(tid).selectFrom(...)`), multi-line
  (`withTenant(tid)\n  .selectFrom(...)`), and bound-variable
  (`const tdb = withTenant(tid); tdb.X(` — see `BOUND_TDB_PATTERN` in the test).
  Use `withTenant(tid).{transaction|readOnlyTransaction|writeTransaction}` and
  reach the methods via the `trx` parameter. Once the codemod is complete and the
  four methods are removed from `TenantScopedDb`, typecheck enforces this
  structurally.

The ALLOWLIST is intentionally empty as of PR #538 — every new raw-db bypass
fails CI immediately. Use `withTenant`, `withoutTenant`, or `trx.raw` inside a
transaction, never the raw `db` import. Precedents: `listLinksForRecord`
established Pattern A (PR #485 r2–3); PR #538 (#536) added `withoutTenant` and
`readOnlyTransaction` (resolving #542) and migrated all 17 production files to
zero raw-db usage.

### Async functions must NEVER return a Kysely builder directly

An `async` function returning a Kysely builder (the `sql` tagged template's
object, a query/insert builder) makes the caller's `await` run
`Promise.resolve(builder)`, which inspects the builder's `.then`. Kysely 0.27's
throwing `.then` getter (`preventAwait`) made this fail loudly; **Kysely 0.28
removed `preventAwait`**, so it now silently resolves to the builder itself and
downstream code receives a builder where it expected a fragment.

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

Applies to every Kysely builder — raw, query, insert, update, delete. Since 0.28
the wrap is defensive only, and the only thing keeping the silent-resolve bug out
of the codebase. Precedent: `sharing-evaluator.ts buildQueueMembershipCondition`
(PR #538 under 0.27; rationale updated for 0.28 in #639).

### Never interpolate a `RawBuilder` / dynamic value inside a quoted SQL string literal

`sql\`...\`` parameterizes every `${...}` interpolation by default — that's what
makes it injection-safe. `sql.raw(value)` opts OUT and splices literal text, so
`sql.raw()` (or any `${...}` Kysely can't turn into a bind parameter) **inside a
quoted string literal** — `interval '...'`, `LIKE '...'` — produces fragile,
non-parameterized SQL that can break on unexpected input and defeats the safety
`sql\`\`` is supposed to provide.

```ts
// WRONG — sql.raw() spliced inside a quoted `interval '...'` literal.
// Not parameterized; fragile if the value ever isn't a clean integer.
.where('updated_at', '<', sql<Date>`now() - interval '${sql.raw(String(GRACE_PERIOD_MINUTES))} minutes'`)

// RIGHT — bind the value as a real parameter and multiply a fixed-unit
// interval. No string splicing, no sql.raw() needed.
.where('updated_at', '<', sql<Date>`now() - (${GRACE_PERIOD_MINUTES} * interval '1 minute')`)
```

For a dynamic *quantity* against a Postgres `interval`, bind the number and
multiply a literal single-unit interval (`* interval '1 minute'`, `* interval '1
day'`) instead of building the interval's string form. Reach for `sql.raw()` only
for genuinely non-parameterizable SQL (identifiers, column/table names) — never
for a value that could be a bound parameter.

Greppable proxy: `sql.raw(` appearing inside a `sql\`...\`` template's quoted
string literal (as opposed to substituting an identifier outside any quotes).
Precedent: `findEmbeddingReconciliationCandidates()`'s grace-period predicate
(PR #1159 / #1105, Copilot r1).

## Versioned entities — the parent's pointer column is authoritative, not the child's status field

When an entity has both a child-row `status` column (`draft` / `active` /
`inactive`) on a versions table AND a pointer column on the parent
(`flows.active_version_id`, `approval_processes.active_version_id`), the
**parent's pointer is the single source of truth for "which version runs right
now."** Resolving runtime state by filtering the child on `status = 'active'`
instead of joining through the pointer can diverge from what execution uses —
history, partial fixes, or manual edits leave a child row `status='active'` while
the pointer references a different row (or vice versa).

- **Export / read-model overlays** must fetch the version the parent's pointer
  references, not the one matching `status = 'active'` — an exporter querying by
  status can bundle a different row than runtime execution and scheduler
  registration resolve via the pointer JOIN, silently shipping the wrong
  steps/config in a redeploy.
- **Every write that changes the pointer must also settle the status of the row
  it's pointing away from**: set the new row `status='active'`, demote the OLD
  active row to `status='inactive'` (with a `deactivated_at`), and repoint the
  parent — all three in one transaction. Updating only two of the three leaves
  status-based and pointer-based reads disagreeing.
- **Demotion must be unconditional whenever the desired end state can't be
  satisfied**, not just on the branch you first think of. If a reconciliation
  helper has multiple branches (e.g. "steps changed" vs. "steps unchanged"),
  every branch that can produce a not-currently-activatable result must demote a
  stale prior-active row and clear the parent's pointer — one un-swept branch
  silently resurrects the old version's behavior, including re-arming a live cron
  job on the next process reboot for scheduled entities. Sweep every branch in
  one pass — `workflow.md` "Sibling sweep (canonical statement)".

Generalizes what `{{PATHS_RULES_DIR}}/approval-lifecycle.md` "Process versioning"
documents for `approval_processes` / `approval_process_versions` — the same
pointer-is-authoritative rule applies to every versioned-entity domain (flows,
layouts, or a future one).

Precedent: PR #1170 (#1050) — the metadata exporter's overlay selected
`flow_versions` by `status = 'active'` instead of the `flows.active_version_id`
JOIN (Copilot r1); separately, the deployer's reconciliation helper needed four
audit rounds to close every un-demoting branch (one would have re-armed a disarmed BullMQ
scheduled job on the next worker reboot).

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
the five-step checklist in [`{{PATHS_CONTEXT_DIR}}/RLS_NEW_DOMAIN_CHECKLIST.md`](../../{{PATHS_CONTEXT_DIR}}/RLS_NEW_DOMAIN_CHECKLIST.md):

1. **Migration** — `tenant_id NOT NULL`, `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, canonical strict policy (no `missing_ok=true`)
2. **Kysely interface** — add `XxxTable` to `Database` in `core/db.ts` in the same commit as the migration
3. **Repository** — use `withTenant().{transaction|readOnlyTransaction|writeTransaction}`, never raw `db` or `withoutTenant` for tenant-scoped tables
4. **Test helpers** — add the new table to `cleanupTenant()` in `test/helpers.ts` before its parent tables
5. **Cross-tenant test** — add `<entity>.cross-tenant.integration.test.ts` using the template in the checklist

The architecture test `no-raw-db-in-repos.test.ts` enforces rules 1–3 at CI time.
