---
name: audit-phase
description: Audit a completed phase against the implementation spec for gaps and issues
# Some grep sweeps below are stack-specific (React, Kysely, BullMQ). They degrade
# gracefully: on a repo without that stack the paths do not exist and the sweep
# returns nothing. Cost is a wasted grep, not a false finding.
argument-hint: "[phase-number|issue-number]"
---

# Audit Phase $ARGUMENTS

The complete audit workflow. Runs in three phases — spec conformance, pattern-level pitfalls, and cross-cutting review-blockers — with typecheck and remediation tracking. Severity labels order remediation; they do NOT license deferral. Every finding (CRITICAL → LOW) must be fixed before the audit passes.

## Mental model

The greps and rule walks below catch **known** failure shapes. They are necessary, not sufficient. Before declaring an audit clean, apply the seven audit dimensions in `{{PATHS_AGENTS_DIR}}/auditor.md` "Audit Principles — beyond pattern-matching":

1. **State × input cross-product** — for every stateful surface in the diff, enumerate (state, value-shape) cells and ask what the user actually sees / gets in each one.
2. **Read the contract, not just the diff** — when the PR consumes a shared type or API shape, audit against every legal shape the type permits, not the common one.
3. **Runtime / CSS / browser quirks** — mentally walk the UI in a real browser; verify discoverability of every disabled / error / loading state without depending on hover or `title`-only tooltips.
4. **Active simulation** — predict what the user experiences on the unusual path; a clean grep sweep without end-to-end simulation is an incomplete audit.
5. **LLM-facing strings must match runtime** — every tool name, expression example, and behavior claim in catalog descriptions / agent prompts must be verified against the resolver or service it describes, not intuition.
6. **Root cause over band-aid** — test/e2e workarounds (skips, loosened assertions, swallowed errors, brittle selectors) are symptoms; trace them to the product defect.
7. **Fix-pass blast radius** — on branches with prior review/audit rounds, sweep for stale audit-metadata comments, dead code from reworks, schema-pair asymmetry, and context-doc drift left by earlier fix commits.

A finding surfaced by these dimensions outranks one surfaced only by grep. When one of them turns up a new failure shape, codify a greppable proxy in `{{PATHS_RULES_DIR}}/` so the next audit catches it cheaply.

## Process

### 1. Read the issue and spec in full

```bash
gh issue view <number> --repo {{VCS_REPO_SLUG}} --comments
```

Then `Read` `{{PATHS_SPECS_DIR}}/{name}.md` end-to-end. Extract: all files in the file tree, all DB tables + columns, all API endpoints (method + path), all test scenarios from "What Is Testable".

### 2. Check out the feature branch + summarize the diff

**Identify the diff base FIRST.** The project's release flow is
`feature/* → staging → main`, so most PRs target `staging`, not `main`.
Auditing against `main` for a staging-targeted PR will surface the
`staging → main` delta as if it were part of the PR — false-positive
findings on lines that are not actually being introduced by this branch.

Resolve the base before any grep / diff:

```bash
# If invoked with a PR number, ask GitHub for the base.
gh pr view <pr-number> --repo {{VCS_REPO_SLUG}} --json baseRefName -q .baseRefName
# Fall back to `main` only if no PR exists yet (pre-PR audit).
```

Then use that base everywhere below. The recipes use the literal text
`origin/<base>` as a placeholder — **substitute the resolved base
(e.g. `origin/staging`, `origin/main`) literally before running the
command**. If you forget to substitute, the command fails loudly (bash
parses `<base>` standing alone as input redirection → syntax error;
git parses `origin/<base>...HEAD` as a ref → "fatal: bad revision").
Either way you get a clear failure, not a silent wrong-base audit.
That's intentional.

```bash
git fetch origin && git checkout <branch> && git pull
git fetch origin <base>      # make sure origin/<base> is current
git diff origin/<base>...HEAD --stat
git diff origin/<base>...HEAD --name-only
```

### 3. Learn from recent reviews

Before writing findings, pull Copilot review comments from the 3 most recent merged PRs that touch overlapping paths:

```bash
gh pr list --repo {{VCS_REPO_SLUG}} --state merged --limit 10 --json number,title,files
gh api "repos/{{VCS_REPO_SLUG}}/pulls/<n>/comments" --jq '.[] | {path, body: (.body | .[:200])}'
```

