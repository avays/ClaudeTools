---
name: update-context
description: Scan the codebase and update .ai/context/ state files to reflect current reality
argument-hint: "[target]"
---

# Update Context Files

Scan the codebase and update `.ai/context/` state files to reflect current reality.

## When to Run
- After completing a phase or major feature
- Before opening a PR (the ship workflow's Context phase and the board pipeline's context step run it automatically)
- When the user asks to update context

## Process

### 1. Determine scope

Accept an optional argument for which file(s) to update. Default: all.
Valid targets: `all`, `schema`, `endpoints`, `domains`, `infrastructure`, `shared`, `deferred`, `build-state`, `changelog`, `ai-agents`, `integrations`, `automation`, `auth-security`, `frontend`, `realtime`, `deployment`, `packages`

### 2. Update each target file

For each target, scan the relevant sources and regenerate the context file:

#### `SCHEMA.md`
- Read `packages/backend/src/core/db.ts` for table interfaces
- Read all `packages/backend/migrations/*.sql` files
- Document every table: columns, types, constraints, indexes, RLS, FKs
- Group by migration/phase

#### `API_ENDPOINTS.md`
- Find all `*.routes.ts` files in `packages/backend/src/domains/`
- Extract every route registration (app.get/post/patch/put/delete)
- Document: method, path, auth requirement, permission guard, description
- Cross-reference with AUTH_PUBLIC_PATHS in `middleware/auth.ts`

#### `DOMAINS.md`
- List all directories in `packages/backend/src/domains/`
- For each: list files, read service to extract method names
- Note routes, events, schema, processor files
- Map cross-domain dependencies (imports between domains)

#### `INFRASTRUCTURE.md`
- Read `packages/backend/src/index.ts` for registration order
- Read all files in `core/`, `middleware/`, `plugins/`
- Document: middleware stack, plugins, core systems, error classes, utilities

#### `SHARED_TYPES.md`
- Read `packages/shared/src/index.ts` for exports
- Read all files in `packages/shared/src/types/` and `constants/`
- List all exported schemas, types, and constants per module

#### `DEFERRED_ITEMS.md`
- This file is manually maintained — only update when explicitly instructed
- Do NOT auto-scan for deferred items

#### `BUILD_STATE.md`
- Update phase status table based on CLAUDE.md progress
- Update key counts (tables, endpoints, domains, migrations)
- Update "last updated" dates for all context files that were refreshed
- Update current focus

#### `AI_AGENTS.md`
- Scan `core/ai/` and `domains/ai/` for agent definitions, skills, context builders, LLM providers, conversations
- Document: built-in agents, all skills (builtin + custom), context builder summaries, execution flow, token budgets, API endpoints

#### `INTEGRATIONS.md`
- Scan `domains/integrations/` for provider/connection/channel/operation model
- Document: auth types, executor pipeline, circuit breaker, OAuth flow, token refresh, provider templates, API endpoints

#### `AUTOMATION.md`
- Scan `domains/automation/`, `domains/approval/`, `core/scripting/`
- Document: triggers, flows (all step types), actions (all types), scripts (platform APIs), approvals, state machines, how they interconnect

#### `AUTH_SECURITY.md`
- Scan `domains/auth/`, `domains/rbac/`, `middleware/`
- Document: JWT claims, RBAC model, middleware stack, MFA, rate limiting, CSP, credential storage

#### `FRONTEND.md`
- Scan `packages/frontend/src/` for routes, components, hooks, stores, engine
- Document: route map, shared UI components, hooks inventory, stores, layout engine

#### `REALTIME.md`
- Scan `core/realtime/` for Socket.io setup
- Document: room structure, client/server events, broadcast functions, Redis adapter

#### `DEPLOYMENT.md`
- Scan Dockerfiles, docker-compose files, `core/migrate.ts`, `core/jobs/queues.ts`
- Document: service topology, Docker builds, Railway config, migrations, BullMQ queues, MinIO, env vars

#### `PACKAGES.md`
- Scan `domains/marketplace/`, `packages/registry/src/`, `shared/types/marketplace.ts`
- Document: manifest schema, install lifecycle, namespace prefixing, registry service endpoints

### 3. Verify consistency

After updating, do a quick sanity check:
- Table count in SCHEMA.md matches BUILD_STATE.md
- Endpoint count in API_ENDPOINTS.md matches BUILD_STATE.md
- Domain count in DOMAINS.md matches BUILD_STATE.md

### 4. Report changes

Summarize what changed in each file (new tables, new endpoints, new domains, etc.).

## Key Sources
| Context File | Primary Sources |
|---|---|
| SCHEMA.md | `core/db.ts`, `packages/backend/migrations/*.sql` |
| API_ENDPOINTS.md | `domains/**/*.routes.ts`, `middleware/auth.ts` |
| DOMAINS.md | `domains/*/` directory listings, `*.service.ts` files |
| INFRASTRUCTURE.md | `core/`, `middleware/`, `plugins/`, `index.ts` |
| SHARED_TYPES.md | `packages/shared/src/` |
| CHANGELOG.md | `CLAUDE.md` progress, completed feature details |
| AI_AGENTS.md | `core/ai/`, `domains/ai/`, `shared/types/ai.ts` |
| INTEGRATIONS.md | `domains/integrations/`, `shared/types/integrations.ts` |
| AUTOMATION.md | `domains/automation/`, `domains/approval/`, `core/scripting/`, `core/jobs/` |
| AUTH_SECURITY.md | `domains/auth/`, `domains/rbac/`, `middleware/` |
| FRONTEND.md | `packages/frontend/src/` (routes, components, hooks, stores, engine) |
| REALTIME.md | `core/realtime/` |
| DEPLOYMENT.md | `Dockerfile*`, `docker-compose*.yml`, `core/migrate.ts`, `core/jobs/queues.ts` |
| PACKAGES.md | `domains/marketplace/`, `packages/registry/src/`, `shared/types/marketplace.ts` |
| DEFERRED_ITEMS.md | Manual only |
| BUILD_STATE.md | Aggregated from above + `CHANGELOG.md` |
