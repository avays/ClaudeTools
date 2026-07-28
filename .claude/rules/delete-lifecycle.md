# Delete Lifecycle Conventions

Applies to **any domain that adds a DELETE route** for a tenant-scoped entity
(metadata, RBAC, automation, …). Codifies `delete_layout` (#406/#407),
`delete_profile` (#410/#413), `delete_permission_set` (#411/#416).

## Backend — Repository method

**Single transactional method, discriminated result.**

```ts
async deleteEntity(
  tenantId: string,
  id: string,
): Promise<
  | { kind: 'deleted' } // plus any context the service needs (e.g. objectId, wasDefault, promotedId)
  | { kind: 'not-found' }
  | { kind: 'system' }   // omit if the entity has no is_system concept
  | { kind: 'in-use'; userCount?: number; profileCount?: number; ... }
> {
  return await withTenant(tenantId).transaction(async (trx: TenantScopedTrx) => {
    // 1. Lock the target row FIRST.
    const target = await trx
      .selectFrom('entities')
      .select(['id', 'is_system', /* other fields needed for follow-up */])
      .where('id', '=', id)
      .forUpdate()                                      // ← critical
      .executeTakeFirst();
    if (!target) return { kind: 'not-found' as const };

    // 2. System guard BEFORE in-use (cheaper check; built-ins never deletable).
    if (target.is_system) return { kind: 'system' as const };

    // 3. Explicit in-use check for every cascade-assignment table.
    //    Cascade-delete on the FK means a naive delete SILENTLY strips the
    //    assignment. You must count first and reject unless all counts are zero.
    const [userCountRow, profileCountRow] = await Promise.all([
      trx.selectFrom('user_assignments')
        .select((eb: any) => eb.fn.countAll().as('count'))
        .where('entity_id', '=', id)
        .executeTakeFirst(),
      // ... one count per assignment table
    ]);
    const userCount = Number((userCountRow as any)?.count ?? 0);
    // ... sum or per-table counts depending on what the service needs
    if (userCount > 0 /* || ... */) {
      return { kind: 'in-use' as const, userCount };
    }

    // 4. Delete with bigint comparison + defensive not-found guard.
    //    executeTakeFirst() can return undefined; use optional chaining.
    try {
      const del = await trx.deleteFrom('entities').where('id', '=', id).executeTakeFirst();
      if ((del?.numDeletedRows ?? 0n) === 0n) {
        return { kind: 'not-found' as const };
      }
      return { kind: 'deleted' as const };
    } catch (err: any) {
      // 5. Map FK-violation races (concurrent INSERT during the count→delete
      //    window) to in-use rather than bubbling as a 500.
      if (err?.code === '23503') {
        const recheck = await trx
          .selectFrom('user_assignments')
          .select((eb: any) => eb.fn.countAll().as('count'))
          .where('entity_id', '=', id)
          .executeTakeFirst();
        return { kind: 'in-use' as const, userCount: Number((recheck as any)?.count ?? 0) };
      }
      throw err;
    }
  });
}
```

**Key points:**
- `trx: TenantScopedTrx` (NOT `any`) — preserves tenant-scoped query-wrapper typing.
- `.forUpdate()` serializes concurrent deletes of the same id; add it on peer/sibling tables when the invariant needs cross-row atomicity (`delete_layout`'s peer-lock, last-layout invariant).
- Compare `numDeletedRows` as bigint (`=== 0n`), never `Number(...) === 0`; always catch 23503 FK violations from the COUNT→DELETE window and map them to `in-use`.
- Return a discriminated union — **never throw inside the transaction**; it keeps service-layer error mapping clean.

## Unique-violation handling: branch on `err.constraint`, not just `err.code`

Postgres returns `23505` for *every* unique index violation, so on a table with
multiple unique indexes (a plain unique constraint AND a partial one like
`idx_rcl_single_primary`) a bare `if (err.code === '23505')` conflates distinct
failure modes into one misleading code. Branch on the constraint name:

```typescript
try {
  return await containersRepository.insertLink(trx, { ... });
} catch (err: any) {
  if (err?.code === '23505') {
    if (err?.constraint === 'idx_rcl_single_primary') {
      throw new PlatformError(
        'CONTAINER_PRIMARY_CONFLICT',
        'Another request set a primary container for this record concurrently. Retry.',
        409,
      );
    }
    // Fallback is the "normal" duplicate-pair case.
    throw new PlatformError('CONTAINER_LINK_DUPLICATE', '...', 409);
  }
  throw err;
}
```

Node-postgres exposes the name as `err.constraint` (other drivers: the
equivalent field, e.g. `err.originalError?.detail` pattern-match). Every
distinct constraint MUST map to its own stable `PlatformError` code so the
frontend's `onError` renders the right copy. (PR #485 r3 — the single-primary
race reported `CONTAINER_LINK_DUPLICATE` when nothing was duplicated.)

## Backend — Service method

```ts
async deleteEntity(tenantId: string, id: string): Promise<void> {
  const result = await entityRepository.deleteEntity(tenantId, id);
  if (result.kind === 'not-found') {
    throw new NotFoundError(`Entity not found: ${id}`);
  }
  if (result.kind === 'system') {
    throw new PlatformError(
      'ENTITY_IS_SYSTEM',                               // ← dedicated code
      'Cannot delete a system entity. Built-in entities are required by the platform.',
      409,
    );
  }
  if (result.kind === 'in-use') {
    throw new PlatformError(
      'ENTITY_IN_USE',                                  // ← dedicated code
      `Cannot delete — ${result.userCount} user(s) are assigned. Unassign first.`,
      409,
    );
  }
  emitEvent('entity.deleted', { tenantId, entityId: id, ... });
  // Invalidate any caches/permissions downstream.
}
```

**Error codes, not messages:** always throw
`new PlatformError('ENTITY_SPECIFIC_CODE', message, 409)` with a stable,
domain-specific constant — a generic `ConflictError` forces the UI to regex
message copy, which breaks on the next copy edit. The frontend branches on
`err.code`; `ERROR_CODES` registry mechanics are canonical in
`{{PATHS_RULES_DIR}}/backend-general.md` "Error code registry".

## Backend — Route

```ts
app.delete('/api/v1/admin/entities/:id', {
  schema: {
    tags: ['<Category>', 'llm-tool'],                    // category must be in SKILL_CATEGORIES
    summary: 'Delete an entity',
    description: 'Delete by id. 409 if system or in-use. Requires manageX.',
    operationId: 'delete_entity',                        // snake_case, globally unique
    'x-zod-params': UuidParamsSchema,                    // mandatory for :id routes
    'x-requires-permission': ['manageX'],
    response: { 204: { type: 'null', description: 'Deleted' } },
  },
  preHandler: [requireAuth, requireManageX],
}, async (request, reply) => {
  const { id } = UuidParamsSchema.parse(request.params);
  await entityService.deleteEntity(request.tenantId, id);
  logAudit(request, CATEGORY, ENTITY_TYPE, id, 'delete');  // no empty {} details arg
  reply.code(204);
});
```

## Backend — Tests

Minimum integration tests per delete domain:

1. Happy-path delete of a non-system, unassigned entity → 204, row gone from list.
2. Delete a system entity (is_system = true) → 409 with `error.code === 'ENTITY_IS_SYSTEM'`.
3. Delete an in-use entity (with real assignment seeded in the test) → 409 with `error.code === 'ENTITY_IN_USE'`.
4. Delete a non-existent id → 404.
5. Cross-tenant isolation: tenant A deleting tenant B's entity → 404, row still present in tenant B.

Tests MUST seed real assignments for the in-use case, never conditionally skip
("if the seeded profile is non-system") — a test that no-ops when seed data
doesn't match its assumption passes vacuously.

## Frontend — Admin UI

Full patterns: `{{PATHS_RULES_DIR}}/frontend.md`, `{{PATHS_RULES_DIR}}/frontend-components.md`.

- `Trash2` icon button on non-system rows (hidden on `is_system`, and on
  self-rows using impersonation-aware identity for user-like entities).
- `ConfirmDialog` with `variant='danger'`.
- `useToast` / `useApiErrorToast` branching on `err instanceof ApiError &&
  err.code === 'ENTITY_IS_SYSTEM'` — never regex on `err.message`.
- Guard destructive confirms with a `useRef` latch + `isPending`
  (`if (inFlightRef.current || mutation.isPending) return;` with an `onSettled`
  clear) — `isPending` alone is insufficient and `ConfirmDialog` never disables
  its own confirm button; full pattern in `frontend.md` "ConfirmDialog —
  re-entrancy guard".

## Common missteps to avoid

1. **Omitting the explicit in-use count** because "the FK has RESTRICT /
   CASCADE and Postgres will handle it." RESTRICT fails mid-transaction with a
   23503 that surfaces as a 500 unless caught; CASCADE silently strips
   assignments. Count first, always.
2. **Using `ConflictError` for multiple 409 cases.** The UI can't tell "system"
   from "in-use" without regex — every 409 branch MUST carry its own
   `PlatformError` `code` (mechanics: `backend-general.md` "Error code
   registry").
3. **Forgetting the self-row hide.** For user-like entities (users, API keys)
   the effective self is always `impersonation?.targetUser.id ?? user.id`,
   never `user.id` alone — under impersonation `user` stays the original admin
   while the access token is the target's (`frontend.md` "Self-identity under
   impersonation").
4. **A delete button that fires the route twice on fast double-click.** Guard
   destructive confirms with a `useRef` latch + `isPending`
   (`if (inFlightRef.current || mutation.isPending) return;` with an `onSettled`
   clear) — `isPending` alone is insufficient; full pattern in `frontend.md`
   "ConfirmDialog — re-entrancy guard".
5. **Missing test for the in-use branch.** A test like
   `if (profile && !profile.isSystem) { expect(409) }` passes vacuously when
   the seed data is a system profile. Seed the non-system case explicitly.

## Destructive operations broader than a single DELETE route (#1162)

Everything above targets the single-entity DELETE case; the same two rules
apply — with sharper stakes — to any **irreversible multi-table destructive
operation** gated by a status/typed-confirmation guard (bulk purge, cascade
delete, tenant deprovisioning), not just a literal `DELETE /entities/:id`.

1. **Re-verify status guards under a lock INSIDE the mutating transaction,
   never via a pre-transaction read.** "Lock the target row FIRST" isn't only
   about existence/`is_system`: any boolean/status precondition (`isActive`,
   `status = 'draft'`, …) has the same TOCTOU window — a service-layer
   `getEntity()` read plus a *separate* repository transaction leaves a gap
   where the guarded state can change. Re-check with `SELECT ... FOR UPDATE` as
   the first statement of the destructive transaction and abort with the same
   typed error if it no longer holds.
2. **Typed-confirmation strings (`confirmSlug`, "type DELETE to confirm", …)
   MUST be trimmed server-side too**, identically to the frontend
   (`input.confirmSlug.trim() === entity.slug`) — not just for UX parity: the
   endpoint is reachable by any authenticated non-UI caller (CLI, MCP client,
   another service) that gets no client-side normalization. Same rule as
   `{{PATHS_RULES_DIR}}/frontend-components.md` "Validate the value you submit",
   applied to the backend side of the gate.

Precedent: `{{PATHS_SPECS_DIR}}/tenant-purge-delete-cascade.md` (#1162, PR #1169) —
spec-audit r1 flagged the pre-transaction `isActive` read (TOCTOU); Copilot r2
the un-trimmed `confirmSlug`.

## Precedents

- `delete_layout` — `#406` / `#407`
- `delete_profile` — `#410` / `#413`
- `delete_permission_set` — `#411` / `#416`

## Architecture-test references (#537)

`error-codes-registry.test.ts` (backend) and `error-toast-registry.test.ts`
(frontend) hold the FE/BE error-code contract steady: every typed
`PlatformError` a delete service throws (`PROFILE_IS_SYSTEM`, `PROFILE_IN_USE`,
`PERMISSION_SET_IS_SYSTEM`, `PERMISSION_SET_IN_USE`, `LAYOUT_LAST`,
`CUSTOM_PAGE_IN_USE`, …) MUST be registered in `ERROR_CODES` — CI rejects an
unregistered literal. `permissions-registry.test.ts` enforces the manage-X gate
on delete routes via `PERMISSIONS.X`. When either fires, register the
code/permission; never loosen the test — the tests are the binding rule,
this prose is the explanation.

## Lookup deleteConstraint defaults (#694)

When `deleteConstraint` is `null`/absent, `deleteRecord()` in `data.service.ts`
applies these defaults per field type:

| Field Type | Default when `deleteConstraint` is null/missing | Notes |
|---|---|---|
| `Lookup` | `SetNull` — clears the `lookup_values` key | Least surprising; referencing field becomes blank |
| `PolymorphicLookup` | `SetNull` — clears the `lookup_values` sub-object key | Same semantics as Lookup; stores `{ objectApiName, recordId }` sub-object |
| `MasterDetail` | Always `Cascade` — cannot be configured | Required to maintain referential integrity |

The `Restrict` pre-flight check throws `LOOKUP_RESTRICT_REFERENCED` (registered
in `packages/shared/src/constants/error-codes.ts`); frontend callers branch on
`err.code === ERROR_CODES.LOOKUP_RESTRICT_REFERENCED` via `useApiErrorToast`,
default copy in `packages/frontend/src/lib/errorCopy.ts`.

**PolymorphicLookup SQL predicate**: references are `{ objectApiName, recordId }`
JSONB sub-objects inside `lookup_values`; the cascade walk MUST match children
on BOTH sub-keys:

```sql
-- Restrict / SetNull / Cascade WHERE clause for PolymorphicLookup:
lookup_values -> 'fieldApiName' ->> 'recordId' = parentId
AND lookup_values -> 'fieldApiName' ->> 'objectApiName' = parentObjectApiName
```

One field name can reference multiple object types, so matching `recordId` alone
would act on children pointing at a different object type that shares the ID.

**Recycle-bin restore — cascade children (#696)**: `undeleteRecord()` in
`recycle-bin.service.ts` walks the cascade tree for MasterDetail, Lookup
Cascade, and PolymorphicLookup Cascade children. Children soft-deleted within
5 seconds of the parent's `deleted_at` (same cascade transaction) are restored
alongside the parent; children independently soft-deleted earlier are NOT
restored (time-window guard).
