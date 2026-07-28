---
globs:
  - "packages/backend/**"
---

# Backend Conventions

## Language & Module System

- TypeScript strict mode, ESM imports with `.js` extensions
- Named exports only (no default exports)
- Use `import type` for type-only imports

## Domain Module Pattern

Every domain lives in `packages/backend/src/domains/{name}/` with these files:

- `{name}.routes.ts` — Route handlers: parse input, call service, return response. Keep thin.
- `{name}.service.ts` — All business logic lives here. Only layer that orchestrates.
- `{name}.repository.ts` — All DB access via `withTenant(tenantId)`. Never use raw `db` in services.
- `{name}.schema.ts` — Zod schemas for request validation (re-exports from @orm/shared when possible).
- `{name}.events.ts` — Event type definitions and emissions.

Domains managing primitive types (flow steps, field types, layout components)
also include `{name}/registry.ts` (singleton registry class — `register`,
`get`, `listMetadata`, `_clearForTests`), `{name}/definitions/index.ts`
(builtin array `builtin{Name}Definitions`), and `{name}/registry.test.ts`
(arch tests: required fields, no duplicates, no `execute` leaks). See
`{{PATHS_RULES_DIR}}/registry.md` for the full registry pattern.

## Error Handling

- Throw `PlatformError` subclasses: `ValidationError`, `NotFoundError`, `ConflictError`, `PlatformError`
- Never throw raw `Error` — the error handler middleware maps PlatformError to response envelopes
- Import from `../../core/errors.js`
- Upstream data (registry, OAuth, integration, webhook payloads) that fails
  schema validation is 502, not 400: `safeParse` +
  `PlatformError('UPSTREAM_X_INVALID', ..., 502)`. See
  `{{PATHS_RULES_DIR}}/backend-api.md` "Upstream Data".

### Error code registry (#537)

Canonical home for typed-`PlatformError` mechanics — domain rule files
(`delete-lifecycle.md`, `approval-lifecycle.md`) should cross-ref here rather
than restate them, keeping only their domain-specific code tables and
patterns.

Every `PlatformError` code MUST be registered in
`packages/shared/src/constants/error-codes.ts` — use `ERROR_CODES.YOUR_CODE`
(preferred) or a bare literal that exists as a registry value. The arch test
`error-codes-registry.test.ts` scans every `new PlatformError('CODE', ...)`
site and rejects unregistered literals.

```ts
import { ERROR_CODES } from '@orm/shared';

throw new PlatformError(
  ERROR_CODES.PROFILE_IN_USE,
  `Cannot delete — ${result.userCount} user(s) are assigned.`,
  409,
);
```

Adding a code: edit `error-codes.ts`, `{{PKG_BUILD}}`, then
use `ERROR_CODES.YOUR_NEW_CODE`. The frontend's `useApiErrorToast` is typed
against the same registry — toast-map keys MUST be registered codes
(`error-toast-registry.test.ts`).

