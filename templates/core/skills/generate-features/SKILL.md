---
name: generate-features
description: Generate or refresh the feature catalog — a comprehensive wiki index of all features, functionality, and test cases across the platform.
argument-hint: "[target] — 'all' (default), 'index-only', or a specific feature slug"
---

<!-- host-specific: the tracker/host commands shown below are worked examples from
     one setup. Your configured equivalents live in claudetools.config.json
     (TRACKER_* / VCS_* tokens) — the CONTRACT each step implements is what
     ports; the exact invocation is not. -->


# Generate Feature Catalog

Scan all sources and generate/update `.ai/features/` — a comprehensive catalog of every feature in the platform with functionality descriptions and test cases.

## When to Run
- After completing a new feature (generates its catalog entry)
- Periodically to refresh the full catalog
- When the user wants a comprehensive view of what's built and what to test

## Arguments
- `all` (default) — regenerate every feature file + the master index
- `index-only` — regenerate only `INDEX.md` from existing feature files
- `{feature-slug}` — regenerate a single feature file (e.g., `social-login-oauth`)

## Output Structure

```
.ai/features/
  INDEX.md                          ← Master table of all features
  core-infrastructure.md            ← Feature files grouped by area
  metadata-engine.md
  auth-jwt-mfa.md
  rbac-permissions.md
  ...
```

## Process

### 1. Identify all features

Build the master feature list from these sources (in priority order):

| Source | What it tells you | Feature type |
|--------|------------------|--------------|
| `{{PATHS_SPECS_DIR}}/*.md` | Detailed spec with acceptance criteria | Spec-based (post-workflow) |
| `{{PATHS_CONTEXT_DIR}}/CHANGELOG.md` | Per-feature implementation log with bullet summaries | Both types |
| `CLAUDE.md` Implementation Status table | High-level feature bullets | Both types |
| `{{PATHS_CONTEXT_DIR}}/BUILD_STATE.md` | Phase status, key counts | Legacy (pre-workflow) |
| {{VOCAB_ISSUES}} (closed, via `gh issue list`) | Acceptance criteria, discussion | Spec-based |

**Feature identification rules:**
- Each CHANGELOG bullet (line starting with `- **Feature Name: DONE**`) = one feature
- Each spec file = one feature (may overlap with CHANGELOG — deduplicate by matching names)
- Group related sub-features into single entries (e.g., "Agent Platform Phase A-E" → one "AI Agent Platform" feature)
- Phase-level entries (Phase 1-10) should be split into their constituent features

### 2. Categorize features

Assign each feature to exactly one category:

| Category | Slug prefix | Examples |
|----------|-------------|---------|
| Core Infrastructure | `core-` | DB, caching, events, jobs, middleware, deployment |
| Metadata Engine | `metadata-` | Objects, fields, layouts, validation rules, formula fields |
| Authentication & Security | `auth-` | JWT, MFA, OAuth, RBAC, CSP, rate limiting, secrets |
| Data & Records | `data-` | Record CRUD, inline editing, kanban, calendar, comments, recycle bin |
| Automation | `automation-` | Triggers, flows, actions, scripts, approvals, state machines |
| Integrations | `integration-` | REST executor, OAuth, providers, Gmail, circuit breaker |
| AI Platform | `ai-` | LLM providers, context builders, agents, skills, conversations |
| Frontend & UX | `frontend-` | Layout engine, UI components, admin pages, design system |
| Reporting & Analytics | `reporting-` | Reports, dashboards, import/export, file storage |
| Apps & Packages | `apps-` | App tabs, custom pages, marketplace, registry, feature flags |
| Platform Admin | `platform-` | Super admin, tenant management, error logs, onboarding |
| Developer Experience | `dx-` | API docs, CLI, OpenAPI, developer portal |

### 3. Generate each feature file

Use this template for each feature file:

