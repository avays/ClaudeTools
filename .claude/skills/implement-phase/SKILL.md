---
name: implement-phase
description: Plan and implement a specific phase from the IMPLEMENTATION_SPEC
argument-hint: "[phase-number]"
---

# Implement Phase $ARGUMENTS

## Process

0. **Check for implementation spec**: Look in `.ai/specs/` for an existing spec file (e.g., `phase-$ARGUMENTS-*.md`). If one exists, use it as the primary guide. If not, run `/create-spec phase-$ARGUMENTS` first to create one — **never start coding without a spec**.

1. **Read the spec**: Read the implementation spec from `.ai/specs/`. Also reference `.ai/context/IMPLEMENTATION_SPEC.md` for the Phase $ARGUMENTS section and `.ai/context/PRODUCT_SPEC.md` for detailed requirements.

2. **Read referenced product spec sections**: Open `.ai/context/PRODUCT_SPEC.md` and read each section listed in the phase header for full requirements.

3. **Check existing state**: Read `.ai/context/BUILD_STATE.md` and the relevant context files to understand what exists:
   - `.ai/context/SCHEMA.md` — existing tables and columns
   - `.ai/context/API_ENDPOINTS.md` — existing routes
   - `.ai/context/DOMAINS.md` — existing domain modules
   - `.ai/context/INFRASTRUCTURE.md` — middleware, plugins, core systems
   - `.ai/context/SHARED_TYPES.md` — existing shared types/schemas
   - `.ai/context/DEFERRED_ITEMS.md` — deferred work this phase might address
   Only explore the codebase directly for implementation details beyond what context files cover.

4. **Implement in order**:
   a. **Database migrations** — New SQL file in `packages/backend/migrations/` with RLS
   b. **Kysely table interfaces** — Extend `Database` in `core/db.ts`
   c. **Shared types/schemas** — Zod schemas + TypeScript types in `packages/shared/src/types/`
   d. **Build shared** — `pnpm --filter @orm/shared build`
   e. **Repository layer** — `{domain}.repository.ts` using `withTenant()`
   f. **Service layer** — `{domain}.service.ts` with business logic
   g. **Route handlers** — `{domain}.routes.ts` with Zod parsing + buildResponse
   h. **Wire routes** — Register in `packages/backend/src/index.ts`
   i. **Event stubs** — `{domain}.events.ts`

5. **Typecheck**: Run `pnpm --filter @orm/shared build && pnpm --filter @orm/backend typecheck`

6. **Test**: Start the server and run curl tests against each new endpoint

7. **Update project board**: Set the linked GitHub issue's status on the ORM Build project board:
   - At start of implementation: set to **Ready for Code** (if not already)
   - When implementation is done: set to **Code Complete**
   - See `.ai/context/PROJECT_BOARD.md` for option IDs and GraphQL commands

8. **Update progress**: Update `CLAUDE.md` implementation progress section

9. **Update context**: Run `/update-context` to refresh `.ai/context/` state files with the new tables, endpoints, domains, etc.

## Key References
- Implementation specs: `.ai/specs/` (primary, detailed per-phase specs)
- Master implementation spec: `.ai/context/IMPLEMENTATION_SPEC.md`
- Product spec: `.ai/context/PRODUCT_SPEC.md`
- Build state & context files: `.ai/context/BUILD_STATE.md` (index to all context files)
- Domain pattern example: `packages/backend/src/domains/metadata/`
- DB pattern example: `packages/backend/src/core/db.ts`
