---
name: resolve-review-feedback
description: Address code-review feedback on a PR — read every thread, fix or push back with justification, commit + push, then EXPLICITLY RESOLVE every thread via the GraphQL `resolveReviewThread` mutation. Run when the user says "resolve copilot feedback" or similar.
---

<!-- host-specific: the tracker/host commands shown below are worked examples from
     one setup. Your configured equivalents live in the profile you installed with (profiles/<name>.env)
     (TRACKER_* / VCS_* tokens) — the CONTRACT each step implements is what
     ports; the exact invocation is not. -->


# Resolve {{VOCAB_REVIEWER}} Feedback

The single rule that gets forgotten: **resolving {{VOCAB_REVIEWER}}'s threads is a separate API call from pushing the fixes.** Pushing a commit does NOT close the threads — the conversation stays "open" until you mutate `resolveReviewThread` for each one. A reviewer scrolling the PR sees a wall of unresolved threads, has no idea which were addressed, and either re-reviews unnecessarily or assumes you missed them.

This skill codifies the full loop so that step never gets skipped.

## When to run

- User says "resolve copilot feedback", "address copilot review", "fix copilot's comments", or similar.
- A {{VOCAB_REVIEWER}} review just landed on a PR and the user wants it cleared.

If no review exists yet: don't fabricate one. Tell the user there's nothing to resolve, optionally trigger a re-request (`gh api --method POST repos/<owner>/<repo>/pulls/<N>/requested_reviewers -f 'reviewers[]={{VOCAB_REVIEWER}}'`).

## Process

### 1. Read every thread

```bash
gh api repos/<owner>/<repo>/pulls/<N>/comments --jq '.[] | {id, path, line, body: (.body | .[:700])}'
```

This returns inline comments (the ones tied to specific file:line). For the review-level summary, also:

```bash
gh api repos/<owner>/<repo>/pulls/<N>/reviews --jq '.[] | {user: .user.login, state, body: (.body | .[:200])}'
```

Read each one fully. Don't skim — {{VOCAB_REVIEWER}} is dense and a single sentence often contains the real concern + the suggested fix + the edge case to consider. Treat its review like a senior engineer's: most findings are real, a few are wrong, none are noise.

### 2. Decide per-thread: fix, push back, or defer

For each comment, pick one:

- **Fix**: implement the change. Most common outcome.
- **Push back**: respond in the thread explaining why the suggestion is wrong (e.g. it conflicts with an existing rule, it would regress another invariant, it's already handled elsewhere). Use `gh pr comment <PR> --body "..."` or reply via the GraphQL `addPullRequestReviewThreadReply` mutation. A push-back STILL gets the thread resolved at the end — but the resolution comment explains the disagreement.
- **Defer**: file a follow-up issue, link it from the resolution comment. Use this when the finding is real but out-of-scope for the current PR.

Don't agree-then-quietly-ignore. Either the change is in the diff or the thread carries a written justification.

### 3. Pre-emptive sweep — find what {{VOCAB_REVIEWER}} will catch NEXT round

**This is the step that gets skipped, which is why the same PR cycles through 5–8 review rounds.** {{VOCAB_REVIEWER}} reviews from a snapshot; each round it catches a *different category* of issue that you didn't proactively audit for. The single biggest behavioral lever for shortening the cycle is to run a focused checklist over the touched files BEFORE the commit, so the same push closes {{VOCAB_REVIEWER}}'s findings AND pre-empts the next round.

Apply each category to every file in the diff. Checks 3.1–3.11 were each caught by Copilot on PR #707 across rounds 1–8; 3.12–3.14 were each caught on PR #988 across rounds 1–8 (where fix commits repeatedly seeded the next round's findings); 3.15 was caught on PR #1244 (and, for half of it, on PR #1227 before that).

**3.1 — Input-validation gaps on prerequisites**

Composites that call sub-routes often treat any non-2xx as "empty result" and silently degrade. Prerequisite failures (object doesn't exist, template doesn't exist) should be surfaced as a 4xx with the upstream code; degraded-mode is for expensive aggregates only.

```bash
# Composite sub-injects that silently swallow non-2xx
grep -rnE "statusCode\s*<\s*400\s*\?" {{PATHS_SRC_GLOBS}}/domains/llm-composites/ --include='*.routes.ts'
```

Each hit needs triage: is this a prerequisite (use `assertInjectOk`) or an expensive aggregate that legitimately degrades (mark in `degradedSources[]`)?

**3.2 — Inline-type duplication**

If your service / repo signature mirrors a shape that already exists in `@orm/shared`, use the shared type. Inline duplicates drift.

```bash
# Service files with Promise<{...}> return-type literals — verify against @orm/shared
grep -rnE "Promise<\{" {{PATHS_SRC_GLOBS}}/domains/*/. --include='*.service.ts'
```

For each multi-property return type: check `{{PATHS_SRC_GLOBS}}/types/*.ts` for an existing type with the same shape. If found, import it.

**3.3 — Misnamed variables**

`*Ids` should hold UUIDs; `*Names` should hold API names. Misnaming is a future bug.

```bash
# Sets named *Ids that are populated from .apiName / .name
grep -rnE "new Set\(.*\.map\(" {{PATHS_SRC_GLOBS}}/ --include='*.ts' | grep -iE "Ids?\b.*apiName|Names\b.*\.id\b"
```

Triage each hit by name vs. value at the assignment.

**3.4 — Edge-case fallbacks in string transforms**

`labelToApiName`-style helpers that strip non-alphanumerics can return empty strings. Empty + a literal prefix = collision-prone (every "!!!" alert becomes the same `ea_`).

```bash
# Replace patterns that could produce empty output
grep -rnE "\.replace\(/\[\^[^/]*\]\+?/g," {{PATHS_SRC_GLOBS}}/ --include='*.ts'
```

For each hit: trace the input edge case where every character is stripped. Add a unique suffix (`Date.now().toString(36)`) or require an explicit value.

**3.5 — Comment / code drift**

When you change behavior, re-read the file header and any step-numbered comments. Re-read description / summary fields. A common {{VOCAB_REVIEWER}} finding is "comment says X but code does Y".

```bash
# All files in the diff with multi-line JSDoc / star-comments at the top.
# Substitute <base> with the PR's target branch (resolve via
# `{{VCS_VIEW_PR}}` — often
# `staging`, not `main`).
git diff origin/<base>...HEAD --name-only | xargs -I{} sh -c 'head -30 "{}" 2>/dev/null | grep -l "^ \*" "{}"' 2>/dev/null
```

Open each. Read the header against the current implementation. Any divergence is a finding.

**3.6 — Permission-contract honesty**

If your route advertises `[A]` in `x-requires-permission` but injects to a sub-route gated on `[B]`, your effective contract is `[A, B]`. The advertised contract must include both.

```bash
# Find composite x-requires-permission arrays
grep -rnE "'x-requires-permission':\s*\[" {{PATHS_SRC_GLOBS}}/domains/llm-composites/ --include='*.routes.ts' -A1
```

For each composite: walk every `instance.inject({ url: '...' })` in the file. Look up the target route's `preHandler` / `requireSystemPermission`. Union all required permissions. Compare to the composite's declared list.

**3.7 — URL correctness for sub-injects**

`instance.inject({ url: '/api/v1/foo/bar' })` silently 404s when the route doesn't exist; degraded-mode hides it.

```bash
# Every inject URL in composites
grep -rnE "instance\.inject\(\{[^}]*url:" {{PATHS_SRC_GLOBS}}/domains/llm-composites/ --include='*.routes.ts'
```

For each hit, extract the URL literal and verify it matches a registered route:

```bash
# Confirm a specific URL exists
grep -rn "app\.(get|post|patch|delete)\(['\"]<URL_FRAGMENT>" {{PATHS_SRC_GLOBS}}/domains/
```

A no-match means the inject 404s in production.

**3.8 — Response-schema shape consistency**

Multiple `return { data: {...} }` statements in the same handler must have the same shape, or the response varies per code path.

```bash
# Multi-return handlers
grep -rnE "^\s*return\s*\{\s*data:" {{PATHS_SRC_GLOBS}}/domains/llm-composites/ --include='*.routes.ts'
```

For each handler with 2+ hits: read every return and confirm the property set is the same (or extras are explicitly documented).

Same check for `successResponse({type: 'object'})` vs handler returning an array — declare `{ type: 'array', items: ... }`.

**3.9 — Description / contract length & format**

LLM-tool composite descriptions are bounded by `description-format.test.ts`. The test's regex captures past `'x-zod-body':` etc. until it hits `\n\s*(operationId|tags|summary|response):`. ANY comment block between description and `response:` is captured. Strip them.

```bash
pnpm --filter @orm/backend exec vitest run src/domains/llm-composites/__tests__/description-format.test.ts
```

Run before committing. If any composite description fails the length cap, the test's captured text includes everything up to the next anchor — your fix is to either shorten the description OR remove inline comments between the description and the next anchor.

**3.10 — Bodyless GET headers**

`forwardAuth(request)` sets `Content-Type: application/json`. On a bodyless GET, Fastify's JSON parser can throw "Empty JSON body" → 400.

```bash
# Composites that mix POST/PATCH and GET sub-injects
grep -rnE "method:\s*'GET'" {{PATHS_SRC_GLOBS}}/domains/llm-composites/ --include='*.routes.ts' -B1 -A2
```

For each GET inject: confirm `headers: forwardAuthBodyless(request)` (or a `headersGet` variant) — NOT `forwardAuth(request)`.

**3.11 — Direct-DB-read RBAC bypass in composites (HIGH severity)**

A composite that uses `withTenant().readOnlyTransaction()` (or `.transaction()` / `.writeTransaction()`) for a SQL read **bypasses the route-level permission gate that would normally protect that table**. Sub-`app.inject()` paths inherit the target route's RBAC; raw SQL reads do not. The composite's own `'x-requires-permission'` and `preHandler` MUST require every permission that would be required by the routes serving the tables the SQL touches — otherwise a caller with a narrower role can infer data they wouldn't see via the corresponding API.

This is a recurring HIGH-severity pattern. Caught in PR #707 round 10 after a prior "lean on degraded-mode" fix removed `MANAGE_CUSTOM_OBJECTS` — degraded-mode only handles `inject()` failures (or query-failure `try/catch` paths that surface in `degradedSources[]`), not the permission gap on a successful raw SQL read. A raw SQL read that degrades on *query timeout* still returns data on success; degradation does not substitute for the missing route-level permission check. The composite was leaking record-population per field + automation references to callers with `VIEW_AUDIT_LOG` alone.

```bash
# Composites with direct DB reads (any tenant-scoped table)
grep -rnE "withTenant\(.*\)\.(readOnlyTransaction|transaction|writeTransaction)" {{PATHS_SRC_GLOBS}}/domains/llm-composites/ --include='*.routes.ts'

# For each hit, identify the tables read inside the transaction and confirm
# the route's 'x-requires-permission' covers each one. Common mappings:
#   audit_logs                 → VIEW_AUDIT_LOG (or VIEW_SYSTEM_LOGS)
#   records (cross-object)     → VIEW_ALL_DATA
#   flows / flow_versions      → MANAGE_AUTOMATION
#   permission_sets / profiles → MANAGE_PERMISSIONS / MANAGE_ROLES
#   approval_*                 → MANAGE_APPROVAL_PROCESSES
#   integration_connections    → MANAGE_INTEGRATIONS
#   files / file_versions      → VIEW_ALL_DATA + relevant container perm
```

Required artifact in the composite file: a **table-to-permission mapping comment** at the top of the route plugin enumerating each direct-SQL read AND the route-level permission it bypasses. The `'x-requires-permission'` array MUST be the union of those permissions. Reviewer should be able to read the comment and verify the array matches it line-by-line.

Anti-pattern to refuse: "loosen the route perm because degraded-mode handles the rest." Degraded-mode is an `app.inject()`-only mechanism. If a permission is removed, every raw-SQL read in the file must be re-justified — usually by proving the table is non-sensitive (rare) or by converting the read to an `app.inject()` path (preferred when possible).

**3.12 — Self-inflicted drift: sweep YOUR OWN fix's blast radius**

The single biggest multiplier on PR #988 (8 rounds): each round's fix seeded the next round's finding. Before committing, re-audit what your fixes changed:

```bash
# For every method/behavior your fix commit renamed or changed, grep the
# context docs for the OLD shape
git diff HEAD --name-only | xargs -I{} basename {} .ts | sort -u | \
  xargs -I{} grep -rln "{}" {{PATHS_CONTEXT_DIR}}/ 2>/dev/null
```

Open each hit and confirm the doc describes the post-fix implementation (method names, concurrency behavior, schema constraints). A fix that changes `getXByApiName` to `getXsByApiNames` while DOMAINS.md still names the singular is a guaranteed next-round finding.

**Also sweep duplicated STRING pairs your fix touched — including doc-string generator/dictator pairs.** If your fix normalized a literal that appears at more than one site (a placeholder like `p{N}{M}`, an error message, an enum label, a naming-convention string), grep for every occurrence and fix them in the SAME commit — this is the `{{PATHS_RULES_DIR}}/shared-types.md` "sweep its siblings" rule applied to strings, and it bites in docs too. A common miss: fixing the *delivered* artifact (a generated `README`) but not the *spec section that dictates the artifact's contents*, leaving spec ↔ artifact drift that an `/audit-phase` run flags and that re-deriving the artifact from the spec reintroduces. Precedent: PR #1177 (#1056) — a fix normalized `pN{M}` → `p{N}{M}` in `.ai/discovery/README.md` but not the spec line specifying the README, and the confirming audit round caught the sibling. Greppable: after any string-literal normalization, `grep -rn '<old-form>\|<new-form>' <touched dirs>` and confirm zero of the old form survives.

**3.13 — Dead code left by the fix's rework**

If a fix DELETED an assignment or branch, re-read the surrounding function for now-dead conditionals: a ternary/if on a variable that can no longer be truthy at that point (CodeQL flags these as "useless conditional"). Greppable starting point — variables declared `let x: T | undefined` whose only assignment your diff removed or moved.

**3.14 — Schema-pair symmetry after constraint changes**

If the fix added `.min(1)` / `.refine` / `.nullable` to a Zod schema, grep `{{PATHS_SRC_GLOBS}}/types/` for sibling schemas sharing the same field names (produce-side vs consume-side pairs, e.g. a `*ItemSchema` and its `*SelectionEntrySchema`). Reconcile in the same commit or document why they legitimately differ — an asymmetric pair where one side can produce what the other side rejects is a real bug, not a style nit (PR #988 round 6). See `{{PATHS_RULES_DIR}}/shared-types.md` "Tightening one schema? Sweep its siblings".

**3.15 — Committed-doc hygiene: mutable state + machine-specific paths**

Applies to every `.md` in the diff — specs, `{{PATHS_CONTEXT_DIR}}/*`, deliverable docs. {{VOCAB_REVIEWER}} reliably flags both of these, and both are one grep away.

```bash
# Mutable agent-label / board-status assertions baked into a doc
git diff origin/main...HEAD -- '*.md' | grep -nE '^\+.*(agent:(awaiting-input|speccing|implementing|in-progress|error)|Ready for (Spec|Code|Tests|Context))'
# Machine-specific absolute paths (a $HOME-rooted path is developer-specific)
git diff origin/main...HEAD -- '*.md' | grep -nE '^\+.*(/home/|/Users/|C:\\\\Users)'
```

Triage each hit rather than treating it as an auto-fail: an *operational instruction* (`{{TRACKER_ADD_LABEL}}` in a spec or agent def) is fine — what is not fine is a doc **asserting the label's current value as a fact**. A doc that says "the issue stays labeled `agent:awaiting-input`" goes stale the moment the label moves — which it does constantly during the pipeline. State the fact without the label claim and let the live issue own its label state; see `{{PATHS_SKILLS_DIR}}/update-progress/SKILL.md` rule 7 for the canonical rule. **A spec that *instructs* such an edit is the same violation one level up** — reword the instruction, don't just fix the doc it produced. Same for paths: write "the repo-root `.env` in the operator's main working tree", never `/home/<user>/ORM/.env`.

Precedent: PR #1244 (#1191) Copilot round 1 — three of five threads were this class (a `BUILD_STATE.md` label assertion, the spec passage instructing it, and a hardcoded `/home/andy/ORM/.env`), and the label half had already been fixed once on PR #1227 for the SAME issue, which is what rule 7 was written for.

---

Add findings from this sweep to the upcoming commit alongside {{VOCAB_REVIEWER}}'s flagged threads. The summary comment in step 6 mentions them under a "Sweep additions" section.

### 4. Commit + push

Group all the fixes into ONE commit per review round — not one commit per thread. The commit message should mirror the structure of the review (numbered findings) so a reader can map commit ↔ thread:

```
fix(#<N>): apply {{VOCAB_REVIEWER}} review findings on PR #<P> (<count> findings)

1. <thread topic> — <one-line fix description>
2. <thread topic> — <one-line fix description>
...
```

### 5. Resolve every thread

**This is the step that gets forgotten.** The PR UI shows threads as "Resolved" only after a `resolveReviewThread` mutation. Pushing a commit doesn't do it.

First, list the open thread IDs (NOT the comment IDs from step 1 — different IDs):

```bash
gh api graphql -f query='query {
  repository(owner: "<owner>", name: "<repo>") {
    pullRequest(number: <N>) {
      reviewThreads(first: 30) {
        nodes { id isResolved comments(first: 1) { nodes { databaseId path } } }
      }
    }
  }
}' --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not) | .id'
```

Then resolve each (the `id` is the `PRRT_kw...` node ID, not the numeric comment ID):

```bash
for TID in PRRT_kwDO... PRRT_kwDO... PRRT_kwDO...; do
  gh api graphql -f query='mutation($id: ID!) {
    resolveReviewThread(input: { threadId: $id }) { thread { isResolved } }
  }' -F id="$TID"
done
```

Each call returns `{"thread":{"isResolved":true}}` on success. Bail if any return null/error — don't claim resolution that didn't happen.

### 6. Summary comment

Post one comment on the PR mapping each {{VOCAB_REVIEWER}} finding to its resolution. If the pre-emptive sweep (step 3) surfaced additional findings, append them under "Sweep additions" so the maintainer can see what was caught without a {{VOCAB_REVIEWER}} round:

```markdown
Resolved all <N> {{VOCAB_REVIEWER}} threads in commit `<sha>`:

**1. <{{VOCAB_REVIEWER}}'s finding topic>** — <how it was addressed>
**2. <{{VOCAB_REVIEWER}}'s finding topic>** — <how it was addressed>
...

### Sweep additions (pre-empting next round)

- <sweep-finding> — <one-line fix>
- ...

Verified: <one-line test/typecheck status>
```

Keep entries terse. The thread itself already has {{VOCAB_REVIEWER}}'s full text; the summary is the index.

## Hard rules

1. **Resolve every thread you addressed.** A pushed fix without a resolved thread reads as "ignored" in the PR UI.
2. **Resolve push-backs too.** If you disagreed with a finding, post the disagreement in the thread (or in the summary comment), then resolve. Leaving it open looks like inaction.
3. **Don't resolve threads you didn't address.** If a thread is genuinely out-of-scope, file a follow-up issue and reference it in the resolution comment — don't quietly close.
4. **Group commits by review round, not by thread.** Three commits for three findings makes git log noise; one commit with a structured message preserves the mapping.
5. **One PR summary comment, not N per-thread replies.** Use the comment as the index; the threads carry the detail.
6. **Re-running with no review present is a no-op.** Don't generate findings to address — if {{VOCAB_REVIEWER}} hasn't reviewed, prompt the user to trigger a re-request and stop.

## Verifying the resolution stuck

After step 5, re-query and confirm zero unresolved threads:

```bash
gh api graphql -f query='query {
  repository(owner: "<owner>", name: "<repo>") {
    pullRequest(number: <N>) {
      reviewThreads(first: 30) { nodes { isResolved } }
    }
  }
}' --jq '.data.repository.pullRequest.reviewThreads.nodes | map(select(.isResolved | not)) | length'
```

Should print `0`. If non-zero, an unresolve mutation didn't take — re-run for the missing IDs.

## Edge cases

- **{{VOCAB_REVIEWER}} left a review-level summary but no inline comments** — nothing to resolve. The review itself can't be "resolved"; the threads (inline) are what get resolved. Reply with `gh pr comment` if you want to acknowledge the summary.
- **A second Copilot review round lands during your fix work** — re-list threads after pushing; new ones from round 2 will be in the open set. Don't assume the list you fetched at the start is complete.
- **A thread author is a human reviewer (not {{VOCAB_REVIEWER}})** — same flow applies. The skill is named "resolve-review-feedback" because that's the dominant case, but every reviewer-thread cleared via this skill follows the same five steps.
- **GraphQL mutation returns `Could not resolve to <type> node` for the thread ID** — you're using the comment's `databaseId` instead of the thread's GraphQL `id`. Re-fetch with the query in step 5.
- **`gh api` returns 403 / 422 on the mutation** — the GH token needs `pull_requests: write` scope. Check `gh auth status`; the project token usually has it.

## After the cycle converges

Once every thread is resolved and no new review round lands, run
`/learn <PR>` (`{{PATHS_SKILLS_DIR}}/learn/SKILL.md`) to encode any
recurrence-class lessons from the cycle into the repo's rules/skills/agents
— that feedback edge is how the step-3 sweep checks in this file got here.

## Precedents

This skill was extracted from doing the same six-step sequence on PRs #659, #667, #671, #676. Earliest rounds skipped step 5 (resolve mutation) and left threads dangling — the user always noticed.

**Step 3 (pre-emptive sweep) was added after PR #707**, which cycled through 8 review rounds: each round Copilot caught a *different category* of issue (regex over-capture in R4, permission contract in R6, shared-type duplication + variable naming in R8). Individual fixes were correct, but the cycle continued because no sweep ran before each fix commit. The step-3 sub-checks each map to a finding from that PR (3.12–3.14 map to PR #988, whose 8-round cycle was driven by fixes seeding new findings) — running them as a checklist before each push closes Copilot's flagged threads AND pre-empts the next round in one commit. Codifying it kills that failure mode (the long-cycle one — distinct from the "forgot to resolve" failure).