**Single-vs-wrapper code pattern (#695)** — when a service-layer validator
returns N independent failures (e.g. `validateLookupTargets` from
`_lookup-validator.ts`), the caller in `data.service.ts` throws: for **exactly
one**, `PlatformError(only.code, only.message, 400, [{field, code, message}])`
so the top-level `error.code` is the specific failure
(`LOOKUP_TARGET_NOT_FOUND`, `LOOKUP_TARGET_OBJECT_MISMATCH`,
`POLYMORPHIC_TARGET_NOT_ALLOWED`, `LOOKUP_FILTER_MISMATCH`) that
`useApiErrorToast` maps; for **two or more**,
`PlatformError(ERROR_CODES.LOOKUP_VALIDATION_FAILED, ..., 400, details[])`
with a typed `code` on each `details[]` entry, which the frontend iterates for
per-field copy. `ApiErrorDetail` carries an optional `code?: string` — every
typed-per-field error must populate it.

### Permissions registry (#537)

Every system permission in `requireSystemPermission(...)` or
`'x-requires-permission': [...]` MUST use `PERMISSIONS.X` from `@orm/shared`.
The arch test `permissions-registry.test.ts` rejects bare camelCase literals.

```ts
import { PERMISSIONS } from '@orm/shared';

preHandler: [requireAuth, requireSystemPermission(PERMISSIONS.MANAGE_USERS)],
// or
schema: { 'x-requires-permission': [PERMISSIONS.MANAGE_USERS] },
```

Adding one: edit `packages/shared/src/constants/permissions.ts`, rebuild
shared, then use `PERMISSIONS.YOUR_NEW_PERM`.

### Custom Error subclasses — never `readonly`-override a mutable base property

`Error.cause` (and `Error.message` / `Error.name`) is **mutable** on
`lib.d.ts`'s `Error` interface and TypeScript checks overrides structurally,
so a subclass re-declaring it `readonly` is not assignable to the mutable base
property — this risks a typecheck failure (or a puzzling structural-typing
error) depending on how the class is consumed downstream. Applies to every
custom `Error` subclass (`PlatformError` and variants,
`EmbeddingProviderError`).

```ts
// Keep it mutable; document immutability in a comment, don't enforce it.
// Trap: `override readonly cause?: unknown;` reads safe but is a readonly
// override of a mutable base property.
export class EmbeddingProviderError extends Error {
  /** Set once in the constructor; treated as immutable by convention, not enforced. */
  override cause?: unknown;
}
```

(PR #1156, #1100 r3.)

## Provenance columns — set at INSERT, never post-update

Columns recording *how* a row came to exist (`source`, `origin`,
`created_via`, `installed_by`, `imported_from`, …) MUST be a parameter of
`repository.create({ ..., source })`, threaded through the service as a
backend-only parameter (`service.doThing(..., source?: 'manual' | 'registry' =
'manual')`). Never patch them afterwards via a separate `updateSource()` /
`updateOrigin()` call — `service.install(...); await
repository.updateSource(...)` loses provenance on any failure path between the
two, leaving the DB default (`'manual'`, `'unknown'`) and a wrong audit trail.
(`installed_packages.source` via `marketplaceService.install()`, #299; PR #488
initially planned a post-update and was reworked — the row survives with
`status='failed'` but `source='manual'` on deploy failure.)

## Partial-update / reconciliation helpers — sweep every sibling field for preserve-on-absence

When a service-layer helper merges an incoming partial payload (deploy bundle,
PATCH body) against a row's current state, the preserve-on-absence fallback
MUST cover **every** field sharing that undefined-vs-explicit shape, in the
same commit — `{{PATHS_RULES_DIR}}/workflow.md` "Sibling sweep (canonical
statement)" (analogs: `{{PATHS_RULES_DIR}}/shared-types.md` "Tightening one schema?
Sweep its siblings", `{{PATHS_RULES_DIR}}/frontend-components.md` "Form-field
completeness across create + update").

```ts
// Same shape for EVERY field that shares it. Trap: giving steps/inputs the
// fallback but leaving `const label = bundleFlow.label` bare, so a MODIFY
// bundle legally omitting `label` writes an empty label onto the new version.
const effectiveSteps = bundleFlow.steps !== undefined
  ? bundleSteps
  : parseMaybeJson(mostRecentVersion?.steps, []);
const effectiveLabel = bundleFlow.label !== undefined
  ? bundleLabel
  : parseMaybeJson(mostRecentVersion?.label, {});
```

Also: for a pre-migration / versionless / legacy row with no sibling row to
fall back to, fall back to the CURRENT HEADER's own value (`[]` / `{}` / a
bare default silently discards data the row already had); and add a regression
test per field, not just the first one fixed. (PR #1170, #1050 —
`syncFlowVersionState`, one round each for `effectiveSteps`/`effectiveInputs`,
`effectiveLabel`, the legacy-row case.)

## Key-normalization / strip-prefix helpers that build a Map or Record MUST guard collisions (#1033)

Any helper building a `Map`/`Record` keyed by a **normalized** input key
(stripping a namespace prefix, lowercasing, trimming, hashing) MUST guard
against two distinct source keys collapsing onto one — unconditional
`result[normalize(k)] = v` silently overwrites the first entry, with no error,
no log line, nothing to grep for.

```ts
// Detect the collision before assigning; fail fast with a typed error so the
// caller learns the bundle isn't representable in canonical form. Trap: a
// prefixed key `contacts__Widget` and an external `Widget` both normalize
// to `Widget`.
for (const [objApiName, fields] of Object.entries(bundle.fields)) {
  const stripped = stripPrefix(objApiName);
  if (stripped in result) {
    throw new ValidationError(
      `Namespace strip collision: both "${objApiName}" and an earlier key normalize to "${stripped}".`,
    );
  }
  result[stripped] = fields;
}
```

Extract the guard into one shared helper (e.g. `stripGroupedMapKeys`) and
apply it to EVERY grouped map the module strips (`fields`, `recordTypes`,
`layouts`, `listViews`, `validationRules`, `sharingRules`, …) —
`{{PATHS_RULES_DIR}}/workflow.md` "Sibling sweep (canonical statement)". It applies
equally to leaf-key rewriters: `rewriteCriteriaTree` rebuilds a criteria
`Record` keyed by rewritten field names, where a pre-existing `foo` and a
namespace-owned `ns__foo` collapse on `out[newKey] = ...`. When the guard's
message takes a position `label` naming which of N call sites fired, thread a
real label through EVERY call site (matching the required-not-optional `label`
on `rewriteRecordKeyMap`) — an unset optional `label` makes every collision
error generic. (PR #1195, #1033 r1 — `stripBundleNamespacePrefix` in
`bundle-namespace.ts`, all five grouped maps; PR #1230, #1200 r1–2 —
`rewriteCriteriaTree` unguarded, `label` unset at 15 call sites.)

## Derived-status recompute — gate on a genuine transition, and sweep every writer that shares the derivation

When a parent row's status is *derived* from its children (a plan completed
once every step is `done`/`skipped`) and several methods mutate a child
(`updateStep`, `removeStep`, `addStep`, any future sibling), two rules apply.

