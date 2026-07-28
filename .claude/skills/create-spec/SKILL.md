---
name: create-spec
description: Create a detailed implementation spec before building a feature or phase. This should ALWAYS be the first step before writing any code.
argument-hint: "[feature-or-phase-name]"
---

# Create Implementation Spec: $ARGUMENTS

You are creating an implementation spec for **$ARGUMENTS**. This is always the first step before any code is written. The spec goes in `{{PATHS_SPECS_DIR}}/`.

## Process

### 1. Understand the scope

- Read `{{PATHS_CONTEXT_DIR}}/IMPLEMENTATION_SPEC.md` for the relevant phase/feature section
- Read `{{PATHS_CONTEXT_DIR}}/PRODUCT_SPEC.md` for the referenced product spec sections
- Read `CLAUDE.md` for current implementation progress and architecture context

### 2. Understand existing state from context files

Read the context files in `{{PATHS_CONTEXT_DIR}}/` to understand what already exists:

**Core state:**
- `{{PATHS_CONTEXT_DIR}}/BUILD_STATE.md` — Phase status, key counts, current focus
- `{{PATHS_CONTEXT_DIR}}/SCHEMA.md` — All database tables, columns, relationships
- `{{PATHS_CONTEXT_DIR}}/API_ENDPOINTS.md` — All registered API routes
- `{{PATHS_CONTEXT_DIR}}/DOMAINS.md` — Domain module inventory and dependencies
- `{{PATHS_CONTEXT_DIR}}/INFRASTRUCTURE.md` — Core systems, middleware, plugins, error classes
- `{{PATHS_CONTEXT_DIR}}/SHARED_TYPES.md` — Shared package exports (schemas, types, constants)
- `{{PATHS_CONTEXT_DIR}}/DEFERRED_ITEMS.md` — Work deferred from prior phases

**System deep-dives (read the ones relevant to your feature):**
- `{{PATHS_CONTEXT_DIR}}/AI_AGENTS.md` — Agent definitions, skills, context builders, LLM providers, conversations
- `{{PATHS_CONTEXT_DIR}}/INTEGRATIONS.md` — Providers, connections, executor pipeline, OAuth, circuit breaker
- `{{PATHS_CONTEXT_DIR}}/AUTOMATION.md` — Triggers, flows, actions, scripts, approvals, state machines
- `{{PATHS_CONTEXT_DIR}}/AUTH_SECURITY.md` — JWT, RBAC model, middleware stack, MFA, rate limiting
- `{{PATHS_CONTEXT_DIR}}/FRONTEND.md` — Route map, UI components, hooks, stores, layout engine
- `{{PATHS_CONTEXT_DIR}}/REALTIME.md` — Socket.io rooms, events, Redis adapter
- `{{PATHS_CONTEXT_DIR}}/DEPLOYMENT.md` — Docker, Railway, migrations, BullMQ queues, MinIO
- `{{PATHS_CONTEXT_DIR}}/PACKAGES.md` — Manifest schema, install lifecycle, registry service

Only explore the codebase directly if context files are missing or you need implementation details beyond what they cover.

### 3. Write the spec

Create the spec file at `{{PATHS_SPECS_DIR}}/{descriptive-name}.md` with this structure:

```markdown
# {Feature/Phase Name} Implementation Spec

**Branch:** `feature/{short-name}`

## Context
Why this is being built. What it depends on. What state the codebase is in.

## Existing Infrastructure
Bullet list of relevant things that already exist (tables, columns, utilities, patterns).

---

## Sub-Phase {X}A: {Name}
**Goal:** One sentence.

### New files
- List of files to create with brief description

### Modified files
- List of existing files to change and what changes

### Key implementation details
- Algorithms, data structures, SQL patterns, etc.

### Verify
- How to confirm this sub-phase works

---

(Repeat for each sub-phase)

## Dependency Order
ASCII diagram showing sub-phase dependencies.

## Key Files Summary
Table of all files with action (Create/Modify) and sub-phase.
```

### 4. Spec writing guidelines