Any pattern repeated twice in recent reviews is a check for THIS PR too.

### 4. Pass 1 — Spec conformance

For each sub-phase in the spec:

- Every file in the spec's tree exists with expected exports/functions.
- Every DB table has a migration, Kysely interface in `core/db.ts`, RLS policy, `tenant_id` FK, indexes.
- Every endpoint is registered with correct method/path/tags, Zod validation on body + query + params, `buildResponse()` envelope, correct status codes.
- Every test the spec names exists and asserts the scenario it claims.

Cross-reference against context files (`{{PATHS_CONTEXT_DIR}}/SCHEMA.md`, `API_ENDPOINTS.md`, `DOMAINS.md`, `INFRASTRUCTURE.md`, `SHARED_TYPES.md`) — any divergence is a HIGH finding ("spec/context out of sync with code").

### 5. Pass 2 — Pattern-level pitfalls (walk `{{PATHS_RULES_DIR}}/`)

Every rule in `{{PATHS_RULES_DIR}}/` whose scope matches a file in the diff must be walked. **The rules files are the pattern catalog — no sampling.** Rules by scope:

- **Backend core** — `backend-general.md`, `backend-database.md`, `backend-api.md`, `migrations.md`
- **Backend lifecycle** — `delete-lifecycle.md`, `approval-lifecycle.md`
- **Backend integrations** — `integration-adapters.md`, `agent-skills.md`, `registry.md`
- **Frontend** — `frontend.md`, `frontend-components.md` (the "Recurring correctness rules" section)
- **Shared / testing** — `shared-types.md`, `testing.md` (including the "Root cause over band-aid" section — any band-aid signature in the diff is a finding; see `{{PATHS_AGENTS_DIR}}/auditor.md` dimension 6 for the grep suite and severity rubric)
- **Workflow / deployment** — `workflow.md`, `railway.md`

If a rule names a pattern and the diff matches, it's a finding — regardless of severity.

### 6. Pass 2b — Executable grep sweeps

For every frontend PR, run these greps. Each maps to a rule in `{{PATHS_RULES_DIR}}/frontend-components.md` "Recurring correctness rules". Each hit needs triage — open the file, decide if the context matches the rule.

#### Frontend grep recipes

