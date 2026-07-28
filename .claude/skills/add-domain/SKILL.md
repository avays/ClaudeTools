---
name: add-domain
description: Scaffold a new backend domain module with all required files
argument-hint: "[domain-name]"
---

# Add Domain: $ARGUMENTS

Create `packages/backend/src/domains/$ARGUMENTS/` with these files:

## 1. `$ARGUMENTS.routes.ts`
```typescript
import type { FastifyInstance } from 'fastify';
import { ${name}Service } from './$ARGUMENTS.service.js';
import { buildResponse } from '../../core/utils/response.js';

export async function ${name}Routes(app: FastifyInstance): Promise<void> {
  // Add route handlers here
}
```

## 2. `$ARGUMENTS.service.ts`
- Import repository, errors, shared types
- Export a const object with async methods
- All business logic lives here

## 3. `$ARGUMENTS.repository.ts`
- Import `withTenant` from `../../core/db.js`
- Import `snakeToCamelObject` from `../../core/utils/case.js`
- All queries use `withTenant(tenantId)`
- Convert snake_case rows to camelCase at boundary

## 4. `$ARGUMENTS.schema.ts`
- Re-export Zod schemas from `@orm/shared` or define route-specific ones
- Export both schema and inferred type

## 5. `$ARGUMENTS.events.ts`
- Define event type constants and payload interfaces
- Stub emission functions for future Phase 5 integration

## 6. Wire into app
- Add `import { ${name}Routes } from './domains/$ARGUMENTS/$ARGUMENTS.routes.js'` in `src/index.ts`
- Register: `app.register(${name}Routes)`

## 7. Verify
Run: `{{PKG_BUILD}} && {{PKG_TYPECHECK}}`