- **Break large features into 3-6 sub-phases** that can each be independently committed and tested
- **Order sub-phases by dependency**: data model → domain CRUD → business logic → enforcement → wiring
- **Be specific about files**: list every file to create or modify, not just directories
- **Include SQL details** for migrations: table names, columns, constraints, indexes, RLS
- **Include Zod schemas** to define in shared types
- **Reference existing patterns**: note which existing domain to follow as a template
- **List API endpoints** with HTTP method, path, and description
- **Include verification steps** per sub-phase — what to run, what to test
- **Note cross-cutting concerns**: cache invalidation, event emission, error handling
- **Flag risks or decisions** that need clarification

### 4a. Pre-flight checklist (mandatory before finalising)

Work through every item. These are the mistakes specs have repeated and the
fixes took extra {{VOCAB_REVIEWER}} + audit rounds. See
`{{PATHS_AGENTS_DIR}}/spec-writer.md` for the canonical list; the abbreviated
version:

1. New `llm-tool` route → first tag is in `SKILL_CATEGORIES` (`admin`,
   `metadata`, `data`, `automation`, `security`, `integration`, `reporting`,
   `settings`). Grep `{{PATHS_SRC_GLOBS}}/types/ai.ts` to confirm.
2. If the domain's existing routes also use an invalid category tag
   (`'Packages'`, `'Groups'`, `'Approval'`, …), retag them in the same spec.
3. Path-param routes tagged `llm-tool` require `x-zod-params`.
4. Provenance columns (source, origin, created_via) go through
   `repository.create()`, NOT a post-install `updateX()` call.
5. Upstream data parse → `safeParse` + `PlatformError('UPSTREAM_X_INVALID',
   502)`. Never let ZodError bubble to the 400 handler.
6. Any column add/remove also modifies `{{PATHS_SRC_GLOBS}}/core/db.ts`
   (Kysely interface for the table).
7. New routes → register in `{{PATHS_SRC_GLOBS}}/test/helpers.ts`
   `createTestApp()`.