**1. Gate the recompute on a genuine transition into the terminal set**, not
merely "are all children terminal after this write" — the latter re-fires on a
title-only edit to an already-`done` step or a terminal→terminal
`done`→`skipped`, and since a parent can independently be un-derived (a
`reactivate` flips it back to `active` without resetting already-terminal
children — parent-pointer analog: `{{PATHS_RULES_DIR}}/backend-database.md`
"Versioned entities"), such an edit silently re-derives the parent to terminal
and undoes the reactivation. Capture the child's PRIOR status before the write
and recompute only when the write moved it non-terminal → terminal (for a
delete: when the REMOVED child was non-terminal).

```ts
// Captures the child's status BEFORE the write; derives only on a genuine
// non-terminal → terminal transition. Trap: the post-write-snapshot-only form
// (no `prevNonTerminal` check) fires on ANY edit to an already-terminal child.
const prevStatus = (childRow as any).status as string;
// ... perform the write ...
const prevNonTerminal = !TERMINAL.has(prevStatus);
if (input.status !== undefined && prevNonTerminal) {
  const remaining = await trx.selectFrom('children').select(['status']).where('parent_id', '=', parentId).execute();
  if (remaining.every((r) => TERMINAL.has(r.status)) && remaining.length > 0) {
    await trx.updateTable('parents').set({ status: 'completed' }).where('id', '=', parentId).execute();
  }
}
```

**2. Every method with its own copy of the recompute gets the same gate in the
same pass** — `updateStep`'s and `removeStep`'s are independent copies, so
gating one leaves the bug reachable through the sibling. Grep every duplicate
of the derivation query/predicate (`allTerminal`, `remaining...`, the
parent-status UPDATE) before declaring the fix complete
(`{{PATHS_RULES_DIR}}/workflow.md` "Sibling sweep (canonical statement)"). (PR
#1196, #1186 r7–9 — `updateStep`, then `removeStep`, then `updateStep`'s gate
still too loose without the PRIOR-status check.)

## Bulk per-row ingest — isolate identity-bearing writes, count the failure, and feed it into the terminal status

A streaming bulk-upsert whose invariant is "a single bad row must not abort
the whole N-row seed" has three coupled requirements:

1. **Any identity-bearing write that can raise a unique-violation (23505) — an
   `UPDATE ... SET <identity columns> WHERE id = ?` fast path, an `INSERT ...
   ON CONFLICT` — must be SAVEPOINT-isolated inside the batch transaction, not
   left to throw** — an unguarded 23505 (e.g. the incoming row's new identity
   tuple now collides with a *different* existing row) propagates out of the
   per-row loop, aborts the whole `for await` stream, and marks the run
   `failed`. Wrap it in `SAVEPOINT name` / `ROLLBACK TO SAVEPOINT name`
   (branch on `err.code === '23505'` AND `err.constraint === '<the
   natural-key index>'`, per `{{PATHS_RULES_DIR}}/delete-lifecycle.md`
   "Unique-violation handling"), roll back only that row, record a per-row
   stat (`itemsIdentityConflict`).
2. **Every new per-row failure stat MUST feed the run's terminal-status
   derivation, not just sit in the stats blob** — update `status = rowErrors >
   0 ? 'partial' : 'succeeded'` (and the JSDoc truth-table above it) to
   `(rowErrors > 0 || (upsert?.itemsIdentityConflict ?? 0) > 0) ? 'partial' :
   'succeeded'`, else a batch that dropped N rows reports `succeeded` and the
   operator health signal shows green. Sweep EVERY terminal-status site: a
   bulk path and its on-demand sibling (`ingestOnDemand` hardcoding `status:
   'succeeded'`) are independent copies.
3. **An operator CLI wrapping the ingest MUST exit non-zero on `partial`** —
   `ingestBulkCsv` RETURNS (never throws) for `partial`, so a script exiting
   non-zero only on a thrown error prints "partial" and exits 0: add `if
   (result.status !== 'succeeded') process.exit(1);` after printing.

(PR #1228, #1058 — SAVEPOINT isolation r2, the stat→status wiring r3, the
seed-CLI exit opus r1.)

## Completion-tracking stamp columns — guard against concurrent-update races

A column marking "this row's current content has been processed"
(`last_embedded_at`, `last_synced_at`, `last_indexed_at`, any `last_*_at`
written by a background job on success) MUST snapshot the row version the job
evaluated and condition the stamp write on that snapshot still being current —
never blind-write `new Date()`, or a concurrent update between read and stamp
leaves the column claiming content the job never saw and every `last_*_at <
updated_at` reconciliation predicate goes permanently blind to that drift.

```ts
// Snapshot the version evaluated, condition the write on it. Trap: a bare
// `.set({ last_embedded_at: new Date() }).where('id', '=', recordId)` stamps
// whatever the row looks like NOW, not what this job saw.
const record = await trx.selectFrom('records').select(['id', 'text_values', 'updated_at']).where('id', '=', recordId).executeTakeFirst();
const snapshot = record.updated_at;
// ... slow embedding work using record.text_values ...
await trx.updateTable('records')
  .set({ last_embedded_at: new Date() })
  .where('id', '=', recordId)
  .where('updated_at', '=', snapshot)   // concurrent update ⇒ no-op, stays a candidate
  .execute();
```

