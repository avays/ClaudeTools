---
globs:
  - "migrations/**"
---

# Migration File Conventions

## File Naming
- Format: `NNN_description.sql` (zero-padded 3-digit prefix)
- Check existing files to determine next number
- Description uses underscores: `004_add_automation_tables.sql`

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
- Never modify existing migration files
- Always create new migration files for schema changes
- Include appropriate indexes (tenant_id, unique constraints, foreign keys)
- Migrations auto-run on server startup via `core/migrate.ts`

## Kysely interface sync (mandatory companion step)

Every migration that adds, removes, or renames a column MUST include a
matching edit to the Kysely table interface in
`packages/backend/src/core/db.ts`. The backend repositories use
`.insertInto('table' as any)` and `.selectFrom('table' as any)`, so the `as any`
cast silently bypasses column-name typing on INSERT — the migration will work
at runtime even when the interface is stale. The bug surfaces at SELECT time:
`toEntity(row)` casts the result into the interface type, which drops any
column that isn't declared. Fields you expect in the API response silently
disappear from the TypeScript type.

- Adding a column → add a field to the `XxxTable` interface. Use `Generated<T>`
  for columns with a DB default; plain `T` otherwise.
- Dropping a column → delete the field from the interface.
- Renaming → both of the above.
- Adding a new table → add the `XxxTable` interface AND include it in the
  top-level `Database` interface mapping.

Do this edit in the same commit as the migration — not a follow-up.

## Next migration number

`ls packages/backend/migrations/ | sort -V | tail -1` gives the highest
existing number. Take the NEXT integer. Historic duplicates (e.g. two `057_*.sql`,
two `058_*.sql` files) exist — `ls | wc -l` is not a reliable next-number
source, and the file count intentionally exceeds the highest prefix.

## Prefix collision on merge/rebase — renumber the unmerged migration

Parallel feature branches inherently race on the next prefix (prefix 142 was
claimed by three branches during the #946/#985/#947 window). When syncing
your branch with its base and both added the same prefix, the branch that
merged first keeps the number; **renumber the unmerged one** to the next
free integer. Never ship a NEW duplicate prefix — the historic 051/057/058
duplicates are grandfathered, not precedent.

Renumbering is more than the file rename. Run a reference sweep and update
every hit that refers to YOUR migration (leave the other branch's mentions
of the number alone):

```bash
grep -rn "migration NNN\|NNN_your_migration_name" .ai/ packages/ CLAUDE.md
```

Known reference sites: the migration file itself, `core/db.ts` interface
comments, `.ai/specs/<feature>.md`, and the context docs
(`CHANGELOG.md`, `SCHEMA.md` — including its "highest prefix / total files"
count line — `BUILD_STATE.md` Key Counts, `DOMAINS.md`, `SHARED_TYPES.md`).
Prose mentions ("Migration NNN adds…") are the easy miss — grep both the
number and the filename. (PR #988 round 3: one prose mention survived the
first sweep.)