8. New table with FK → add to `cleanupTenant()` table list.
9. Migration number: `ls packages/backend/migrations/ | sort -V | tail -1`
   — take the next number (duplicates exist; counting doesn't work).
10. Service sibling-method calls: `fooService.method()`, not `this.method()`.
11. **Registry primitive expression-shaped fields (#715).** If the spec adds
    a new primitive (flow step, action type, field type, layout component,
    criteria operator, container provider) AND that primitive has
    `configSchema.properties[X]` whose values pass through an interpolator
    at runtime, every such field needs (a) `expression: true`, (b) a
    canonical `example` containing `{{ ... }}`, AND (c) the example's
    root path MUST be verified against the actual resolver before the
    spec is approved — open `{{PATHS_SRC_GLOBS}}/utils/expression-engine.ts`
    (or the action-side `resolveMergeTagsInString`) and confirm the root
    is in the accepted set. Arch test
    `registry-description-quality.test.ts` Rule 4 enforces this at CI
    time; if the registry doesn't yet have Rule 4 wired, the spec must
    include "extend Rule 4 to cover this registry" as a sub-phase.
    See `{{PATHS_RULES_DIR}}/registry.md` "Verify examples against the runtime
    engine — DON'T guess". Literal-lookup fields (API names, event
    names, variable names to BIND) whose names match the tripwire regex
    need a co-located `// expression-not-required: <reason>` comment.
12. **LLM-facing strings = runtime contract (#715 lesson).** Any string
    the spec ships that promises specific runtime behavior to an LLM
    consumer — registry descriptions, syntax footers, prompt templates,
    error-code copy — must be verified against the runtime, not against
    intuition. If the spec ships a class of such strings, the arch test
    for that class must runtime-verify each one. See
    `{{PATHS_AGENTS_DIR}}/auditor.md` dimension 5.
13. **Builtin-agent prompt edits require a tenant-migration sub-phase
    (#723).** If the spec touches `BUILTIN_AGENTS[i].systemPrompt` or
    any shared rule appended at seed time in
    `agent-definitions.service.ts` (`FAILURE_REPORTING_RULE`,
    `VERIFY_AFTER_MUTATE_RULE`, `VERIFY_AFTER_INVOKE_RULE`,
    `FLOW_VERSIONING_RULE`, future siblings), the spec MUST include a
    numbered migration that rewrites the inlined `system_prompt` column
    on `agent_definitions` for every tenant where the value still
    matches the previous canonical (strict equality, idempotent
    UPDATE). Migration 098 inlined per-tenant prompts — seed-time
    changes alone do NOT propagate to existing tenants. The spec must
    also update the drift-test target in `builtin-agents.test.ts`
    (`MIGRATION_xyz_PATH`) to point at the new migration, and verify
    every snake_case tool name in the new prompt by grepping for
    `operationId: '<name>'` before approval. The arch test
    `agent-prompts-vs-tool-catalog.test.ts` catches typos at CI time
    but is not a substitute for the grep check.
14. **Shared-helper generalization across call sites with different
    behavior policies (#1011).** If the spec generalizes existing logic
    into one shared helper called from ≥2 sites with different
    pre-existing edge-case semantics, either parameterize the helper per
    call site or document the delta explicitly. Never claim "no behavior
    change" without tracing every caller. See `{{PATHS_AGENTS_DIR}}/spec-writer.md`
    item 14 for the worked example.
15. **State-machine / reconciliation specs — enumerate the full condition
    cross-product, and state execution order explicitly (#1050).** If the
    spec adds or modifies a promote/demote/reconcile state machine (version
    activation, approval steps, anything with an "is this the current
    state" pointer plus independent boolean conditions), write out the
    literal (condition A × condition B × condition C …) truth table before
    finalizing — the same dimension-1 cross-product `{{PATHS_AGENTS_DIR}}/auditor.md`
    applies at review time, done up front instead. Every cell needs a
    stated, non-contradictory outcome; a branch that's only reachable when
    its own precondition is false is a spec bug, not an implementation bug.
    Additionally, if the spec's reconciliation helper reads "current" state
    (a pre-update DB row, a prior pointer) to decide its branch, the spec
    MUST state the helper's required execution order relative to any
    sibling write in the same call path (e.g. "call the helper BEFORE the
    existing header UPDATE, not after") — don't leave that implicit, an
    implementer will slot the new call wherever reads cleanly and can
    invert the intended read-before-write order.
16. **Sub-phases must not forward-reference a later sub-phase's
    not-yet-created helper/state (#1165).** If Sub-Phase N instructs
    calling something Sub-Phase M (M > N) creates, N isn't independently
    committable. Either omit the call from N and describe it only under
    M's Modified-files list (with a one-line deferral note in N), or
    reorder the sub-phases. Check EVERY adjacent sub-phase pair, not just
    the one you noticed first — PR #1175 (#1165) fixed this for D→E in
    round 1 but missed the identical C→D case until a later round.
    **A shared-registry entry is a forward-reference too:** an
    `ERROR_CODES` / `PERMISSIONS` constant that Sub-Phase N's code
    references but a LATER sub-phase registers makes N un-committable
    (typecheck fails — the constant doesn't exist yet). Register the code
    in the SAME sub-phase whose code first references it, not in a later
    one, and never leave the placement as a conditional "if B is committed
    before D, move it" judgment call. Precedent: PR #1223 (#1214)
    spec-audit — `MARKETPLACE_CREDENTIAL_NOT_CONFIGURED` was scheduled for
    Sub-Phase D while independently-committable Sub-Phase B's accessor
    already referenced it.

17. **Self-verify every referenced symbol and every declared enum/schema
    value before finalizing (#1162).** A single spec's audit cycle can burn
    5+ review rounds on findings that are all the same root cause: prose or
    code samples that assert something about the codebase without checking
    it. Before finalizing:
    - **Grep every hook/method/component name you reference.** `useTenant(id)`
      read naturally but the real hook was `usePlatformTenant(id)`;
      `platformAdminRepository.getTenant(...)` read naturally but the real
      method was `getTenantById(...)`. `grep -rn 'export function <name>\|export const <name>\|<name>(' packages/` before citing a symbol.
    - **Every enum/union value in a new Zod schema needs a stated producing
      code path in the same spec.** A `'skipped'` outcome with no described
      branch that returns it is the same completeness gap as an unregistered
      `PlatformError` code (see `{{PATHS_RULES_DIR}}/workflow.md` "Completeness
      traps") — the schema will ship a dead literal. If two enum values
      (e.g. `'partial'` vs `'failed'`) are both real, state the exact
      distinguishing condition for each, not just the first one you thought
      of.
    - **A sub-phase's Verify step may not depend on an artifact a LATER
      sub-phase introduces.** If Sub-Phase B's test wants to import an
      export that Sub-Phase F adds, either move the export into B or make B's
      test explicitly note it uses a fallback until F lands — check this
      against the spec's own Dependency Order diagram, don't let the prose
      and the diagram silently disagree.
    - **Don't describe a change as simpler than it structurally is** (e.g.
      calling a function-scope-to-module-scope hoist a "trivial rename" —
      `export` cannot be applied to a const declared inside a function body).
    - **When a file has multiple sibling components/functions, attribute a
      referenced line number to the specific one whose body it actually
      falls inside — not a neighboring sibling defined earlier or later in
      the same file (#1199).** "The component containing call X at line N
      already does Y at line M" is only true if N and M are both inside
      that same function's line range; read the file and confirm the
      range, don't infer it from proximity.
    See `{{PATHS_AGENTS_DIR}}/spec-writer.md` item 17 for the fuller writeup;
    precedent: `{{PATHS_SPECS_DIR}}/tenant-purge-delete-cascade.md` spec-audit rounds
    2–5 (sonnet) and rounds 1–3 (opus) — six distinct findings of this shape
    on one spec. `{{PATHS_SPECS_DIR}}/frontend-text-wrap-polish.md` (#1199, PR #1204)
    spec-audit sonnet round 1 — a spec claimed `ChatMessage`'s `useTranslation()`
    call lived at line 150, which was actually inside a sibling component
    (`CopyMessageButton`) defined earlier in the same file.
18. **Verify-section test plans must not assume a smaller mock/dependency
    surface than the component actually has, and a pure-function test of an
    extracted helper does not cover the WIRING code that calls it (#1166).**
    Before finalizing a sub-phase's Verify section: open the component/hook
    the tests will mount and list every hook it calls (react-query, router,
    socket, zustand stores, i18next, feature-flag/permission gates) — if
    the Verify prose claims "the only mocks required are X and Y," grep for
    every OTHER hook call and confirm none needs a mock too
    (`useTranslation` is the easy miss — jsdom has no i18next instance
    configured by default; mirror `ConfirmationCard.test.tsx`'s
    `vi.mock('react-i18next', ...)` stub). If the sub-phase's fix lives in
    imperative wiring code (a callback that reads store state and
    conditionally calls a setter, not just the pure function it delegates
    to), the Verify section must include a test that drives the ACTUAL
    wiring path, not only a unit test of the pure helper — the pure test
    can stay green while the wiring regresses. If a Verify step wants to
    mount a component but the file's own established test convention
    avoids mounting it, either extract the logic into a pure helper
    matching that convention or explicitly scope the full provider/mock
    harness as new work — don't leave the mount unscoped. See
    `{{PATHS_AGENTS_DIR}}/spec-writer.md` item 18 for the fuller writeup —
    **including a related trap**: a Verify bullet that extends an
    EXISTING store-level test file (one that already avoids mounting the
    component) and claims the new test "fails if the fix is reverted" is
    only true if the test calls the real wiring code — check it isn't a
    hand-reimplemented copy of the logic living inside the test file
    itself; precedent: `{{PATHS_SPECS_DIR}}/chat-send-audit-fixes.md` (#1167, PR
    #1181) spec-audit round 3;
    precedent: `{{PATHS_SPECS_DIR}}/chat-panel-drag-resize.md` (#1166, PR #1176)
    spec-audit rounds 1, 2, and 5 — five distinct findings of this shape.
    **A further trap on the same claim (#1199):** when a bullet asserts a
    mock/test change is "required to keep EXISTING tests green" (as opposed
    to "required only to enable a NEW test"), trace the actual control flow
    between the test's render call and the modified line — an early return
    (a role/type branch that returns a different component before reaching
    the changed line) can mean no existing test ever executes that code
    path, so the mock addition is required for the new test only. Siblings
    that call the same hook do NOT necessarily share the same reachability
    — verify each file independently; don't copy a sibling's
    already-corrected rationale onto a new file without re-tracing it there.
    Precedent: `{{PATHS_SPECS_DIR}}/frontend-text-wrap-polish.md` (#1199, PR #1204) —
    opus round 1 found the `ChatMessage.test.tsx` bullet's "existing tests
    would throw" claim false (all existing renders use a role that
    early-returns before the modified line); opus round 2 then found the
    `ConversationList.test.tsx` bullet had copied that "not required for
    existing tests" rationale verbatim, which was wrong in the opposite
    direction for that file (its existing tests DO reach the line).
19. **The spec's own file inventory must track every sub-phase that
    touches a file, not just the first (#1166).** When a LATER sub-phase
    modifies a file a prior sub-phase already listed (e.g. Sub-Phase C
    extends a helper Sub-Phase B created), add the later sub-phase to that
    file's row in BOTH the earlier sub-phase's "Modified files" list (or a
    note there) AND the Key Files Summary table — don't let the summary
    table silently understate which sub-phases touch a file. Precedent:
    `{{PATHS_SPECS_DIR}}/chat-panel-drag-resize.md` (#1166, PR #1176) — three
    separate findings (spec-audit rounds 3, 4, and opus round 2) on the
    same file-inventory gap.
20. **Quantitative/citation claims and any shell verification snippet must
    be produced by actually RUNNING the command against the working tree
    — never recalled or guessed (#1198).** Counts ("N call sites", "the
    only divergent site"), cited line numbers, and any Verify-step shell
    command must be checked against real output before the spec ships —
    a broken pipeline (e.g. an `awk` script with no `print` action) can
    silently emit nothing regardless of the codebase's real state, which
    is worse than omitting the command. **Corollary — don't embed a
    drift-prone count or line-number into prose that will outlive the
    moment it was true (#1213).** A hardcoded "N lines" / "585 lines" in a
    CHANGELOG entry, a "four items are flagged" count sitting next to a
    5-bullet list, or an internal "see line 363" back-reference all go
    stale on the next edit. Omit the number, use a relative reference ("the
    heading-count grep in Sub-Phase B's Verify section"), or — when a count
    is stated next to its own enumerable list — make it equal that list's
    length in the SAME commit. **Corollary — a token-scanning Verify grep
    asserting an occurrence COUNT must account for comment/docblock prose
    mentions AND test-fixture construction sites, not just live code
    (#1233).** A directory-scoped `grep -rn thirteen packages/…/deployment
    packages/…/marketplace` that a spec claims "returns exactly one hit"
    also matches a test file's docblock line that mentions the token as
    prose and every `dependsOn: null`-style fixture construction — so the
    real count is higher than the spec's expectation, and an implementer
    running it verbatim reads the mismatch as a broken edit. Scope the grep
    (`--include`, exclude `*.test.*`, strip comments) or list every site it
    legitimately matches, and reword any "grep returns zero hits" citation
    to "returns only test-fixture construction, no live reads."
    **Corollary — a `path:NNN` pointer into a file the SAME change edits is
    drift-guaranteed, not drift-prone (#1191).** The spec's own sub-phases
    shift every line below their insertion, so the citation is wrong by the
    time the PR opens and lands the reader on unrelated content. Anchor to
    quoted heading/section text instead; sweep with `grep -nE '\.(md|ts|tsx|sql):[0-9]+' {{PATHS_SPECS_DIR}}/<feature>.md` before finalizing.
    See `{{PATHS_AGENTS_DIR}}/spec-writer.md` item 21 for the fuller writeup and
    precedents (#1198, PR #1205; #1213, PR #1217; #1233, PR #1237; #1191,
    PR #1244).

21. **A new tenant-scoped table gets its own dedicated cross-tenant test
    file — not a single assertion folded into a larger integration test
    (#1031).** Item 8 above ("New table with FK → add to `cleanupTenant()`")
    is necessary but not sufficient: `{{PATHS_CONTEXT_DIR}}/RLS_NEW_DOMAIN_CHECKLIST.md`
    §5 requires a standalone `<entity>.cross-tenant.integration.test.ts`
    file (seeded via `getSeedDb()`, per the ~26 existing precedents such as
    `layouts.cross-tenant.integration.test.ts`). When a spec introduces a
    new tenant-scoped table, list that file explicitly as a New file in the
    owning sub-phase AND in the Key Files Summary table — don't let the
    isolation guarantee for the new table live only as one assertion inside
    a bigger feature-level test (e.g. a deployer/reconcile integration test
    that happens to touch the new table once). Precedent:
    `{{PATHS_SPECS_DIR}}/metadata-provenance-ledger.md` (#1031, PR #1207) spec-audit
    sonnet round 1 — the spec cited the RLS checklist for its Kysely-sync
    step but never scheduled the dedicated cross-tenant file for the new
    `package_owned_entities` table.

22. **Specs that produce a normative deliverable doc (or carry any fact in
    more than one place) must be swept for internal + cross-file
    consistency before finalizing (#1213).** Three sub-checks, all of which
    burned repeated audit rounds on one doc-artifact spec:
    - **Same fact in multiple views / mirrored copies → sweep every
      occurrence in one commit.** When a doc maintains the same fact in
      several views (a per-entry "Owner issue(s)" field ↔ a summary table ↔
      an applicability matrix), OR a spec mirrors a table byte-identically
      into its deliverable AND its own implementation-spec copy, editing one
      occurrence and leaving the siblings stale is a guaranteed next-round
      finding. Grep the changed identifier across all views/files and
      reconcile them together — same discipline as `{{PATHS_RULES_DIR}}/`
      "sweep every sibling," applied to prose cross-references.
    - **Verify must check every section / heading-format / caveat the "Key
      implementation details" promises.** If a sub-phase's implementation
      instructions promise the deliverable contains Section 4, a `### CARD-SR-N`
      heading format, or a "provisional" caveat, its Verify checklist needs a
      matching grep/eyeball bullet — a format "pinned" only in a Verify
      parenthetical that the instructions never actually instruct is not
      pinned at all.
    - **Out-of-scope / "no edit needed / handled later" meta-claims must
      match what the PR actually changes.** A spec asserting "CLAUDE.md needs
      no edit" or "DEFERRED_ITEMS updates happen in a later step" while the
      same PR edits those files is a self-contradiction {{VOCAB_REVIEWER}} flags every
      time. Reconcile the scope prose with the real file set.
    - **When a later revision round ADDS an edit, recompute every
      Verify-step grep-count the new edit affects.** A `grep -c "X" → 1`
      assertion written in an early round becomes a self-contradiction the
      moment a later round adds a second edit that also emits `X` — an
      implementer running the Verify literally sees `2`, concludes their
      correct edit is wrong, and strips it (defeating the multi-view
      consistency the same spec required) or burns a debugging cycle. Re-run
      the count against the post-revision edit set, not the round-1 one.
    - **When the deliverable IS a doc-state transition (flip every marker,
      tick every checkbox, fill every matrix cell), bucket the marker's
      syntactic SHAPES and pin a numeric tally per shape at the sub-phase
      boundary that owns it (#1191).** Heading suffixes, per-line cell
      markers, unticked `- [ ]` boxes, and a differently-worded prose
      paragraph (`**Not executed**` vs `PENDING`) are four shapes a
      single-pattern Verify grep can't all see — so an implementer passes
      every literal Verify step, commits the sub-phase, and the final
      whole-file grep forces a rework commit reopening an already-closed
      section. Run the marker grep on the pre-edit file, bucket the hits,
      give each bucket a countable Verify bullet with a running tally
      (`32 → 30 → 28 → 1 → 0`). Line-split phrases need
      `tr '\n' ' ' < file | grep -ic '<phrase>'` — no line-scoped grep sees
      them.
    See `{{PATHS_AGENTS_DIR}}/spec-writer.md` item 22 for the fuller writeup and
    the many-rounds-on-one-spec precedents: #1213 (PR #1217) and #1214
    (PR #1223) — both burned 5+ spec-audit rounds on this class on the SAME
    `cardhouse-security-requirements.md` living-table doc (partition manifest
    ↔ Section 4 "Owner issue(s)" ↔ Section 5 "Gated by" / "Spec obligations"
    ↔ `planned`→`built` status), including a Verify `grep -c` count that
    contradicted the spec's own later-added Section 5 obligations edit.

23. **A spec that pins verbatim create-API payloads or a verification matrix
    of expected pass/fail calls must validate every pinned field against the
    target Zod schema AND every asserted runtime result against the field-type
    coercion code — not intuition (#1191).** The pinned bodies ARE a test
    harness for whoever replays them, so a wrong field/result is a 400 or a
    false model-failure at replay. Traps that each cost audit rounds on one
    spec: (a) required-no-default fields (`label`) and bare `z.record(z.string())`
    fields (`CreateRecordTypeSchema.description` — NOT a `LocalizedField`, 400s
    on a plain string) omitted from an otherwise-exhaustive payload; (b)
    coercion — Currency/number `coerce('')`→`0` (passes, stored as 0; `Number('')===0`),
    Text `coerce('')` preserves `''` so a `$isNull:false` require branch treats
    `''` as SET — so "every required field rejects `''`" is false for
    Currency/Text; (c) a field-level `defaultValue` is applied BEFORE
    record-type `picklistOverrides` narrow validation, so a default the RT
    excludes 400s on an omitted field; (d) each expected-pass matrix row must
    carry its status's required-core fields (else literal replay 400s), each
    expected-reject row must isolate its rule (the evaluator aggregates ALL
    failures, no short-circuit), and the valid-baseline note must cover EVERY
    matrix subsection, not just the first. See `{{PATHS_AGENTS_DIR}}/spec-writer.md`
    item 23. Precedent: PR #1227 (#1191) — MEDIUM findings across spec-audit
    sonnet r1–2, opus r1–2, code-audit sonnet r1, opus r3–4.
24. **Every sub-phase that adds new code gets a `pnpm --filter @orm/backend
    typecheck` (or the matching package's) bullet in its Verify section —
    uniformly, not for some sub-phases and not others (#1059).** A compile
    check is the cheapest completeness gate; a spec that includes it for four
    of six new-code sub-phases and silently omits it from the two that add a
    repository accessor set + a CLI script is internally inconsistent and lets
    the un-checked sub-phases ship a typecheck regression the Verify never
    catches. When finalizing, scan every sub-phase's Verify: if the sub-phase
    creates/edits `.ts` under a buildable package, it needs the typecheck
    bullet. Precedent: PR #1241 (#1059) spec-audit sonnet round 1 (LOW) —
    Sub-Phases C and F omitted the typecheck bullet that A/B/D/E all carried.

24. **A spec that defers an acceptance criterion to a human reviewer must
    walk the reviewer's ENTIRE path and pin every precondition (#1191).**
    The deferral is exactly what makes the criterion unverifiable by the
    pipeline — when `{{PATHS_RULES_DIR}}/workflow.md`'s `Refs`-not-`Closes`
    exception applies, that criterion is both the sole thing keeping the
    issue open and the one step no Verify command exercises, so every
    sub-phase can be green while the reviewer's instruction is literally
    unperformable. Replay it as a stranger with a clean checkout and
    confirm: the data still exists (a cleanup step that deletes "every
    verification record" deletes the one they're told to open — exempt a
    sample and fix the sibling "no live records" assertion in the same
    edit); the route is reachable (a record URL needs a parent app; nothing
    seeds one); the URL carries its origin (tenant resolution is
    subdomain-based — a path-only URL hits `TenantRequiredPage` before the
    router mounts); the reviewer can authenticate (only the FIRST user in a
    tenant is auto-admin, so re-registering does not work — pin a stable
    off-repo credential path and hand off the PATH, never the values); the
    build artifacts exist (`{{PKG_INSTALL}} && {{PKG_BUILD}}
    && pnpm --filter @orm/ui build` — both `exports` point at a `dist/` a
    fresh worktree lacks, which also breaks any `tsx` spec step importing
    `@orm/shared`); and nothing render-gates the observation
    (`RecordDetailPage` early-returns "No layout configured" *before* the
    breadcrumb). Related: a liveness/pristineness preflight must actually
    FAIL in the mode it guards — probe `GET /api/v1/health` (reports
    `checks.{database,redis,minio,bullmq}`), not an endpoint that errors
    before touching the DB, and treat an unexpected 403 from a
    permission-gated probe as a failure signal. See
    `{{PATHS_AGENTS_DIR}}/spec-writer.md` item 24. Precedent: PR #1244 (#1191) —
    seven findings of this one class across five audit rounds, each a
    different unstated precondition on the same reviewer instruction.

### 4b. Architectural-posture checklist

Beyond the per-feature mistakes above, every spec must preserve the
maximalist dynamic posture. Answer each question; if any is "no", justify
in the spec or drop the feature.

1. Is each new primitive type **registered** (not switched on)? See
   `{{PATHS_RULES_DIR}}/registry.md`.
2. Is each new behavior **LLM-callable** via a tagged `llm-tool` route? See
   `{{PATHS_RULES_DIR}}/agent-skills.md`.
3. Does each new registry expose **list + describe** endpoints? See
   `{{PATHS_RULES_DIR}}/registry.md` "API endpoints".
4. Are contracts **Zod-first** with types inferred? See
   `{{PATHS_RULES_DIR}}/shared-types.md`.
5. Do new components **declare their prop schema** rather than relying on
   a renderer switch?
6. Is data **declared** (query / context-builder) rather than baked into
   the component?
7. Did you ask "is this a primitive others could compose?" (composition over
   specialization)
8. No **black-box** services — every service operation has a tagged route
   equivalent.
9. Do **labels and descriptions** in the catalog match the UI copy (LLM as
   peer)?
10. Does dispatch use **runtime registry lookup** instead of compile-time
    switch?

The full reasoning lives in `{{PATHS_RULES_DIR}}/architecture-principles.md`.

### 5. Update project board

After the spec is created, update the linked {{VOCAB_ISSUE}}'s status on the {{TRACKER_BOARD_NAME}} to **Spec Created**.

See `{{PATHS_CONTEXT_DIR}}/PROJECT_BOARD.md` for the option IDs and GraphQL mutation commands.

Steps:
1. Get the issue's project item ID from the board
2. Set status to "Spec Created" (option ID from PROJECT_BOARD.md)
3. If the spec is immediately approved by the user, advance to "Ready for Code"

### 6. Update references

- Update `CLAUDE.md` current focus to reflect the new work
- **Any edit to `CLAUDE.md` requires ` ` in the same commit,
  and the regenerated files (`AGENTS.md .agents/ .codex/ .github/`) staged
  alongside it.** This applies here too, not just at the context-update
  step — `agent-instructions-sync` in CI diffs against HEAD, so a spec
  commit that edits `CLAUDE.md`'s Current Focus line without regenerating
  AGENTS.md fails the same CI job a later context-update commit would.
  Precedent: PR #684 (context-update step) and PR #1164/#1160 (spec-draft
  step) both shipped this exact drift — it recurs because the instruction
  to sync lived only at the context-updater's checklist, not here at the
  point where create-spec itself tells you to touch `CLAUDE.md`.
- If this spec replaces or supersedes an older one, note that in the Context section

## Spec Storage

All specs live in `{{PATHS_SPECS_DIR}}/` with descriptive filenames:
- `phase-N-{short-name}.md` for implementation phases
- `feature-{short-name}.md` for standalone features
- `fix-{short-name}.md` for significant bug fix plans

## Key References
- Implementation spec: `{{PATHS_CONTEXT_DIR}}/IMPLEMENTATION_SPEC.md`
- Product spec: `{{PATHS_CONTEXT_DIR}}/PRODUCT_SPEC.md`
- Build state & context files: `{{PATHS_CONTEXT_DIR}}/BUILD_STATE.md` (index to all context files)
- Domain pattern: `{{PATHS_SRC_GLOBS}}/domains/metadata/` (template)
- Existing specs: `{{PATHS_SPECS_DIR}}/`
