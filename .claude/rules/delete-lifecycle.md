# Delete Lifecycle Conventions

Applies to **any domain that adds a DELETE route** for a tenant-scoped entity
(metadata, RBAC, automation, etc.). Codifies the pattern we've shipped across
`delete_layout` (#406/#407), `delete_profile` (#410/#413), and
`delete_permission_set` (#411/#416).

Reading this rule and matching the pattern saves roughly two rounds of Copilot
review per delete feature — the issues below came up on every PR until we
learned them.

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
- `.forUpdate()` on the target serializes concurrent deletes of the same id.
- Additional `.forUpdate()` on peer/sibling tables if the invariant requires atomicity across rows (see `delete_layout`'s peer-lock for last-layout invariant).
- Compare `numDeletedRows` as bigint (`=== 0n`, not `Number(...) === 0`).
- Catch 23503 FK violations after the COUNT→DELETE window; map to `in-use`.
- Return a discriminated union, **don't throw inside the transaction** — keeps the service layer's error mapping clean.

## Unique-violation handling: branch on `err.constraint`, not just `err.code`

Postgres returns `23505` for *every* unique index violation. When a table
has multiple unique indexes (e.g. a normal unique constraint AND a partial
unique index like `idx_rcl_single_primary`), a single `if (err.code ===
'23505')` handler will conflate distinct failure modes into one
misleading error code.

```typescript
// WRONG — every 23505 becomes "duplicate link" regardless of which index fired
try {
  return await containersRepository.insertLink(trx, { ... });
} catch (err: any) {
  if (err?.code === '23505') {
    throw new PlatformError('CONTAINER_LINK_DUPLICATE', '...', 409);
  }
  throw err;
}

// CORRECT — branch on err.constraint so each unique index maps to its own error code
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

Node-postgres surfaces the constraint name as `err.constraint`. For other
drivers, check the equivalent field (e.g. `err.originalError?.detail`
pattern-match). Map each distinct constraint to its own stable
`PlatformError` code so the frontend's `onError` branch can render the
right copy.

Caught in PR #485 round 3 — single-primary index race was being reported
as `CONTAINER_LINK_DUPLICATE` even when nothing was duplicated.

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

**Error codes, not messages:** generic `ConflictError` forces the UI to
regex-match the message text, which breaks the moment someone edits the copy.
Always use `new PlatformError('ENTITY_SPECIFIC_CODE', message, 409)` with a
stable, domain-specific string constant. The frontend branches on `err.code`.

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

Every delete domain gets at minimum these integration tests:

1. Happy-path delete of a non-system, unassigned entity → 204, row gone from list.
2. Delete a system entity (is_system = true) → 409 with `error.code === 'ENTITY_IS_SYSTEM'`.
3. Delete an in-use entity (with real assignment seeded in the test) → 409 with `error.code === 'ENTITY_IN_USE'`.
4. Delete a non-existent id → 404.
5. Cross-tenant isolation: tenant A deleting tenant B's entity → 404, row still present in tenant B.

Tests MUST seed real assignments for the in-use case — don't conditionally skip
("if the seeded profile is non-system"). A test that silently no-ops when the
seed data doesn't match the assumption passes vacuously.

## Frontend — Admin UI

See `.claude/rules/frontend.md` for the full pattern. Summary:

- `Trash2` icon button on non-system rows (hidden on `is_system`, and on
  self-rows using impersonation-aware identity for user-like entities).
- `ConfirmDialog` with `variant='danger'`.
- `useToast` with `err instanceof ApiError && err.code === 'ENTITY_IS_SYSTEM'`
  branching — never regex on `err.message`.
- `ConfirmDialog.onConfirm` guard against re-entrancy:
  `if (mutation.isPending) return;` (the dialog itself doesn't disable).

## Common missteps to avoid

1. **Omitting the explicit in-use count** because "the FK has RESTRICT / CASCADE
   and Postgres will handle it." RESTRICT makes the delete fail with a
   mid-transaction 23503 that surfaces as a 500 unless caught; CASCADE silently
   strips assignments. Count first, always.

2. **Using `ConflictError` for multiple 409 cases.** The UI can't tell
   "system" from "in-use" without regex. Use `PlatformError` with a dedicated
   `code` string.

3. **Forgetting the self-row hide.** For user-like entities (users, API keys)
   always use `impersonation?.targetUser.id ?? user.id` as the effective self —
   NOT `user.id` alone. During impersonation `user` stays the original admin
   while the access token is the target's.

4. **Shipping a delete button that triggers the route twice on fast
   double-click.** `ConfirmDialog` doesn't disable its own confirm button.
   Guard the mutation in `onConfirm`: `if (mutation.isPending) return;`.

5. **Missing test for the in-use branch.** A test like
   `if (profile && !profile.isSystem) { expect(409) }` passes vacuously when
   the seed data is a system profile. Seed the non-system case explicitly.

## Precedents

- `delete_layout` — `#406` / `#407`
- `delete_profile` — `#410` / `#413`
- `delete_permission_set` — `#411` / `#416`

## Architecture-test references (#537)

The arch tests `error-codes-registry.test.ts` (backend) and
`error-toast-registry.test.ts` (frontend) hold the FE/BE error-code
contract steady. Every typed `PlatformError` thrown by a delete service
(`PROFILE_IS_SYSTEM`, `PROFILE_IN_USE`, `PERMISSION_SET_IS_SYSTEM`,
`PERMISSION_SET_IN_USE`, `LAYOUT_LAST`, `CUSTOM_PAGE_IN_USE`, etc.) is
registered in `ERROR_CODES`; CI rejects an unregistered literal.
`permissions-registry.test.ts` similarly enforces the manage-X gate on
delete routes via `PERMISSIONS.X`. Treat these tests as the binding rule;
the prose sections above are the explanation.

## Lookup deleteConstraint defaults (#694)

When `deleteConstraint` is `null` or absent, `deleteRecord()` in
`data.service.ts` applies these defaults per field type:

| Field Type | Default when `deleteConstraint` is null/missing | Notes |
|---|---|---|
| `Lookup` | `SetNull` — clears the `lookup_values` key | Least surprising; referencing field becomes blank |
| `PolymorphicLookup` | `SetNull` — clears the `lookup_values` sub-object key | Same semantics as Lookup; stores `{ objectApiName, recordId }` sub-object |
| `MasterDetail` | Always `Cascade` — cannot be configured | Required to maintain referential integrity |

The typed error code thrown by the `Restrict` pre-flight check is
`LOOKUP_RESTRICT_REFERENCED` (registered in
`packages/shared/src/constants/error-codes.ts`). Frontend callers can
branch on `err.code === ERROR_CODES.LOOKUP_RESTRICT_REFERENCED` via
`useApiErrorToast`. Default user-facing copy lives in
`packages/frontend/src/lib/errorCopy.ts`.

**PolymorphicLookup SQL predicate note**: PolymorphicLookup fields store
references as `{ objectApiName, recordId }` JSONB sub-objects inside
`lookup_values`. The cascade walk uses BOTH sub-keys to match child rows:

```sql
-- Restrict / SetNull / Cascade WHERE clause for PolymorphicLookup:
lookup_values -> 'fieldApiName' ->> 'recordId' = parentId
AND lookup_values -> 'fieldApiName' ->> 'objectApiName' = parentObjectApiName
```

Both predicates are required — a polymorphic field can reference multiple
object types via the same field name, so matching only `recordId` would
act on children referencing a different object type that happens to share
the same record ID.

**Recycle-bin restore — cascade children (#696)**: `undeleteRecord()` in
`recycle-bin.service.ts` walks the cascade tree for MasterDetail, Lookup
Cascade, and PolymorphicLookup Cascade children. Children that were
soft-deleted within 5 seconds of the parent's `deleted_at` (i.e., as part
of the same cascade transaction) are automatically restored alongside the
parent. Children that were independently soft-deleted before the parent
are NOT restored (time-window guard). Fixed in #696.
