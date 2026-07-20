---
globs: []
---

# Workflow Rules

## Mandatory Workflow Order

Every piece of implementation work MUST follow this sequence:

1. **Issue first** — Create a GitHub issue (Digital-Synchrony/ORM) describing the feature, bug, or change before any spec or code work begins. The issue is the ticket of record. It is auto-added to the [ORM Build project board](https://github.com/orgs/Digital-Synchrony/projects/1).

2. **Spec second** — Run `/create-spec` to produce a detailed implementation spec in `.ai/specs/` before writing any code. The spec must reference the GitHub issue number. Get user approval on the spec before proceeding.

3. **Implement third** — Only after the issue exists AND the spec is approved, begin writing code.

4. **Self-audit fourth — BEFORE opening the PR or declaring the work done.**
   This step is mandatory and proactive: do it without being asked. Typecheck
   and tests passing is necessary but NOT sufficient — they don't catch
   incomplete-chain edits, missed call sites, or RBAC/correctness gaps.

## Self-audit before declaring done (mandatory)

After an implementation compiles and its tests pass, and **before** you open a
PR, push the "final" commit, or tell the user the work is complete, run the
adversarial review loop on the diff. Do not wait for the user to ask "did you
audit this?" — if they have to ask, the step was skipped and time was wasted
(this rule exists because that happened: an implementation was declared done +
a PR opened, and a later audit found a HIGH-severity incomplete-chain bug that
should have been caught first).

The loop:

1. **Spawn both reviewers in parallel** on `git diff origin/<base>...HEAD`:
   - the **`auditor`** agent (architectural / spec-conformance / completeness), and
   - the **`line-reviewer`** agent (line-by-line, including LOW nits).
   They are independent perspectives — run both, not one. (The `/audit-phase`
   skill is the spec-driven equivalent for phase work; the two agents are the
   diff-driven equivalent for any change.)
2. **Triage every finding.** Fix the real ones; for anything you reject, write
   one line on why. Re-run typecheck + the affected tests after fixing.
   **Comment hygiene applies to the fix itself, not just the original
   code**: when the fix explains *why* in a source comment (e.g. "hoisted
   alongside X because Y"), don't narrate it with workflow metadata —
   `audit round 1 LOW #NNN`, `fix pass 2`, `line-review #1`. Same rule as
   `.claude/agents/developer.md` "Comment hygiene (#843)"; it's called out
   here too because the violation this note exists for was introduced
   inside an audit-fix commit's own explanatory comment, not the original
   implementation (PR #1157 round 1 → self-corrected round 2).
3. **Loop until a CONFIRMING CLEAN PASS — no exceptions.** After you fix (or
   reject-with-reason) a pass's findings, you MUST spawn a fresh audit pass over
   the new diff. Keep going — fix, re-audit, fix, re-audit — until a full pass
   (both reviewers) comes back with **zero** unaddressed findings. **A fix is
   never the terminal step of the loop; a clean audit is.** The loop ends on an
   audit, not on an edit.

   This is unconditional. It does NOT depend on the fixes being "non-trivial,"
   on findings "decreasing" across passes, on a pass count you picked up front,
   or on you having verified the fix yourself. None of those are convergence.
   The ONLY thing that closes the loop is a fresh reviewer pass that finds
   nothing. If you are about to declare done and the last thing you did was
   *fix something* rather than *run an audit that came back clean*, you are not
   done — run one more pass.

   Watch for the two ways this silently under-runs: (a) a fixed `--audit-passes N`
   (or N manual passes) that happens to end on an audit that FOUND issues — that
   is not converged, add another fix+audit cycle; (b) the final pass surfaces a
   new finding you fix quietly and ship without re-auditing — that reopens the
   loop, it does not close it.
4. Only after a confirming clean pass: open/update the PR and report completion.
   When you report, state that the loop converged on a clean pass (e.g. "pass K
   returned no findings"), not merely that you "ran K passes."

This applies whether or not the user said the words "audit" or "ralph" — it is
the default close-out for every implementation. The user asking for it after
the fact means it was already overdue. Stopping after a fix — before a clean
confirming pass — is the single most common way this rule gets under-run;
budget for the extra pass up front.

Once the loop converges (and after any subsequent Copilot review cycle on
the PR ends), run `/learn <PR>` to encode the cycle's recurrence-class
lessons into the repo's rules/skills — see `.claude/skills/learn/SKILL.md`.
The ship workflow does this automatically as its terminal phase; manual
pipelines should do it explicitly.

### Completeness traps the self-audit is there to catch

The most common class the typecheck/test pass misses is the **incomplete
chain**: an edit that adds a case to one dispatcher but not its siblings.
Before declaring done, when you add a new variant to ANY enumerated set, grep
for every sibling site and confirm you hit them all. Known multi-site chains:

- **Metadata bundle entity type** (adding `agents`/`customPages`-style types):
  `MetadataBundleSchema` (deployment.ts) → `PackageManifestSchema.contents`
  (marketplace.ts) → `exportMetadata` (metadata-serializer.ts) → `diffMetadata`
  (metadata-differ.ts) → `deployMetadata` add/update **and the removal switch**
  (metadata-deployer.ts) → `prefixBundleApiNames` + `scopeChangesetToNamespace`
  **and `countChangesetByType`/`InstallPreviewChangesSchema`** (marketplace.ts +
  shared). The preview-count pair is the easy miss — it has no compile error,
  so the install-preview silently under-counts the new type. (Precedent: #823.)
- **New `PlatformError` code** → `ERROR_CODES` registry + (if FE-facing)
  `useApiErrorToast` map (see shared-types.md).
- **New permission** → `PERMISSIONS` registry + call sites (see backend-api.md).
- **New registry primitive** → definitions array + count test + list/describe
  endpoints (see registry.md).

## Board Pipeline Automation

Use `/board <issue_number> [step]` to run the pipeline. All steps run in **isolated git worktrees by default** — this enables parallel issue processing across multiple terminals.

```bash
# Run next step for issue 30 (in worktree — default)
/board 30

# Run all remaining steps for issue 30 (each in its own worktree)
/board 30 all

# Run specific step
/board 30 code

# Disable worktree (run in current directory — not recommended for parallel work)
/board 30 code no-worktree
```

### Worktree Rules for Agents

- **Code-modifying agents** (spec-writer, developer, context-updater) MUST push to remote after every commit — worktrees are temporary and local-only changes are lost on cleanup
- **Read-only agents** (refinement, test-runner, auditor, pr-creator) don't need to push — worktree cleanup is safe
- Each worktree gets its own isolated checkout of the feature branch
- Multiple issues can run in parallel without branch conflicts

## Project Board Status Tracking

Every issue tracks its progress on the **ORM Build** project board. Update the status at each workflow transition:

| Workflow Step | Board Status | Who/When |
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

See `.ai/context/PROJECT_BOARD.md` for option IDs and GraphQL CLI commands.

## Agent Locking — `agent:*` labels are mutexes

When an agent (local or GitHub-Actions-hosted) starts work on an issue, it
MUST set an `agent:*` label as a working lock. Other agents — including
parallel Ralph workers and concurrent `/board` invocations from a second
terminal — treat any `agent:*` label as "this issue is taken, skip it." The
canonical pickers (`scripts/ralph.sh:pick_next_issue` and board-runner's
auto-detect mode) filter out every issue carrying any `agent:*` label.

### The lock vocabulary

| Label | Set by | Meaning |
|-------|--------|---------|
| `agent:in-progress` | `ralph.sh` (drain mode) / external orchestrators | Outer-fence lock acquired BEFORE invoking `/board`. Coexists with the per-step label and is transparent to board-runner. |
| `agent:refining` / `agent:speccing` / `agent:implementing` / `agent:testing` / `agent:updating-context` / `agent:creating-pr` | board-runner (local) AND GitHub Actions workflow handlers | Per-step working lock — set on entry to the step, removed on exit |
| `agent:awaiting-input` | Any sub-agent that posts a question | Human input needed — agents must NOT proceed |
| `agent:error` | GitHub Actions failure handler | Processing failed — needs human review |

`agent:in-progress` and a per-step label may coexist (Ralph holds the
outer fence; board-runner holds the inner per-step lock). Each owner
removes its own label; neither stomps the other's.

`agent:in-progress` is the generic lock; the per-step labels are more
specific and are preferred when the step is known up-front (board-runner
knows it; Ralph drain mode doesn't until the sub-agent fires).

### Lock contract (every orchestrator follows it)

1. **Acquire BEFORE moving the board status into an actionable state.**
   `pick_next_issue` filters on `(actionable_status AND no agent:*
   label)`. If the status moves into `Ready for *` before the label is
   set, a concurrent picker can grab the issue in the gap. The label
   add (`gh issue edit N ... --add-label "agent:<label>"`) runs first;
   the status move and the Agent / `claude -p` call run after. Which
   label depends on the orchestrator — Ralph drain uses
   `agent:in-progress` as the outer fence (the step isn't known until
   board-runner inspects the issue), while board-runner uses the
   matching per-step label (`agent:speccing`, `agent:implementing`,
   …) once the step is determined.
2. **On the success path, advance the board status BEFORE releasing the
   lock.** Same race in reverse: removing the label while the status is
   still actionable lets a concurrent picker grab the issue. Advance to
   the post-step gate (non-actionable, e.g. `Spec Created`) first; the
   status protects the issue while the label comes off.
3. **Release on every exit path.** Success, failure, AND timeout. Use a
   shell trap, `try/finally`, or equivalent so an aborted run doesn't
   strand the lock. `gh issue edit N ... --remove-label
   "agent:in-progress"` (or the per-step label) is the release. On
   failure, release WITHOUT advancing status — the work didn't complete.
4. **Never release `agent:awaiting-input` or `agent:error`.** Those are
   human-gated. Removing them is the human's job (or a follow-up agent
   that posts the answer).
5. **Each orchestrator manages only its own label.** `agent:in-progress`
   is owned by Ralph drain / external orchestrators; the per-step
   labels (`agent:speccing` etc.) are owned by board-runner / the GHA
   workflow handlers. Neither stomps the other's label.

### Stale lock recovery

If a Ralph or board-runner process crashes mid-step, the lock is left
behind and the issue becomes unpickable. Recovery is manual and explicit:

```bash
# 1. Confirm no agent is actually working (check ralph.log, ps, gh pr view)
gh issue view N --repo Digital-Synchrony/ORM --json labels --jq '.labels[].name'

# 2. If genuinely stranded, remove the lock
gh issue edit N --repo Digital-Synchrony/ORM --remove-label "agent:in-progress"
```

Do NOT auto-clear stale locks from the picker — silent stale-clear masks
the underlying crash. Surface it so the operator can decide.

## Issue ↔ PR linking

Every PR opened by the pr-creator agent MUST be linked to its issue
through both of these channels:

1. **`Closes #N` in the PR body** — GitHub auto-closes the issue on PR
   merge AND adds a "linked PRs" entry to the issue sidebar. This is the
   primary link.
2. **A comment on the issue announcing the PR** — `gh issue comment N
   --repo Digital-Synchrony/ORM --body "🤖 PR opened: #M — ready for
   review (\`feature/...\`)"`. This makes the link visible in the issue's
   comment timeline, surfaces it in API responses (where the sidebar
   doesn't appear), and gives any subsequent agent that reads the issue
   comments an unambiguous PR pointer without an extra `gh pr list` call.

Both channels are mandatory. The first is GitHub's structural link; the
second is the audit-trail link the rest of the pipeline reads.

## No Exceptions

- **Do NOT merge a PR without the user's explicit approval.** This includes
  autonomous/overnight runs, ralph loops, and instructions like "run to the
  end" or "go all the way" — those mean drive the pipeline until the PR is
  merge-ready (CI green, audits clean, Copilot threads resolved), then STOP
  and report. `gh pr merge` is never an agent's call; merging `main`
  auto-deploys to production. Approval to merge one PR does not carry over
  to any other PR.
- Do NOT start coding without an approved spec.
- Do NOT write a spec without a GitHub issue.
- Quick bug fixes still need an issue (can be brief) and a lightweight spec (can be a single sub-phase).
- If the user asks to "just do it" without a spec, remind them of this workflow and offer to create the issue + spec quickly.
- Always update the project board status when transitioning between workflow steps.
- Always acquire the `agent:*` working lock before spawning a sub-agent on an issue, and always release it (except for `awaiting-input` / `error`) on every exit path.
