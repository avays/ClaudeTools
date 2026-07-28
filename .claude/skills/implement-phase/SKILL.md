---
name: implement-phase
description: Plan and implement a specific phase from the IMPLEMENTATION_SPEC
argument-hint: "[phase-number]"
---

# Implement Phase $ARGUMENTS

## Process

0. **Check for implementation spec**: Look in `{{PATHS_SPECS_DIR}}/` for an existing spec file (e.g., `phase-$ARGUMENTS-*.md`). If one exists, use it as the primary guide. If not, run `/create-spec phase-$ARGUMENTS` first to create one — **never start coding without a spec**.

1. **Read the spec**: Read the implementation spec from `{{PATHS_SPECS_DIR}}/`. Also reference `{{PATHS_CONTEXT_DIR}}/IMPLEMENTATION_SPEC.md` for the Phase $ARGUMENTS section and `{{PATHS_CONTEXT_DIR}}/PRODUCT_SPEC.md` for detailed requirements.

2. **Read referenced product spec sections**: Open `{{PATHS_CONTEXT_DIR}}/PRODUCT_SPEC.md` and read each section listed in the phase header for full requirements.

3. **Check existing state**: Read `{{PATHS_CONTEXT_DIR}}/BUILD_STATE.md` and the relevant context files to understand what exists:
   - `{{PATHS_CONTEXT_DIR}}/SCHEMA.md` — existing tables and columns
   - `{{PATHS_CONTEXT_DIR}}/API_ENDPOINTS.md` — existing routes
   - `{{PATHS_CONTEXT_DIR}}/DOMAINS.md` — existing domain modules
   - `{{PATHS_CONTEXT_DIR}}/INFRASTRUCTURE.md` — middleware, plugins, core systems
   - `{{PATHS_CONTEXT_DIR}}/SHARED_TYPES.md` — existing shared types/schemas
   - `{{PATHS_CONTEXT_DIR}}/DEFERRED_ITEMS.md` — deferred work this phase might address
   Only explore the codebase directly for implementation details beyond what context files cover.

4. **Implement in order**:
   a. **Database migrations** — New SQL file in `packages/backend/migrations/` with RLS
   b. **Kysely table interfaces** — Extend `Database` in `core/db.ts`
   c. **Shared types/schemas** — Zod schemas + TypeScript types in `{{PATHS_SRC_GLOBS}}/types/`
   d. **Build shared** — `{{PKG_BUILD}}`
   e. **Repository layer** — `{domain}.repository.ts` using `withTenant()`
   f. **Service layer** — `{domain}.service.ts` with business logic
   g. **Route handlers** — `{domain}.routes.ts` with Zod parsing + buildResponse
   h. **Wire routes** — Register in `{{PATHS_SRC_GLOBS}}/index.ts`
   i. **Event stubs** — `{domain}.events.ts`

5. **Typecheck**: Run `{{PKG_BUILD}} && {{PKG_TYPECHECK}}`

6. **Test**: Start the server and run curl tests against each new endpoint

7. **Update project board**: Set the linked {{VOCAB_ISSUE}}'s status on the ORM Build project board:
   - At start of implementation: set to **Ready for Code** (if not already)
   - When implementation is done: set to **Code Complete**
   - See `{{PATHS_CONTEXT_DIR}}/PROJECT_BOARD.md` for option IDs and GraphQL commands

8. **Update progress**: Update `CLAUDE.md` implementation progress section

9. **Update context**: Run `/update-context` to refresh `{{PATHS_CONTEXT_DIR}}/` state files with the new tables, endpoints, domains, etc.

## Key References
- Implementation specs: `{{PATHS_SPECS_DIR}}/` (primary, detailed per-phase specs)
- Master implementation spec: `{{PATHS_CONTEXT_DIR}}/IMPLEMENTATION_SPEC.md`
- Product spec: `{{PATHS_CONTEXT_DIR}}/PRODUCT_SPEC.md`
- Build state & context files: `{{PATHS_CONTEXT_DIR}}/BUILD_STATE.md` (index to all context files)
- Domain pattern example: `{{PATHS_SRC_GLOBS}}/domains/metadata/`
- DB pattern example: `{{PATHS_SRC_GLOBS}}/core/db.ts`
