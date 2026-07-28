---
name: add-migration
description: Create a new numbered database migration file
argument-hint: "[description]"
---

# Add Migration: $ARGUMENTS

1. List existing files in `packages/backend/migrations/` to find the next number

2. Create: `packages/backend/migrations/{NNN}_$ARGUMENTS.sql`

3. For each new tenant-scoped table, include:
```sql
CREATE TABLE table_name (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  -- columns --
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE table_name ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON table_name
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE INDEX idx_table_name_tenant ON table_name(tenant_id);
```

4. Add Kysely interface to `packages/backend/src/core/db.ts`:
   - Define the table interface with snake_case columns
   - Add to the `Database` interface

5. Verify: `{{PKG_TYPECHECK}}`