```markdown
# {Feature Title}

**Category**: {category}
**Status**: {Done | In Progress | Partial}
**Issue**: #{number} (if exists)
**Spec**: {{PATHS_SPECS_DIR}}/{slug}.md (if exists)
**Migration(s)**: {NNN} (if any)

## Overview
{2-3 sentence description of what this feature does and why it matters}

## Functionality
{Bullet list of specific capabilities — what a user or admin can do}

- Capability 1
- Capability 2
- ...

## Key Files
{Most important files, grouped by layer}

### Backend
- `domains/{name}/{file}` — {what it does}

### Frontend
- `pages/{file}` — {what it does}
- `components/{file}` — {what it does}

### Shared
- `types/{file}` — {what it exports}

## API Endpoints
{Table of endpoints if this feature added any}

| Method | Path | Auth | Description |
|--------|------|------|-------------|

## Test Cases

### Happy Path
- [ ] {Test case 1}
- [ ] {Test case 2}

### Error / Edge Cases
- [ ] {Error case 1}
- [ ] {Edge case 2}

### Security
- [ ] {Security test if applicable}

### Integration
- [ ] {Cross-feature test if applicable}
```

### 4. Populate test cases

**For spec-based features** (have a `{{PATHS_SPECS_DIR}}/` file):
- Pull acceptance criteria directly from the spec's verification/test sections
- Pull from {{VOCAB_ISSUE}} acceptance criteria checkboxes
- Add edge cases based on error handling visible in the code

**For legacy features** (no spec):
- **Derive from functionality**: each capability bullet → at least one happy path test
- **Derive from code**: scan route handlers for error paths (404, 400, 409, 401) → error test cases
- **Derive from conventions**: every tenant-scoped feature needs a "tenant isolation" test
- **Derive from security patterns**: auth-gated endpoints → "unauthenticated request returns 401" test
- **Common patterns to always include**:
  - CRUD: create, read, update, delete, list with pagination, not-found, duplicate/conflict
  - Admin pages: form validation, save, cancel, empty state, loading state
  - Permissions: authorized access, unauthorized access, permission boundary
  - Multi-tenant: data isolation between tenants

### 5. Generate INDEX.md

The master index is a single table with one row per feature:

```markdown
# Feature Catalog

> Auto-generated by `/generate-features`. Last updated: {date}
>
> {total} features across {categories} categories.
> {spec_count} with specs, {legacy_count} reverse-engineered from code.
> {total_tests} test cases ({passed_pct}% with existing coverage).

## Summary by Category

| Category | Features | Test Cases |
|----------|----------|------------|
| Core Infrastructure | 8 | 42 |
| ... | ... | ... |

## All Features

| Feature | Category | Status | Issue | Spec | Tests |
|---------|----------|--------|-------|------|-------|
| [JWT Auth & MFA](auth-jwt-mfa.md) | Auth & Security | Done | — | phase-7 | 12 |
| [Social Login OAuth](auth-social-login-oauth.md) | Auth & Security | Done | #156 | social-login-oauth | 10 |
| ... | ... | ... | ... | ... | ... |
```

### 6. Verify and report

After generation:
- Count total features, total test cases
- Identify features with zero test cases (flag for attention)
- Identify spec-based features where test case count < acceptance criteria count (gaps)
- Report summary to user

## Key Sources Reference

| Source | Path | What to extract |
|--------|------|----------------|
| Specs | `{{PATHS_SPECS_DIR}}/*.md` | Acceptance criteria, file lists, verification steps |
| Changelog | `{{PATHS_CONTEXT_DIR}}/CHANGELOG.md` | Feature names, status, file references, descriptions |
| Build state | `{{PATHS_CONTEXT_DIR}}/BUILD_STATE.md` | Phase status, counts |
| CLAUDE.md | `CLAUDE.md` | Implementation Status table |
| Endpoints | `{{PATHS_CONTEXT_DIR}}/API_ENDPOINTS.md` | Route → feature mapping |
| Schema | `{{PATHS_CONTEXT_DIR}}/SCHEMA.md` | Migration → feature mapping |
| Domains | `{{PATHS_CONTEXT_DIR}}/DOMAINS.md` | Domain → feature mapping |
| {{VOCAB_ISSUES}} | `{{TRACKER_LIST_ISSUES}}` | Acceptance criteria, labels |
| Frontend | `{{PATHS_CONTEXT_DIR}}/FRONTEND.md` | Route → page → feature mapping |

## Tips
- When in doubt about grouping, prefer fewer larger features over many tiny ones
- Test cases should be concrete and testable, not vague ("it works")
- Use checkbox syntax (`- [ ]`) so test cases are trackable
- Keep feature files under 200 lines — split if larger
- Cross-reference between related features (e.g., "See also: [RBAC Permissions](auth-rbac-permissions.md)")