A no-op UPDATE (0 rows affected) is the correct race outcome — the row stays a
reconciliation candidate for the next job. Do NOT treat it as an error.

Greppable proxy: any `.set({ last_*_at: new Date() })` (or equivalent
`UPDATE ... SET last_*_at = now()`) whose `.where()` chain does not also pin
the source-of-truth version column (`updated_at`, a row version counter,
etc.) is a candidate for this race. (PR #1159, #1105 r2 — both stamp branches
in `record-embedding.processor.ts`.)

## Per-tenant background loops — short-circuit on permanent failure

A worker/cron looping over per-tenant sub-items (objects, connections,
integrations, …) behind a per-tenant health/canary check MUST stop processing
the REMAINING sub-items for that tenant the moment the check reports a
permanent failure — `break`, never `continue`. `continue` still pays for every
remaining item's lookups and queries after the canary has proven nothing will
be enqueued: wasted DB work × every remaining item × every tick, for as long
as the tenant stays misconfigured.

```ts
for (const obj of objects) {
  if (canaryOutcome === 'skip') break;   // not `continue` — stop the whole tenant for this tick
  const embeddable = await objectIsEmbeddable(tenantId, obj).catch(...);
  // ...
}
```

Greppable proxy: a per-tenant `for` loop with a canary/health-check variable
that gates whether work is enqueued, where a `'permanent failure'` outcome
value is checked with `continue` (or not checked at all) inside the loop body
instead of `break`. (PR #1159, #1105 r2 —
`record-embedding-reconciliation.worker.ts`.) See `{{PATHS_RULES_DIR}}/testing.md`
"BullMQ deterministic-jobId recovery gap on permanent-failure retries (#1100)"
for the companion recovery-side rule.

## Avoid duplicate nested lookups — pass the resolved object into helpers