```bash
# 1. Icon-only buttons missing aria-label
rg -n --multiline '<button[^>]*\btitle="[^"]*"[^>]*>' {{PATHS_SRC_GLOBS}} {{PATHS_SRC_GLOBS}} \
  | rg -v 'aria-label='

# 2. Inputs whose only label is placeholder
rg -n --multiline '<input[^>]*\bplaceholder="[^"]*"[^>]*>' {{PATHS_SRC_GLOBS}} {{PATHS_SRC_GLOBS}} \
  | rg -v 'aria-label=|id="'

# 3. console.warn / console.error in render bodies
rg -n 'if\s*\(\s*process\.env\.NODE_ENV' {{PATHS_SRC_GLOBS}} {{PATHS_SRC_GLOBS}} -A 4 \
  | rg 'console\.(warn|error)'

# 4. <Button> without explicit type attribute (default type="submit" inside <form>)
rg -n --multiline '<Button[^>]*>' {{PATHS_SRC_GLOBS}}/components {{PATHS_SRC_GLOBS}} \
  | rg -v 'type="(button|submit|reset)"'

# 8. colSpan derived from a toggleable count
rg -n 'colSpan=\{[^}]+\}' {{PATHS_SRC_GLOBS}} {{PATHS_SRC_GLOBS}}

# 9. Mutations missing onError
rg -n '\.mutate\(' {{PATHS_SRC_GLOBS}} -A 6 \
  | rg -B 0 -A 5 '\.mutate\(' | rg -B 5 '^\s*\)\s*;' | rg 'onError'

# 10. Delete paths regex-matching err.message
rg -n '(err|error)\.message\.(match|includes|startsWith)' {{PATHS_SRC_GLOBS}}

# 11. Destructive confirmations without ref-latch re-entrancy guard
rg -n 'variant="danger"' {{PATHS_SRC_GLOBS}} -A 8 \
  | rg -B 3 '\.mutate\(' | rg 'inFlightRef' || echo "potential missing ref latch"

# 12. Raw <table> in admin pages (also enforced by arch test)
rg -n '<table[\s>]' {{PATHS_SRC_GLOBS}}/pages/Admin*.tsx

# 13. i18next || fallback antipattern
rg -n "t\(['\"][^'\"]+['\"]\)\s*\|\|" {{PATHS_SRC_GLOBS}} {{PATHS_SRC_GLOBS}}

# 15. Raw <button> in Storybook stories (stories are reference material)
rg -n '<button' packages/ui/stories | rg -v 'aria-label='

# 16. Validation run on raw value instead of trimmed
rg -n '\.trim\(\)' {{PATHS_SRC_GLOBS}} -B 5 | rg 'if \(!' | head

# 17. Localized-label search via keys instead of accessorFn
rg -n --multiline 'search=\{\{[^}]*\bkeys:[^}]*\blabel\b' {{PATHS_SRC_GLOBS}}/pages/Admin*.tsx

# 18. Routed editor — static /new alongside :id
rg -nE "path:\s*'[^']+/new'" {{PATHS_SRC_GLOBS}}/app/routes.tsx -A 3 \
  | rg -B 1 "path:\s*'[^']+/:id'"

# 19. Backend pageSize caps — callers passing > 100
rg -nE 'use[A-Z][A-Za-z]+\(\s*\d+\s*,\s*(1[5-9]\d|[2-9]\d\d|\d{4,})' {{PATHS_SRC_GLOBS}}

# 20. apiName helpers prefixing with _ instead of a letter
rg -nE "function\s+labelToApiName|replace\(/\^\(\\\\d\)/" {{PATHS_SRC_GLOBS}}

# 23. Single-entity hooks over list-then-find
rg -nE '\.find\(\(\w+\)\s*=>\s*\w+\.id\s*===' {{PATHS_SRC_GLOBS}}/pages/Admin*EditorPage.tsx

# 24. Tailwind important modifier — suffix form (repo convention is prefix)
rg -nE '\b[a-z]+-[0-9.]+![\s"]' {{PATHS_SRC_GLOBS}} {{PATHS_SRC_GLOBS}}

# 25. Internal admin navigation as <a href> instead of <Link>
rg -n '<a\s+[^>]*href=\{?["`]/admin' {{PATHS_SRC_GLOBS}}
```

For patterns that don't have a single greppable shape (pagination threading, prop ↔ persisted-state drift, form-field completeness across create+update, paginated panels reset on sourceId change, atomic multi-mutation toggles), open the modified component and confirm the pattern in `frontend-components.md` holds.

### 7. Pass 3 — Review-blocker checklist (cross-cutting)

Eight patterns that have each shipped at least once and been caught by Copilot. Any hit is a CRITICAL or HIGH finding — not a nit.

**1. Frontend `/api/v1/` double-prefix**
```bash
grep -rn "'/api/v1/\|\"/api/v1/" {{PATHS_SRC_GLOBS}}/hooks/ {{PATHS_SRC_GLOBS}}/components/
```
ApiClient already prefixes `/api/v1`. Any match in new/modified files is a production 404. See `{{PATHS_RULES_DIR}}/frontend.md`.

**2. Record-access-check bypass on polymorphic routes**
For every route/service method that accepts `{recordObjectApiName, recordId}`, verify it calls `dataService.getRecord(..., getUserContext(request))` BEFORE the association read/write. Missing check = RBAC/FLS bypass. See `{{PATHS_RULES_DIR}}/backend-api.md` "Record Access Checks".

**3. Raw `db` cast to any in JOIN queries**
```bash
grep -rn "(db as any)\|db as any" {{PATHS_SRC_GLOBS}}/domains/
```
Should be zero hits. JOINs across tenant-scoped tables must use `withTenant(tenantId).transaction(trx => trx.raw...)`. See `{{PATHS_RULES_DIR}}/backend-database.md`.

**4. Integration adapters passing inputs via `queryParams`**
```bash
grep -rn "queryParams:" {{PATHS_SRC_GLOBS}}/domains/**/providers/
```
For typed ops (inputSchema.properties[].in declared), the executor ignores `queryParams`. All fields MUST go in `body`. See `{{PATHS_RULES_DIR}}/integration-adapters.md`.

**5. Bespoke timeouts wrapping executor calls**
```bash
grep -rn "Promise.race.*setTimeout\|setTimeout.*reject" {{PATHS_SRC_GLOBS}}/domains/
```
Executor already has per-request timeout + circuit breaker. Remove the bespoke timer.

**6. Tautological registry count tripwire**
```bash
grep -rnE "EXPECTED_COUNT = \w+\.length" {{PATHS_SRC_GLOBS}}/domains/**/registry.test.ts
```
Must be a hardcoded number, not derived from the array under test.

**7. Unique-violation handler not branching on `err.constraint`**
If a repository inserts into a table with multiple unique indexes (normal + partial), the service's 23505 catch MUST branch on `err.constraint` to map each index to its own `PlatformError` code. Generic `if (err.code === '23505')` only is a finding.

**8. Spec / context docs out of sync with code**
Cross-check:
- Every operation, route, method-name, error code the spec names exists at the path it claims.
- Every route path in `{{PATHS_CONTEXT_DIR}}/API_ENDPOINTS.md` matches the actual `.routes.ts` declaration.
- Every column and index in `{{PATHS_CONTEXT_DIR}}/SCHEMA.md` matches the migration file.
- `BUILD_STATE.md` and `CHANGELOG.md` don't reference removed behavior (dead timeouts, deprecated ops).
A disagreement between spec/docs and code is a HIGH finding — reviewers flag these every round.

### 7b. Pass 4 — Code-review-style audit (audit as Copilot would)

The path-scoped rule walk catches *known* anti-patterns. It misses the
checks a careful human / Copilot reviewer would catch on first read.
After Pass 3, do this pass. Each item below was a real Copilot finding
on a recent PR that the path-scoped walk missed — see
`{{PATHS_AGENTS_DIR}}/auditor.md` "Code-review-style audit checks" for the
full discussion.

**4a. Naming-vs-behavior (greppable):**

```bash
# *_BYTES / *_SIZE constants paired with .length (which counts UTF-16 code units, not bytes)
grep -rn -B2 -A2 '_BYTES\|_BYTE_LIMIT\|_SIZE_LIMIT' {{PATHS_SRC_GLOBS}} --include='*.ts' \
  | grep -B2 -A2 '\.length'
