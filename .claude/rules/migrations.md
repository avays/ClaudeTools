---
globs:
  - "migrations/**"
---

# Migration File Conventions

## File Naming

`NNN_description.sql` (zero-padded 3-digit prefix, underscores:
`004_add_automation_tables.sql`). Check existing files for the next number.

## Required Elements for Tenant-Scoped Tables

```sql
CREATE TABLE table_name (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  -- ... other columns ...
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE table_name ENABLE ROW LEVEL SECURITY;
-- #543: omit `, true` (missing_ok) from current_setting so the policy raises
-- when `app.current_tenant_id` is unset rather than silently filtering all rows.
-- Every query path MUST first run inside withTenant().{transaction|
-- readOnlyTransaction|writeTransaction}() which calls SET LOCAL app.current_tenant_id.
CREATE POLICY tenant_isolation ON table_name
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE INDEX idx_table_name_tenant ON table_name(tenant_id);
```

## Rules

- Never modify existing migration files — always create new ones.
- Include appropriate indexes (tenant_id, unique constraints, FKs).
- Migrations auto-run on server startup via `core/migrate.ts`, each in a
  transaction.

## `CREATE INDEX CONCURRENTLY` is not available — document large-table index builds instead

`core/migrate.ts` wraps every migration in a single transaction, and
Postgres forbids `CREATE INDEX CONCURRENTLY` inside a transaction block —
so every index build takes a write lock. This is an accepted, structural
tradeoff of the in-transaction migration model; a review finding suggesting
`CONCURRENTLY` is a known false positive — don't rework the migration.

What IS required: when a migration adds an index (or a backfill `UPDATE`)
on a table that can be large in a real install (`records`, `audit_logs`,
anything without a small fixed row count), add a deploy-time caveat comment
documenting the write-lock window and, if backfill + index build share the
transaction, which is the heavier cost. Precedent: PR #1159 (#1105) r1
rejected a `CONCURRENTLY` suggestion for migration 150's
`idx_records_needs_embedding`; r2/r4 added the caveat and noted the
backfill `UPDATE` is the heavier operation.

## Kysely interface sync (mandatory companion step)

Every migration that adds/removes/renames a column MUST edit the matching
Kysely table interface in `packages/backend/src/core/db.ts` **in the same
commit**. Repositories use `as any` casts, so the migration works at
runtime with a stale interface — the bug surfaces at SELECT time, where
`toEntity(row)` casts into the interface type and silently drops
undeclared columns from the API response.

- Add a column → add a field (`Generated<T>` for DB defaults; plain `T`
  otherwise). Drop → delete the field. Rename → both.
- New table → add the `XxxTable` interface AND the `Database` mapping.

### A stale interface is invisible until it drops a column — never treat `core/db.ts` as the closed-ended column list

The sync rule is regularly violated silently, so **never derive a "these
are all the columns of table X" completeness claim from the Kysely
interface alone** — `.selectFrom('table' as any).selectAll()` (and raw
`SELECT *`) still return undeclared columns at runtime, so exporters
serializing whole rows keep carrying a column that any write path
enumerating columns off the interface silently omits. That
export-carries/write-drops asymmetry is exactly the round-trip data-loss
class deployer/serializer specs exist to close. Verify closed-ended column
deltas against `grep -n "ADD COLUMN" packages/backend/migrations/*.sql`
(or `\d object_definitions`), not the TS interface.

Two follow-on traps when reading the interface for column facts:

1. **Nullable-with-default columns are frequently mis-typed as non-null.**
   A `TEXT DEFAULT 'name'` (no `NOT NULL`) column is nullable at the DB
   level; don't infer a `NOT NULL` constraint (or a 23502-on-null
   rationale) from the TS type — check the migration's actual constraint.
2. **`ColumnType<Read, Insert, Update>` for JSONB/serialized columns** — a
   column read as a parsed object but written as a `JSON.stringify`'d
   string needs `ColumnType<Record<string, unknown>, string, string> |
   null`, not a bare `Record<...>`.

Precedent: PR #1211 (#1201) — migration 054's `embedding_config` was never
added to `ObjectDefinitionTable`, so a spec's interface-derived column
delta omitted it and the deployer dropped it on both paths while
`exportMetadata`'s `selectAll()` carried it; separately `display_field`
(migration 024, nullable) was typed `string` and mis-labeled NOT NULL in a
guard comment.

## Next migration number

`ls packages/backend/migrations/ | sort -V | tail -1` gives the highest
prefix; take the NEXT integer. Historic duplicates exist (two `057_*.sql`,
two `058_*.sql`) — `ls | wc -l` is not a reliable next-number source; the
file count intentionally exceeds the highest prefix.

## Prefix collision on merge/rebase — renumber the unmerged migration

Parallel branches race on the next prefix (three branches claimed 142 in
the #946/#985/#947 window). The branch that merged first keeps the number;
**renumber the unmerged one to the next free integer**. Never ship a NEW duplicate prefix — the
historic 051/057/058 duplicates are grandfathered, not precedent.

Renumbering is more than the rename — sweep every reference to YOUR
migration (leave the other branch's mentions alone):

```bash
grep -rn "migration NNN\|NNN_your_migration_name" .ai/ packages/ CLAUDE.md
```

Known reference sites: the file itself, `core/db.ts` interface comments,
`{{PATHS_SPECS_DIR}}/<feature>.md`, and the context docs (`CHANGELOG.md`,
`SCHEMA.md` — including its highest-prefix/total-files count line —
`BUILD_STATE.md` Key Counts, `DOMAINS.md`, `SHARED_TYPES.md`). Prose
mentions ("Migration NNN adds…") are the easy miss — grep both the number
and the filename (PR #988 r3: one prose mention survived the first sweep).