When a caller already holds a fully-resolved definition/object (from its own
`list*()` call), change the helper's signature to accept the resolved value
rather than an id/apiName it re-fetches: `objectIsEmbeddable(tenantId,
apiName)` calling `getObject()` then `listFields()` (which calls `getObject()`
again) costs 2 object lookups per call even when the caller's loop variable
already IS the `ObjectDefinition`. Prefer `helper(tenantId, resolvedObject:
ObjectDefinition)` whenever the call site has the object in scope; if the
helper is also called from apiName-only sites, add a sibling batch/by-id
accessor (e.g. `listFieldsByObjectId()`) so an id-holding caller doesn't force
a second `getObject()` round trip. (PR #1159, #1105 r2 —
`metadataService.listFieldsByObjectId()` added; the object comes from the
worker's own `listObjects()` loop.)

## Service module patterns — avoid `this.method()`

Services are exported as object literals (`export const fooService = { ... }`).
When one method calls another, reference the **module-level binding**
(`fooService.method()`), never `this.method()` — object-literal methods lose
their `this` binding when destructured or passed as a callback, and the two
usages are indistinguishable at the call site; the one that fails is whichever
gets destructured first.

```ts
// WRONG — `return this.install(...)` breaks if any caller does
// `const { installFromRegistry } = marketplaceService`.
// RIGHT — safe under destructure and callback passing:
export const marketplaceService = {
  async installFromRegistry(...) {
    return marketplaceService.install(...);
  },
  async install(...) { /* ... */ },
};
```

## Process-entrypoint guards — the guard only protects what's inside it (#1160)

`isProcessEntrypoint(import.meta.url)` from `core/utils/entrypoint.ts` makes a
CLI script / `worker.ts` / `index.ts` side-effect-free on import by gating the
`main()` / `bootstrap()` **invocation**:

```ts
if (isProcessEntrypoint(import.meta.url)) {
  bootstrap().catch((err) => { logger.error(err); process.exit(1); });
}
```

It does nothing for code above it at module scope: any top-level
`process.exit(...)`, argv/env validation that exits on failure, or other side
effect still runs the moment the module is imported — including by vitest
reaching for a named export, the exact failure class #1160 set out to
eliminate. Wrapping only the `main()` call while leaving a module-scope
usage-check or security gate outside it is an incomplete fix, not a partial
one.

```ts
// Exit-producing checks move INSIDE main() (or inside the guarded block), so
// import alone never exits. Trap: leaving them at module scope above the
// guard — they run on import regardless of what the guard wraps.
async function main() {
  if (!tenantSlug) {
    console.error('Usage: backfill-embeddings.ts <tenant-slug>');
    process.exit(1);
  }
  // ...
}
if (isProcessEntrypoint(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
```

When adding or auditing an entrypoint guard, grep the file for every
`process.exit(` and confirm each is inside the guarded function body or inside
the `if (isProcessEntrypoint(...))` block — not above it. (PR #1164, #1160 r2
— `bootstrap-super-admin.ts` and `backfill-embeddings.ts`.)

## Operator-CLI arg validation must check downstream HARD caps up front — and the added check needs a test (#1059)

A CLI/script flag that flows into a downstream operation with a hard cap
(`--batch-size` → OpenAI's 2048-input `embedBatch` limit, a `--concurrency`
→ pool-size ceiling, any `--limit` → a query cap) must be bounded against
that cap in the SAME usage-validation `if` block that already rejects
`<= 0` / non-integer — not left to fail deep in the operation. Two reasons:

1. **Fail-fast beats a deterministic retry storm.** A value that exceeds the
   downstream cap typically throws a plain (non-typed) `Error` synchronously
   *before* the first API call. If the CLI's retry loop only short-circuits on
   a typed permanent-error class, that plain Error is treated as transient and
   retried N times — always failing identically, since the oversized arg never
   changes — wasting the full retry budget on a deterministic caller mistake.
   Reject it immediately with the usage message instead. Read the cap from the
   downstream module's exported constant (`MAX_BATCH_INPUT`), don't hardcode a
   copy that can drift.

2. **The validation branch you add needs its own test.** A fix that adds an
   upper-bound (or any new arg-validation) branch to `main()` ships untested
   if the CLI's test file only covers the happy path + the permanent-error
   path. Mirror the existing arg-driven test shape (`vi.resetModules()` +
   `process.argv` mutation + re-import `main()`) and assert the oversized arg
   exits `1` via the usage branch WITHOUT reaching the downstream call
   (`findX`/`embedBatch` never invoked) — otherwise a later refactor of the
   validation block silently regresses the guard with zero CI signal. This is
   the arg-validation instance of `{{PATHS_RULES_DIR}}/testing.md` "does this
   assertion fail if I delete the fix?".

Precedent: PR #1241 (#1059) — `backfill-catalog-embeddings.ts`'s `--batch-size`
was validated only for `> 0` (code-audit sonnet round 1), letting a value
above `MAX_BATCH_INPUT` exhaust 3 retries; the round-1 upper-bound fix then
shipped without a test exercising it (round 2).

## Loop-invariant values in fallback/retry loops

In a `for`/`while` loop iterating a fallback ladder (model attempts, provider
retries, step attempts), any newly-added `const` computed in the loop body
MUST be checked against the loop variable: if it doesn't depend on the
per-iteration value (`modelChoice`, `attempt`, `i`), hoist it above the loop
alongside siblings already hoisted for that reason. A comment on a hoisted
sibling explaining "pure function of X/Y, which don't depend on the loop" is a
signal to apply the same reasoning to every value added nearby.

```ts
// Hoisted alongside its siblings; only the per-attempt call stays in the loop.
// Trap: declaring estimatedTokens inside the loop recomputes a pure function
// of systemContent/userContent — neither of which depends on modelChoice.
const systemContent = `...`;
const userContent = `...`;
const estimatedTokens = Math.ceil((systemContent.length + userContent.length) / 4) + 4096;
for (const modelChoice of step.models) {
  const budgetCheck = await tokenBudget.checkBudget(tenantId, userId, estimatedTokens);
  // ...
}
```

(`_ai-dispatcher.ts`'s `dispatchAi`, PR #1157 r1 — caught in the mandatory
self-audit loop, not shipped.)

## Caching

- L1 (LRU in-memory) + L2 (Redis), tenant-prefixed keys
- Check cache in service layer: `cache.get(tenantId, key)` / `cache.set(tenantId, key, value, ttl)`
- Invalidate on mutations — never leave stale cache
- Default TTL: 60 seconds for metadata

## Redis-based dedupe/coordination and system-wide event payloads (#1011)

**A comment describing a Redis `SET ... NX` (or similar shared-store) flag
must say "deployment-wide" / "cross-process, shared via Redis" — never
"process-wide".** Backed by an external store the flag dedupes across every
process pointed at the same Redis instance, so "process-wide" makes a reader
assume a weaker guarantee than the code provides and misjudge blast radius.
The trap is a comment reading "Deduped via a process-wide flag so repeated
failures only emit once" — it describes a Redis NX flag as if it coordinated
only one process. Write the scope out instead:

```ts
// Deduped via a Redis SET NX flag shared across every app-api/app-worker
// process on this deployment, so a rotation event that trips on many
// connections at once still emits exactly once cluster-wide.
const firstEmit = await redis.set(rotationFlagKey, '1', 'EX', 600, 'NX');
```

**System-wide event payloads must not smuggle instance-scoped fields.** When
an event genuinely applies platform-wide (an `ENCRYPTION_KEY` rotation affects
every tenant, not just whichever connection/tenant won the NX race to emit
it), the payload must not carry incidental per-instance identifiers
(`connectionId`, `tenantId`) from the caller that tripped the gate — a
subscriber can misread the field as "the affected scope" and act on it. So:
prefer an empty (or minimal, tenant/connection-free) payload for global
events; if a per-instance field must stay for debugging, its JSDoc must say
the value is "the first-seen example, not the affected scope"; and sweep every
sibling field with the same shape in one pass (`{{PATHS_RULES_DIR}}/workflow.md`
"Sibling sweep (canonical statement)"), including the event domain's
file-header doc if it documents a default payload shape (e.g. `{ tenantId,
... }`) a global event doesn't follow. (PR #1161, #1011 —
`KEY_ROTATION_DETECTED` dropped `connectionId` one round but kept the
identically-shaped `tenantId` until a later one; `integrations.events.ts`'s
file header needed a follow-up fix.)