```

A hit is a finding unless the constant is genuinely measuring code-units
(rare). For UTF-8 byte length use `new TextEncoder().encode(...).length`
or `Buffer.byteLength`.

**4b. Composite folder arch tests (greppable; CI runs these but ralph
worktree env doesn't have node_modules):**

```bash
# composite-files-must-orchestrate-via-inject — no .service.js imports under llm-composites/
grep -rn "from '[^']*\.service\.js'" {{PATHS_SRC_GLOBS}}/domains/llm-composites/ \
  --include='*.routes.ts'

# description length cap (500 chars max for llm-tool composites)
grep -rn "description:" {{PATHS_SRC_GLOBS}}/domains/llm-composites/ \
  --include='*.routes.ts' | awk -F"'" '{print length($2), $2}' | awk '$1 > 500'
```

**4c. Post-relocation reference drift (greppable):**

When a commit moved a file, renamed a function, or changed a URL/tag,
search ALL doc + code paths for the OLD identifier:

```bash
# Plug in <OLD_PATH_OR_NAME> from the diff
grep -rn "<OLD_PATH_OR_NAME>" .ai/ CLAUDE.md AGENTS.md packages/ \
  --include='*.md' --include='*.ts' --include='*.tsx'
```

Every hit needs a fix or a justification.

**4d. Header doc comment vs implementation alignment (read, not grep):**

For each file with a multi-line JSDoc/`/**` header that names
identifiers (`useRef`, `inFlightRef`, `claimForAccept`, …), open the
header AND the matching code. Verify each named identifier exists AND
behaves as the comment says. Specifically:

- Does the comment name a variable/hook/method that exists?
- Does the comment claim "shared" / "scoped" / "global" semantics that
  match the actual storage location (component-local ref vs. context
  vs. store)?
- Does the comment claim an N-step lifecycle? Walk the code, count.

This is a doc-vs-code consistency check; cannot be greppable. Pick
one or two central files in the diff and read them carefully.

**4e. File-preamble compliance (read):**

When the diff modifies `CLAUDE.md`, `AGENTS.md`, or any other file
whose own preamble states a constraint (e.g. `CLAUDE.md`'s "**This
file is a lean index/loader.**" → Current Focus must be one short
line; long detail belongs in `CHANGELOG.md` / `BUILD_STATE.md`),
re-read that preamble and judge the change against it. Multi-merge
accumulation is the dominant failure mode here — each individual
append is small but compounds.

**4f. Sentinel-key collisions in keying functions (read):**

Functions that build a `Map<string, T>` key by joining nullable
fields with a literal sentinel (`?? '_'`, `?? 'null'`, `?? '-'`) MUST
distinguish real-string sentinel values from null. Search the diff
for grouping/keying functions:

```bash
grep -rn -B2 -A4 'new Map<string\|groups\.get\|groupBy' packages/ \
  --include='*.ts' --include='*.tsx' | grep '?? '
```

Real cases: tray groupers (sourceId), permission caches (resourceId),
audit summarizers (entityId). Fix: encode null distinctly (`null` vs
`id:<value>` or `null` vs `:value`). Caught on #584 PendingMutationsTray
where `sourceId === '_'` would have collapsed onto the null bucket.

**4g. Now-timestamp consistency between paginated queries (read):**

Pattern A list+count repositories that take a `now` predicate (TTL
filter, recently-active filter, expiring-soon filter) MUST capture
ONE `new Date()` value and reuse it for both the list and the count
query. Two `new Date()` calls let a row that crosses the threshold
between calls be present in one query but not the other, producing
`meta.total` that disagrees with returned items. Search:

```bash
grep -rn -B5 -A10 'countQuery\|countAll' {{PATHS_SRC_GLOBS}}/domains/ \
  --include='*.repository.ts' | grep -B5 -A5 'new Date()'
```

Two distinct `new Date()` calls in the same method = finding. Fix:
`const now = new Date();` once, reuse.

**4h. Cross-tenant cron / raw-SQL tenant predicate hygiene:**

Per-tenant cron methods (`expireDue`, `markStaleAsFailed`, etc.) that
use `sql\`UPDATE ...\`.execute(trx.raw)` MUST include an explicit
`WHERE tenant_id = ${tenantId}` predicate even though the RLS policy
would otherwise enforce isolation. Without it, the planner has to
consider every tenant's rows and rely on row-level RLS filtering;
table grows globally → cron cost grows globally. Search:

```bash
grep -rn -B3 -A8 "sql<.*>\`" {{PATHS_SRC_GLOBS}}/domains/ \
  --include='*.repository.ts' | grep -B5 -A5 'UPDATE\|DELETE'
```

For each hit, verify the WHERE clause includes `tenant_id = ${tenantId}`.

**4i. Partial-index design review for per-tenant queries:**

When a migration adds a partial index used by a per-tenant query,
verify the leading column is `tenant_id`. A partial index keyed only
on `(value) WHERE pred` cannot bound the scan to one tenant — the
planner has to consider all tenants' matching rows and rely on RLS.
Search migrations:

```bash
grep -rn 'CREATE INDEX' packages/backend/migrations/ | grep -v 'tenant_id'
```

For each hit, check whether the indexed table is tenant-scoped AND
the index is used by a per-tenant query path. If yes → finding;
recommend `(tenant_id, value)` partial composite.

**4j. Component-level contract-edge sweep on new consumers of a recursive shared type:**

When a PR introduces a NEW component that consumes a recursive shared type
(`Criteria`, layout component config, agent context manifest, etc.), the
auditor MUST walk the new component's serialize ↔ parse cross-product —
not just trust that the type's existing pure-helper edge tests cover the
new consumer. Pure helpers can each be correct in isolation while the
component's round-trip is broken.

The recurring failure mode:

1. Pure helper A (`formatLogicString`, `serializeX`) emits a representation
   for every legal shape of the recursive type — including special shapes
   like `$expr` rendered as the literal token `expr`.
2. Pure helper B (`parseLogicString`, `parseX`) accepts a narrower grammar
   that does NOT include those special-shape tokens.
3. The new component pipes user-facing state through A → user edit → B,
   assuming the round-trip is lossless. The mismatch creates an
   un-saveable input mode that all single-helper edge tests miss.

When auditing a new component, build the cross-product:

| Legal value shape | Component operation | Result |
|---|---|---|
| `leaf` at root | render → edit → save | ✓ |
| `$and` group | render → edit → save | ✓ |
| `$or` group | render → edit → save | ✓ |
| `$not` wrapper | render → edit → save | ✓ (if `$not` supported) |
| `$expr` at root | render → edit → save | reachable? saveable? |
| `$expr` inside `$and` (depth ≥ 1) | render → edit → save | reachable? saveable? |
| `$expr` inside `$or` (depth ≥ 1) | render → edit → save | reachable? saveable? |
| Double-nested (`$and > $or > leaf`) | render → edit → save | ✓ |

Each row that says "reachable? saveable?" is a finding if either side
disagrees with the other. A component that lets the user enter an edit
mode for a shape that can't save is a UX bug; one that silently renders
the wrong shape on a save is a correctness bug.

For interactive affordances (pencil-icon, edit button, ⋯ menu), also
verify: **is the affordance reachable in a useful state for THIS shape?**
A pencil icon that opens a textbox pre-filled with content the
component's parser will reject is wrong even if both the serializer
and parser test clean in isolation.

Precedent: PR #663 (#662) `<CriteriaLogicEditor>` shipped with pencil
visible for trees containing nested `$expr`. `formatLogicString` rendered
`$expr` leaves as the literal token `expr`; `parseLogicString` only
accepts INT/AND/OR/NOT/parens. Result: un-saveable edit mode. 4 ralph
passes missed it; Copilot caught it on first review. Fix was to gate
the pencil on `extractLeavesInOrder(value).some(isExpression)` so
nested `$expr` triggers the same "edit in advanced mode" hint as
root-`$expr`.

This is distinct from the path-scoped contract-edge rule in
`frontend-components.md` "Contract-edge sweep — recursive types at every
depth", which targets the type's helper functions in isolation. The
component-level sweep extends to whether the consumer composes those
helpers correctly across its full read/edit/save lifecycle.

**4k. New-shape × existing-consumer sweep when a recursive shared type gains an operator:**

The dual of 4j. When a PR adds a NEW shape to an existing recursive shared
type (e.g. `$not` added to `CriteriaSchema` as a new union arm; a new
operator object like `$between` on leaf shapes; a new child-discriminator
on a flow-step config), the auditor MUST grep for every existing component
that consumes the type as a prop and verify each has a render/dispatch
branch for the new shape. **Additive at the type level is NOT additive
at the consumer level.**

The recurring failure mode:

1. PR sub-phase adds the new shape to the Zod schema. Framing: "additive,
   no migration, no behavioral change for existing rows."
2. PR adds branches to the type's shared HELPER functions (walkers,
   pruners, formatters, numberers). Tests for the helpers cover the new
   shape at every depth.
3. The component consumers of the type are NOT touched. The audit's
   contract-edge sweep on the helpers passes. The schema test passes.
4. At runtime, the consumer dispatches on shape via if/else-if chains
   that have no branch for the new shape. The shape falls through to
   the leaf else (or the generic catch-all), and either crashes or
   renders garbage (e.g. `{$not: {...}}` rendered as a leaf with field
   name `$not`).

The greppable sweep:

```bash
# Find every component that has the recursive type in its props or
# rendered children. Example for Criteria:
grep -rnE ': (Criteria|FlowStepConfig|LayoutComponent)( \|| =|>)' \
  {{PATHS_SRC_GLOBS}}/components/ {{PATHS_SRC_GLOBS}}/components/ \
  --include='*.tsx' --include='*.ts'

# Find every component that renders the type — look for the type
# walking pattern (children.map, dispatch ifs):
grep -rnE 'isGroup\(|isExpression\(|isLeaf\(' \
  {{PATHS_SRC_GLOBS}}/components/ --include='*.tsx'
```

For each hit, open the file and verify the dispatch chain handles the
new shape. If the existing code is `if (isGroup) ... else if
(isExpression) ... else { /* leaf */ }`, adding `$not` means a new
`else if (isNotWrapper)` branch is needed BEFORE the leaf else.

Cross-check with tests: does any existing test mount the consumer with
an initial value containing the new shape? Tests that cover the old
shapes pass — but a test that never feeds the new shape into the
consumer can't catch the dispatch gap. If no test exists with the new
shape in the starting `value`, that's a finding even if all helper
tests are green.

Precedent: PR #663 (#662) added `$not` to `CriteriaSchema`. Sub-phase A
added `$not` branches to 11 helpers in `criteria-tree-utils.ts` with
contract-edge fixture coverage at every depth. Pass-3 audit reported
"`$not` contract-edge sweep clean." But `<CriteriaList>` had no
`isNotWrapper(child)` branch — the leaf else-fallthrough mis-rendered
`{$not: {...}}` as a leaf with field name `$not`. 4 ralph passes
missed it; Copilot caught it on third review. Fix added the dispatch
branch + 3 RTL tests rendering `$not` trees through the builder.

The lesson: 4j ("new component → its own cross-product sweep") and 4k
("new shape → every existing consumer's render audit") are duals.
A recursive-type extension PR almost always needs BOTH. Helper-level
contract tests catch neither.

**4l. LLM-facing examples vs runtime resolver:**

Any PR that ships strings the LLM will read as runtime syntax — registry
primitive `example` values, mustache templates, syntax-footer text,
prompt examples — needs verification that the strings ACTUALLY RESOLVE
under the runtime engine. Intuition is not a contract.

The greppable proxy: find every example containing `{{`, extract the
root path, check it against the engine's `resolvePath` switch (or the
equivalent resolver for the primitive's context).

```bash
# Find examples in primitive registries
grep -rn "example: '{{[^}]*}}'" {{PATHS_SRC_GLOBS}}/domains/automation \
  {{PATHS_SRC_GLOBS}}/domains/metadata --include='*.ts'

# For each hit, read the example's root path (the part before the first dot)
# and verify it's in the engine's accepted set:
#  - Flow / layout: inputs|record|steps|variables|env|user|tenant|route
#    (see {{PATHS_SRC_GLOBS}}/utils/expression-engine.ts:resolvePath)
#  - Actions: record.X | user.{id,name,email} | bare now/today | $NOW/$USER
#    (see {{PATHS_SRC_GLOBS}}/domains/automation/actions/action-executors.ts
#    resolveMergeTagsInString)
```

Bare un-namespaced names in flow / layout context (e.g. `{{ repositories }}`,
`{{ now }}`, `{{ triggerRecordId }}`) DO NOT resolve under the shared
engine — the switch falls through to `default: return undefined`, the
example renders empty string, and the LLM that imitates the example will
ship a broken flow. Same hazard for flow-style namespaces inside actions
(`{{ variables.X }}` doesn't work — actions use a smaller resolver).

If the registry has an arch test (e.g. `registry-description-quality.test.ts`
has **Rule 4**: extract every example token, validate root against the
engine's accepted set), confirm the test covers the new primitive. If
the new primitive is in a registry that does NOT yet have Rule 4,
adding it is a finding — without runtime verification you're shipping
contracts based on intuition. See `{{PATHS_AGENTS_DIR}}/auditor.md` dimension
5 ("LLM-facing strings must match runtime, not intuition") for the
audit posture; `{{PATHS_RULES_DIR}}/registry.md` "Verify examples against
the runtime engine — DON'T guess" for the canonical pattern.

Precedent: PR #716 (`#715` registry description quality) shipped 12
examples that didn't resolve under the actual engine. Caught only via
Copilot review across four rounds. Rule 4 + this audit step are the
backstops.

### 8. Branch hygiene — stranded dev-suffix branches

Before claiming PR is ready:

```bash
CUR=$(git branch --show-current)
git for-each-ref --format='%(refname:short)' refs/heads/ \
  | grep -E "^${CUR}-(dev|impl)$" \
  | while read devbranch; do
      AHEAD=$(git rev-list --count "${CUR}..${devbranch}")
      [ "$AHEAD" -gt 0 ] && echo "STRANDED: $devbranch is $AHEAD commits ahead of $CUR"
    done

# Also verify the PR branch has no unpushed commits
git log origin/$(git branch --show-current)..HEAD --oneline
```

Precedent: PR #508 shipped with only the spec commit pushed because the implementation sat on `feature/505-admin-groups-listviews-dev`.

### 8b. Pre-push lint hygiene + agent-instructions sync

Three classes of mistake that surface in CI / Copilot review **after** typecheck passes — local typecheck doesn't catch any of them. The auditor sweep MUST run these before declaring a pass.

**Unreachable code after `throw` / `return` (CodeQL fires; ESLint suppression does NOT carry over):**

```bash
git diff origin/<base>...HEAD -- '*.ts' '*.tsx' | grep -nE '(throw|return)\b.*$|^\+.*yield ' | head
# Targeted: any `throw … ; yield …` or `return … ; …` pair in added lines
git diff origin/<base>...HEAD -- '*.ts' '*.tsx' \
  | grep -nB1 '^+.*yield ' | grep -B1 '^+.*throw '
# `// eslint-disable-next-line no-unreachable` is a smell — CodeQL ignores it.
git diff origin/<base>...HEAD -- '*.ts' '*.tsx' | grep -n 'no-unreachable'
```

Precedent: PR #684 shipped two async generators of the form
`async function* fn() { throw err; yield {…}; }` with an
`// eslint-disable-next-line no-unreachable`. CodeQL flagged both.
Async generators conform to `AsyncGenerator<T>` even when the body's only
completion is `throw`; the yield is unnecessary. Fix: delete the yield AND
the suppression comment.

**Unused locals introduced and then refactored away:**

```bash
# Const declarations in added lines whose name never appears again in the diff
git diff origin/<base>...HEAD -- '*.ts' '*.tsx' \
  | awk '/^\+.*const ([A-Z_][A-Z0-9_]+) =/ { match($0, /const ([A-Z_][A-Z0-9_]+)/, a); print a[1] }' \
  | sort -u \
  | while read name; do
      uses=$(git diff origin/<base>...HEAD | grep -c "\b${name}\b")
      [ "$uses" -le 1 ] && echo "UNUSED: $name has only 1 occurrence in the diff (declaration site)"
    done
```

Precedent: PR #684 left `const KB = 1024;` in a test file after the
fixture was rewritten to use literal byte counts. CodeQL flagged it.

**Agent instructions sync — required after CLAUDE.md, {{PATHS_RULES_DIR}}/*, {{PATHS_SKILLS_DIR}}/*, or {{PATHS_AGENTS_DIR}}/* changes:**

```bash
# Detect the trigger
git diff origin/<base>...HEAD --name-only \
  | grep -E '^(CLAUDE\.md|\.claude/(rules|skills|agents)/)' > /tmp/sync-trigger
if [ -s /tmp/sync-trigger ]; then
  {{PKG_SYNC_AGENTS}}
  git diff --name-only AGENTS.md .agents/ .codex/ .github/ \
    | tee /tmp/sync-stale
  if [ -s /tmp/sync-stale ]; then
    echo "STALE: regenerate + commit the above files"
    exit 1
  fi
fi
```

Precedent: PR #684 updated `CLAUDE.md` Current Focus during the
context-update step but did not re-run `{{PKG_SYNC_AGENTS}}`, breaking the
`agent-instructions-sync` CI job. The check is a one-line command;
running it locally before push avoids a red-CI round trip.

### 9. Run typecheck

```bash
{{PKG_BUILD}} && {{PKG_TYPECHECK}}
# Frontend (if PR touches packages/ui or packages/frontend):
pnpm --filter @orm/ui build && pnpm --filter @orm/frontend typecheck
```

Typecheck failure is a CRITICAL finding.

### 10. Post findings

Use the output template in `{{PATHS_AGENTS_DIR}}/auditor.md`:

```markdown
## Audit Results — Pass N

### Summary
{pass|fail} — {N} findings: {C} CRITICAL, {H} HIGH, {M} MEDIUM, {L} LOW

### Findings

| # | Category | Issue | Severity | File(s) | Fix |
|---|----------|-------|----------|---------|-----|

### Remediation Plan
Every finding above must be addressed, in severity order, with a concrete file:line fix.
```

### 11. Re-audit after remediation

Both the spec-conformance pass and the pitfall passes must return zero findings in the same run before the audit is approved. One clean pass is never enough.

### 12. Update project board

After the audit passes (or after remediation is complete), update the linked {{VOCAB_ISSUE}}'s status on the {{TRACKER_BOARD_NAME}}:

- Audit passes → **Tests Complete** → **Ready for Context**
- Remediation needed → keep at **Ready for Tests** until fixed
- After `/update-context` runs → **Context Complete** (and it stays there:
  **Done** is set only at merge, by the post-merge `/cleanup` step — never
  by `/audit-phase` or `/update-context`; see `{{PATHS_CONTEXT_DIR}}/PROJECT_BOARD.md`)

See `{{PATHS_CONTEXT_DIR}}/PROJECT_BOARD.md` for option IDs and GraphQL commands.
