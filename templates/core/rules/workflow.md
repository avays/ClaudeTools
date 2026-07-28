---
globs: []
---

# Workflow Rules

## Mandatory Workflow Order

Every piece of implementation work MUST follow this sequence:

1. **Issue first** — Create an {{VOCAB_ISSUE}} in your tracker ({{VCS_REPO_SLUG}})
   describing the feature, bug, or change before any spec or code work. The
   issue is the ticket of record; it auto-adds to the
   {{TRACKER_BOARD_NAME}}.
2. **Spec second** — Run `/create-spec` to produce a detailed
   implementation spec in `{{PATHS_SPECS_DIR}}/` that must reference the issue
   number. Get user approval before writing code.
3. **Implement third** — only after the issue exists AND the spec is approved.
4. **Self-audit fourth — BEFORE opening the PR, pushing the "final" commit,
   or declaring the work done.** Mandatory and proactive. Typecheck + tests
   passing is necessary but NOT sufficient — they don't catch
   incomplete-chain edits, missed call sites, or RBAC/correctness gaps.

## Self-audit before declaring done (mandatory)

After the implementation compiles and its tests pass, and BEFORE opening a
PR, pushing the "final" commit, or reporting completion — do this without
being asked:

1. **Spawn both reviewers in parallel** on `git diff origin/<base>...HEAD`:
   the **`auditor`** agent (architectural / spec-conformance / completeness)
   AND the **`line-reviewer`** agent (line-by-line, including LOW nits).
   Independent perspectives — run both, not one. (The `/audit-phase` skill
   is the spec-driven equivalent for phase work; the two agents are the
   diff-driven equivalent for any change.)