## Fail-closed budget / quota ledgers (#1214)

A cross-tenant budget/quota ledger (marketplace call budget, rate cap, any
hard daily ceiling on Redis + a Postgres write-through) is a **security
control**, not a best-effort counter — its job is to DENY at the ceiling.
Three ways "deny" silently becomes "over-allow":

1. **Every accessor touching its Redis/PG dependencies — the debit WRITE path
   AND any read accessor (`getState`) — must wrap failures in the same typed
   fail-closed error and DENY**
   (`PlatformError(ERROR_CODES.X_BUDGET_UNAVAILABLE, ..., 503)`), never bubble
   a raw 500 or proceed; error-handling parity is a sibling sweep
   (`{{PATHS_RULES_DIR}}/workflow.md` "Sibling sweep (canonical statement)"). A
   `catch` covering more than one dependency (a Redis `eval` AND a Postgres
   seed `SELECT`) must not hardcode the log/metric as "Redis unavailable" —
   make it dependency-neutral or split the catch, so a PG outage isn't
   misattributed during on-call triage.
2. **A partial seed / partial write must THROW (deny), not log-and-continue**
   — a half-seeded day-key hash (a pipeline of `HSETNX`s whose per-command
   failures are merely logged) makes the next atomic debit read the missing
   `total` field as `0` and RESET the global ceiling. Inspect the
   `[err, result]` tuples `pipeline.exec()` resolves to (a per-command failure
   does NOT reject the whole `exec()`) and treat any seed error as fatal.
   Greppable proxy: any `pipeline.exec()` / `multi().exec()` whose result array
   is awaited but never inspected, near a quota/budget seed path.
3. **Validate the debit inputs BEFORE any key computation, Redis, or PG call**
   — the quantity (`calls`, `amount`) must be a positive integer (a `0` or
   negative `HINCRBY` manufactures headroom, reintroducing the refund mechanism
   a fail-closed design rejects), and the owner-scope key (`tenantId`) must be
   non-blank AFTER `.trim()` (`if (!tenantId)` passes whitespace, pooling
   unattributed calls into a shared `tenant:` bucket). Keep the JSDoc
   "execution order is normative" list in sync when a fix adds a check at step
   0 — a summary that still says "validate `calls`" after a `tenantId` check
   lands is docstring drift a reviewer will flag.

(PR #1223, #1214 — r1: partial-seed over-allow, un-trimmed `tenantId`;
code-audit: missing `getState` wrapper, misattributed metric, un-validated
`calls`.)

## Embedded Redis-Lua / raw-SQL script literals must not drift from module constants (#1214)

When a Lua script (Redis `EVAL`) or a raw-SQL template embeds a hash-field
name, column name, or key literal (`'total'`, `'last_value'`) that the rest of
the module refers to through a named constant (`TOTAL_SCOPE`), the two are a
silent-drift coupling: changing the constant leaves the script reading the old
literal, desyncing the atomic operation from every other read/write/seed path
with no compile-time or test signal. Pass the constant in as an `ARGV`/bound
parameter and reference it there, or — if it must stay a literal — pin it with
an inline `// must equal <CONST>` comment on the exact line. Greppable proxy:
a quoted string literal inside a `` sql`...` ``/Lua template that matches the
VALUE of a module `const` used elsewhere for the same field. (PR #1223, #1214
— a Lua `ATOMIC_DEBIT_SCRIPT` hardcoded `'total'` while the module used
`TOTAL_SCOPE`.)

## Dispatch / definitions tables keyed by an external string — use a `Map` or `Object.hasOwn` (#1214)

A dispatch/definitions table indexed by a caller-supplied (or provider/type)
string — `DEFINITIONS[provider]` on a plain object literal — resolves
inherited prototype keys (`'constructor'`, `'__proto__'`, `'toString'`) to
truthy members, bypassing a `if (!def)` guard so `def.method()` throws an
opaque `TypeError` (500) instead of the intended clean `ValidationError`. Back
the table with a `Map` (`.get()` returns `undefined` for any non-own key) or
guard with `Object.hasOwn(table, key)` before indexing — prefer `Map`, for
consistency with the registry pattern (`{{PATHS_RULES_DIR}}/registry.md`). Greppable
proxy: a bare `SOMETHING_DEFINITIONS[variable]` / `MAP[variable]`
object-literal index where `variable` is not a compile-time-known key. (PR
#1223, #1214 — `MARKETPLACE_CREDENTIAL_DEFINITIONS[provider]` on a plain
object while its sibling budget module already used a `Map`.)

## Docblock absolute/counted mechanism claims must be re-verified against every instance on change (#1233)