2. **Triage every finding.** Fix the real ones; for any rejection, write one
   line on why. Re-run typecheck + affected tests after fixing. Comment
   hygiene applies to the fix itself: never put workflow metadata
   (`audit round 1 LOW #NNN`, `fix pass 2`, `line-review #1`) in source
   comments — state the why in durable terms. Same rule as
   `{{PATHS_AGENTS_DIR}}/developer.md` "Comment hygiene (#843)"; the violation
   recurs inside audit-fix commits (PR #1157 r1→r2).
3. **Loop until a CONFIRMING CLEAN PASS — no exceptions.** After fixing (or
   rejecting-with-reason) a pass's findings, you MUST spawn a fresh audit
   pass over the new diff. **The loop ends on an audit, not on an edit** —
   the ONLY thing that closes it is a fresh reviewer pass (both reviewers)
   that finds nothing. Convergence is not: fixes being trivial, findings
   decreasing, a pass count picked up front, or you having verified the fix
   yourself. Two silent under-run modes: (a) a fixed `--audit-passes N`
   that happens to end on an audit that FOUND issues — not converged, add
   another fix+audit cycle; (b) the final pass surfaces a finding you fix
   quietly and ship without re-auditing — that reopens the loop, it does
   not close it. Stopping after a fix is the single most common under-run —
   budget for the extra pass up front.
4. Only after a confirming clean pass: open/update the PR and report that
   the loop converged ("pass K returned no findings"), not merely that K
   passes ran.

This is the default close-out for every implementation, whether or not the
user said "audit" or "ralph". Once the loop converges (and any subsequent
{{VOCAB_REVIEWER}} cycle on the {{VOCAB_PR}} ends), run `/learn <PR>` to encode the cycle's
recurrence-class lessons — see `{{PATHS_SKILLS_DIR}}/learn/SKILL.md`. The ship
workflow does this automatically as its terminal phase; manual pipelines
must do it explicitly.

## Sibling sweep (canonical statement)

**When a fix or constraint lands on ONE member of a set of siblings sharing
the same shape — fields with the same fallback pattern, handlers with the
same guard, schemas mirroring each other's fields, duplicated derivation
blocks, state written by multiple producers — apply it to EVERY sibling in
the same pass.** Fixing only the instance a reviewer named relocates the bug
to the next sibling; repo history shows the same defect recurring across
several (up to eight) review rounds whenever the sweep was skipped. Grep
for the shared shape (the fallback expression, the guard, the field names,
the derivation predicate) before declaring any such fix complete.
Domain-specific instances live in the other rule files (backend-general.md,
shared-types.md, frontend-components.md, backend-database.md among them).

The same discipline applies to **guard/branch consolidation refactors**:
when simplifying a boolean guard or moving an unconditional call into
per-branch gates, write out what the OLD condition accepted vs. the NEW one
and confirm a strict superset — don't eyeball the common case. (PR #1181
(#1167), three instances in one cycle: `agentApiName` backfilled in one
branch but not `startFreshTab`'s reset path; a guard rewrite dropping the
bootstrap escape across 6 sibling handlers; an unconditional
`clearStreamingMessage()` moved into per-branch gates, losing one branch.)

## Completeness traps (incomplete chains)

The most common class the typecheck/test pass misses: an edit that adds a
case to one dispatcher but not its siblings. When you add a new variant to
ANY enumerated set, grep every sibling site and confirm you hit them all.
Known multi-site chains:
- **A new variant of any typed registry entry** → the registry's definitions
  array, the count/tripwire test that pins its size, and the list/describe
  endpoints that expose it.
- **A new error code** → the code registry, plus any UI-side map keyed by
  that registry (a typo'd key fails the arch test, not the build).
- **A new permission** → the permission registry, plus every route guard and
  schema annotation that names it.
- **A new config/env var** → BOTH the schema field AND the place that reads
  `process.env` into it. Adding only the schema field leaves the value
  permanently undefined: no type error, no test failure, and every gate on it
  silently takes the unconfigured branch.
- **A `.default()` added to a widely-used schema field** → the field becomes
  REQUIRED in the inferred type, so every construction site must supply it,
  **including test fixtures**. A sub-phase that verifies with typecheck alone
  and not tests will miss them.
- **A new column that round-trips through an export/deploy pair** → the type
  interface, the INSERT path, AND the UPDATE path (the UPDATE is the reliable
  miss), plus a regression test per path.

For a set of fully worked chains — real file lists, real issue numbers, and
the specific way each one was missed in review — see
`docs/examples/completeness-chains-upstream.md`. Read one before assuming a
chain is short.

## Board Pipeline Automation

Use `/board <issue_number> [step]` to run the pipeline. All steps run in
**isolated git worktrees by default**, enabling parallel issue processing
across terminals:

```bash
/board 30          # auto-detect next step, run in worktree
/board 30 all      # run all remaining steps sequentially
/board 42 code     # run specific step in worktree
/board 30 code no-worktree   # opt out (debugging only)
```

Worktree rules: each worktree gets its own isolated checkout of the feature
branch, so multiple issues run in parallel without branch conflicts.
**Code-modifying agents** (spec-writer, developer, context-updater) MUST
push to remote after every commit — worktrees are temporary and local-only
changes are lost on cleanup. Read-only agents (refinement, test-runner,
auditor, pr-creator) don't need to push — worktree cleanup is safe.

## {{VOCAB_BOARD}} status tracking

Every {{VOCAB_ISSUE}} tracks its progress on {{TRACKER_BOARD_NAME}}. Update
the status at each workflow transition (`{{TRACKER_SET_STATUS}}`):

| Workflow Step | {{VOCAB_BOARD}} status | Who/When |
|---------------|-------------|----------|
| Issue created | Backlog | Auto (workflow action) |
| Needs discussion | Ready for Refinement | Manual |
| Requirements clear | Refined | Manual |
| Ready to spec | Ready for Spec | Manual or after refinement |
| `/create-spec` done | Spec Created | `/create-spec` skill |
| Spec approved | Ready for Code | After user approval |
| Implementation done | Code Complete | `/implement-phase` skill |
| Ready for audit | Ready for Tests | After code review |
| Audit/tests pass | Tests Complete | `/audit-phase` skill |
| Context update needed | Ready for Context | After tests |
| `/update-context` done | Context Complete | `/update-context` skill |
| Merged to main | Done | Final step |

See `{{PATHS_CONTEXT_DIR}}/PROJECT_BOARD.md` for option IDs and CLI commands.

## Agent Locking — agent working locks are mutexes

When an agent (local or CI-hosted) starts work on an {{VOCAB_ISSUE}} it MUST
acquire a working lock. On this project the lock is {{TRACKER_LOCK_MECHANISM}}.
Other agents — including parallel Ralph workers and concurrent `/board`
invocations — treat a held lock as "taken, skip". The canonical pickers
(`scripts/ralph.sh:pick_next_issue` and board-runner auto-detect) filter out
{{VOCAB_ISSUES}} whose lock is held.

**The whole contract below assumes the acquire is ATOMIC** — that two agents
cannot both observe an unlocked {{VOCAB_ISSUE}} and both come away believing
they hold it. Verify that for your tracker before running agents in parallel:
a label add is atomic on some trackers and a read-modify-write on others, and
where it is not, the acquire must be a compare-and-set on a single-valued
field plus a read-back to confirm you won. Losing this property does not
produce an error — it produces two agents quietly working the same
{{VOCAB_ISSUE}}.

| Label | Set by | Meaning |
|-------|--------|---------|
| `agent:in-progress` | `ralph.sh` (drain mode) / external orchestrators | Outer-fence lock acquired BEFORE invoking `/board`; coexists with the per-step label and is transparent to board-runner |
| `agent:refining` / `agent:speccing` / `agent:implementing` / `agent:testing` / `agent:updating-context` / `agent:creating-pr` | board-runner (local) AND CI workflow handlers | Per-step working lock — set on entry, removed on exit |
| `agent:awaiting-input` | Any sub-agent that posts a question | Human input needed — agents must NOT proceed |
| `agent:error` | CI failure handler | Processing failed — needs human review |

### Lock contract (every orchestrator follows it)

1. **Acquire BEFORE moving the board status into an actionable state.**
   `pick_next_issue` filters on `(actionable_status AND no agent:* label)`;
   if the status moves into `Ready for *` before the label is set, a
   concurrent picker can grab the issue in the gap. The acquire
   (`{{TRACKER_LOCK_ACQUIRE}}`) runs first; the
   status move and the agent invocation run after. Ralph drain uses
   `agent:in-progress` (step unknown up front); board-runner uses the
   matching per-step label once the step is determined — per-step labels
   are preferred whenever the step is known up-front; `agent:in-progress`
   is the generic lock.
2. **On the success path, advance the board status BEFORE releasing the
   lock** — same race in reverse; advance to the non-actionable post-step
   gate (e.g. `Spec Created`) first, so the status protects the issue
   while the label comes off.
3. **Release on every exit path** — success, failure, AND timeout (shell
   trap / `try/finally`). On failure, release WITHOUT advancing status.
4. **Never release `agent:awaiting-input` or `agent:error`** — those are
   human-gated; removing them is the human's job.
5. **Each orchestrator manages only its own label** — `agent:in-progress`
   belongs to Ralph drain / external orchestrators; the per-step labels to
   board-runner / GHA handlers. Neither stomps the other's.

### Stale lock recovery

If a process crashes mid-step the lock strands and the issue becomes
unpickable. Recovery is manual and explicit:

```bash
# 1. Confirm no agent is actually working (check ralph.log, ps, open PRs)
{{TRACKER_LOCK_QUERY}}

# 2. If genuinely stranded, release it
{{TRACKER_LOCK_RELEASE}}
```

Do NOT auto-clear stale locks from the picker — silent stale-clear masks
the underlying crash; surface it for the operator.

## {{VOCAB_ISSUE_CAP}} ↔ {{VOCAB_PR}} linking

Every {{VOCAB_PR}} opened by the pr-creator agent MUST link to its {{VOCAB_ISSUE}} through BOTH
channels:

1. **`{{TRACKER_CLOSE_KEYWORD}}` in the {{VOCAB_PR}} body** — auto-closes the
   {{VOCAB_ISSUE}} on merge and creates the structural link. **Exception —
   partial or human-gated delivery: use `{{TRACKER_REF_KEYWORD}}`, not
   `{{TRACKER_CLOSE_KEYWORD}}`.** When the PR ships only a subset of a
   multi-sub-phase issue and the remaining deliverable is human-gated,
   deferred, or otherwise not in this PR, `Closes` would auto-close an
   unfinished {{VOCAB_ISSUE}} on merge; use `{{TRACKER_REF_KEYWORD}}`, say in the
   {{VOCAB_PR}} body which sub-phases are NOT delivered and why it stays open,
   and keep the issue's gate label (e.g. `agent:awaiting-input`) until the
   remaining work lands. Precedent: PR #1177 (#1056) — Copilot caught
   `Closes` contradicting the spec's own hold-open plan.
   Choosing `Refs` obligates the spec to make the human-gated criterion
   actually performable: it is the one acceptance criterion no Verify
   command exercises, so every sub-phase can pass while the reviewer's
   instruction is impossible to carry out (sample record cleaned up, no app
   to route to, URL missing the tenant subdomain, no credentials, `dist/`
   never built). Walk the reviewer's whole path and pin each precondition —
   `{{PATHS_AGENTS_DIR}}/spec-writer.md` item 24 / `{{PATHS_SKILLS_DIR}}/create-spec/SKILL.md`
   pre-flight item 24. Precedent: PR #1244 (#1191) — seven findings of that
   class across five audit rounds on one reviewer instruction.
2. **A comment on the {{VOCAB_ISSUE}} announcing the {{VOCAB_PR}}** —
   `{{TRACKER_COMMENT_ISSUE}}`feature/...\`)"` —
   visible in the issue timeline and in API responses (where the sidebar
   link doesn't appear), giving subsequent agents an unambiguous PR pointer
   without an extra lookup.

Both channels are mandatory: the first is the tracker's structural link; the
second is the audit-trail link the rest of the pipeline reads.

## No Exceptions

- **Do NOT merge a PR without the user's explicit approval.** This includes
  autonomous/overnight runs, ralph loops, and instructions like "run to the
  end" or "go all the way" — those mean drive the pipeline until the PR is
  merge-ready (CI green, audits clean, Copilot threads resolved), then STOP
  and report. merging is never an agent's call; merging `{{PROJECT_MAIN_BRANCH}}`
  auto-deploys to production. Approval to merge one PR does not carry over
  to any other PR.
- Do NOT start coding without an approved spec.
- Do NOT write a spec without a tracked {{VOCAB_ISSUE}}.
- Quick bug fixes still need an issue (can be brief) and a lightweight spec
  (can be a single sub-phase).
- If the user asks to "just do it" without a spec, remind them of this
  workflow and offer to create the issue + spec quickly.
- Always update the project board status when transitioning between
  workflow steps.
- Always acquire the `agent:*` working lock before spawning a sub-agent on
  an issue, and always release it (except `awaiting-input` / `error`) on
  every exit path.