A docblock making an **absolute or counted claim about a mechanism** — "the
only copy of X", "the single source of truth", "all N of these positions go
through helper Y", "N call sites each thread Z" — is the prose sibling of the
Redis-Lua-literal drift above: true when written, false the moment the code it
summarizes changes, with no compile-time or test signal. Two shapes recur.
(1) **"Exactly one copy / single source of truth" after extracting a shared
helper — grep for the OTHER independent copies the extraction didn't touch**
(an admin-UI preview resolver, a consumer predating the extraction); either
fold the sibling into the new module in the same commit, or narrow the claim
explicitly ("one copy across the rewriter+resolver pair; the preview-only
`resolveVars` copy is deliberately excluded because …"). (2) **"N positions
via helper Y" — before bumping the count, confirm each NEWLY-counted item
actually uses Y**: "thirteen" → "seventeen" is wrong if one new position is
rewritten inline (a flat `isInternalObject` check with no import of the
helper), so carve out the exception ("sixteen via helper Y, plus one position
rewritten inline via the same per-element check") instead of a blind
word-swap.

Greppable proxy: a docblock phrase matching `only copy|single source of
truth|exactly one|all (thirteen|N|these) .* via` near an extraction or a count
a code change in the same PR touches. Same "the comment is part of the change;
verify it still holds" discipline as the Redis-Lua rule and the #1214
"docstring drift a reviewer will flag" note in "Fail-closed budget / quota
ledgers". (PR #1237, #1233 r1–2 — a merge-tag module's "exactly one copy" claim vs
`email-templates.service.ts`'s byte-identical `resolveVars`; then a
`thirteen`→`seventeen` swap claiming position #17 `polymorphicTargets` went
via the shared `value-ref-rewrite.ts` helpers when it is rewritten inline.)

## Storing secrets at rest (#738)

Every plaintext-secret column — webhook signing secrets, HMAC keys, MFA
secrets, API client secrets — MUST be encrypted at rest via the canonical
helper:

```ts
import {
  encryptColumnValue,
  decryptColumnValue,
  tryDecryptColumnValue,
  encryptToTriplet,
  decryptFromTriplet,
} from '../../core/crypto/encrypted-column.js';
```

**Single-column TEXT shape (preferred for new work):** the service layer
encrypts on write (`encryptColumnValue(input.secret)`); the repository layer
decrypts only at the read site handing plaintext to a downstream consumer
(HMAC sign, signature verify) — NOT in the path returning rows to the API
client, whose response envelope must strip the secret in `toRow()` or
equivalent. Read with `decryptColumnValue(row.secret)`; on
`EncryptedColumnError`, disambiguate via the rotation gate — a rotated
`ENCRYPTION_KEY` invalidates every ciphertext (system-wide, runbook recovers)
vs a single corrupt/tampered row (non-transient, inspect the row). Do NOT
silently return the raw bytes as "plaintext" — that corrupts every downstream
consumer (garbage HMAC signatures, raw bytes as auth config). Canonical shape:

```ts
import { decryptColumnValue, EncryptedColumnError } from '../../core/crypto/encrypted-column.js';
import { isKeyRotationDetected } from '../../core/crypto/key-rotation-guard.js';
import { PlatformError } from '../../core/errors.js';
import { ERROR_CODES } from '@orm/shared';

async function decryptSecret(row, tenantId) {
  try {
    return decryptColumnValue(row.secret);
  } catch (err) {
    if (!(err instanceof EncryptedColumnError)) throw err;
    if (await isKeyRotationDetected()) {
      logger.error({ tenantId, rowId: row.id }, '[#NNN] decrypt failed AND ENCRYPTION_KEY rotation detected');
      throw new PlatformError(
        ERROR_CODES.ENCRYPTION_KEY_ROTATION_DETECTED,
        'Decrypt failed under rotated ENCRYPTION_KEY. Follow the rotation runbook and re-deploy with ALLOW_ENCRYPTION_KEY_ROTATION_BACKFILL=true to acknowledge.',
        503,
      );
    }
    // Rotation ruled out → corruption / tampering. Surface a distinct
    // typed code (500) — or, for a verify path, return null so the
    // caller fails closed (signature-invalid) rather than 500.
    throw new PlatformError(ERROR_CODES.ENCRYPTED_COLUMN_DECRYPT_FAILED, 'Decrypt failed (corruption or tampering, not rotation).', 500);
  }
}
```

The canonical read-side example lives in
`domains/events/webhooks.repository.decryptWebhookSecret`. Greenfield code has
no plaintext / legacy-key fallback — secrets are encrypted-on-write, so a
decrypt failure is always rotation or corruption. (The transitional
legacy-decrypt + boot-backfill machinery was removed in #738 Sub-phase I;
`ALLOW_ENCRYPTION_KEY_ROTATION_BACKFILL` retains its historical suffix but now
only acknowledges the rotation to the boot fingerprint guard.)

**Three-column triplet shape (legacy schemas only):** `tenant_secrets`,
`integration_tokens`, and any pre-existing schema with three separate
`encrypted_value` / `iv` / `auth_tag` BYTEA columns use `encryptToTriplet` /
`decryptFromTriplet`. Do NOT add new triplet-shaped columns in greenfield work
— single-TEXT is the canonical going-forward shape.

**Key derivation:** one source, `config.encryptionKey` (the `ENCRYPTION_KEY`
env var). **Never** use `config.jwtSecret` for column encryption — JWT
rotation must not invalidate stored secrets. (Pre-#738 the TOTP path violated
this; #738 moved every column onto `config.encryptionKey` and Sub-phase I
removed the last transitional `jwtSecret`-keyed decrypter.)

**Migration discipline:** add an `-- encrypted-at-rest: encryptColumnValue
(#NNN)` comment to the migration introducing the column (or to a follow-up
marker migration like `121_encrypt_webhooks_secret.sql` if the column
pre-dates this rule). The arch test
`packages/backend/src/__tests__/encrypted-secret-columns.test.ts` enforces the
marker at CI time — columns added without it (and not allowlisted) fail the
build.

## Ack-before-async-work endpoints — the upstream does not redeliver on the async failure (#1215)

A webhook/notification/compliance endpoint that returns `200`/`accepted` as
soon as it has verified and durably recorded the inbound payload, THEN
enqueues the real work
asynchronously (a BullMQ purge/sync/index job), has a recovery gap the ack
hides: the sender's retry policy fires only on a **non-2xx response**, and
this endpoint already returned 200, so a job that exhausts its retries into
`partial`/`failed` is never redelivered. Therefore:

- **Never document upstream redelivery as the recovery path** for a post-ack
  async failure (a truth table, a `.add()`-justification comment, a runbook
  step) — it's unreachable, as is any justification reasoning about "a prior
  non-2xx delivery" or "the provider retries this". State what actually
  happens: the FIRST delivery enqueues the first job; post-200 failure
  recovery is owned solely by a periodic reconciliation worker (mirroring
  `record-embedding-reconciliation.worker.ts`) that re-enqueues rows in a
  non-terminal status past a staleness window, independent of the sender.
- **Land that reconciliation worker in the same PR as the first real work
  target** — or, if the work registry is genuinely empty at v1 so the failure
  state is structurally unreachable, document the manual SQL/ops recovery in
  the deploy runbook AND state the worker is required the moment the first
  target registers. "Out of scope: any admin UI/API over the audit table" is
  not a recovery plan.
- See `{{PATHS_RULES_DIR}}/testing.md` "BullMQ deterministic-jobId recovery gap on
  permanent-failure retries (#1100)" for the companion fact that BullMQ
  `add()` no-ops against a retained FAILED jobId — manual recovery must clear
  the failed job first.

(PR #1229, #1215 r3 / opus r1 — the eBay account-deletion spec's CARD-SR-8
truth table claimed redelivery-based recovery; a step-7 enqueue justification
reasoned about a prior non-2xx delivery.)

## Platform-level external HTTP calls that bypass the Integrations executor (#1215)

A **platform-level** (not tenant-scoped) provider call — a shared-keyset OAuth
token fetch, a public-key fetch for signature verification — has no
`integration_connections` row to attach to, so it legitimately bypasses the
Integrations executor (tenant-adapter analog:
`{{PATHS_RULES_DIR}}/integration-adapters.md` "Native / local adapters are the
exception") along with its per-request timeout, circuit breaker, and SSRF
validation. The raw `fetch()` MUST re-supply them:

- **An explicit timeout** — `fetch(url, { signal: AbortSignal.timeout(10_000),
  … })`. Node's `fetch()` has none by default, and a hung provider endpoint
  hangs the request handler (and any worker reusing the helper).
- **A module comment documenting the bypass** as deliberate and platform-level
  (no tenant connection to route through), so a reviewer doesn't read the raw
  `fetch` as an oversight.
- **A bound on any cache keyed on attacker-controlled, pre-verification
  input** (a signature `kid` read from an inbound header before the signature
  is verified can be flooded with distinct values). Bound the cache the forged
  input actually populates: a distinct-`kid` flood 404s into the NEGATIVE
  (deny) cache, so the count bound + eviction belongs there, not only on the
  positive cache forged keys never reach. A TTL alone is not a bound —
  `(flood-rate × TTL)` is still unbounded memory + one outbound provider fetch
  per distinct key — so cap entries (LRU/oldest-evict) as well.

(PR #1229, #1215 r2 — `ebay-app-token.ts` / `ebay-notification-keys.ts` shipped
without timeouts or the rationale, and the TTL-only negative cache made a
forged-`kid` flood an unbounded-memory + outbound-amplification DoS on an
endpoint exempt from the per-IP rate limiter; the "so forged kids can't grow
it" rationale sat on the positive cache, which forged kids never touch.)

## Middleware

- Use `fastify-plugin` (fp) wrapper to avoid scope encapsulation
- Tenant context set by middleware: access via `request.tenantId`

## Logging

- Use `request.log` in route handlers (includes request context)
- Use `logger` from `core/logger.ts` elsewhere (pino)
