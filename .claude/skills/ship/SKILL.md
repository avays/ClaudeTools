---
name: ship
description: Drive a {{VOCAB_ISSUE}} end-to-end to a merge-ready PR as one deterministic multi-agent Workflow — spec → spec-audit loop → implement+tests → ralph code-audit loop → context update → draft PR → Copilot-feedback loop → learn retrospective → ready + CI gate. Usage: /ship <issue_number>
user_invocable: true
argument-hint: "<issue_number> [no-pr] [dry-run]"
---

<!-- host-specific: the tracker/host commands shown below are worked examples from
     one setup. Your configured equivalents live in the profile you installed with (profiles/<name>.env)
     (TRACKER_* / VCS_* tokens) — the CONTRACT each step implements is what
     ports; the exact invocation is not. -->


# Ship — full-pipeline issue Workflow

Run the deterministic `ship` Workflow for issue **#$ARGUMENTS**.

This is the Workflow-tool counterpart of the classic `/board` step pipeline:
one run drives the whole thing with the repo's own agents (spec-writer,
auditor, line-reviewer, developer, context-updater, pr-creator).

## Instructions

Call the **Workflow** tool (the user invoking `/ship` is the explicit
multi-agent orchestration opt-in it requires — AND their standing approval
for the spec→code transition: the pipeline proceeds from audited spec to
implementation without the manual approval gate of the step-mode pipeline,
same as `/board <N> all`. Use `no-pr` + step mode if you want the gate):

```
Workflow({ name: "ship", args: { issue: <N> } })
```

If named resolution fails (registry snapshot from an older session), fall
back to `scriptPath: "<repo>/.claude/workflows/ship.js"`.

Argument mapping:
- `no-pr` → `args.pr = false` (skip PR creation + Copilot loop + Learn retrospective + CI gate — no PR to harvest, comment on, or gate; context update still runs)
- `dry-run` → `args.dryRun = true` (validate the script; spawns no agents)
- Optional overrides: `args.maxAuditRounds` (default 5),
  `args.maxCopilotRounds` (default 10), `args.copilotWaitSeconds` (default
  600), `args.maxCiRounds` (default 3)

When the workflow completes, report: branch, spec path, audit-loop
convergence, PR URL, the Copilot-loop outcome (converged, or the
outstanding threads if it hit the round cap), the CI-gate outcome (green,
or the failing checks if it hit the round cap), and the Learn summary
(which rules/skills were updated, or that no lessons were encoded).

## What the workflow does

1. **Setup** — fetch issue, acquire the `agent:in-progress` label lock
   (aborts if another agent holds it), then create a **dedicated git
   worktree** at `.claude/worktrees/ship-<issue>` (gitignored) with the
   feature branch checked out. Every subsequent phase runs inside that
   worktree — the user's main working tree is never touched, so it may be
   dirty and there is no "working tree clean" precondition. The worktree is
   removed on every exit path (the branch + all pushed commits persist on
   origin).
2. **Spec** — spec-writer drafts `{{PATHS_SPECS_DIR}}/<slug>.md` per `/create-spec`.
3. **Spec audit loop** — two grinds in sequence: a sonnet grind (audit →
   revise → re-audit) runs to its own convergence, then an Opus grind runs
   to convergence — a clean Opus pass is the sole exit (sonnet never
   certifies; a sonnet cap-out escalates instead of failing). The spec
   reviser runs on Opus. `maxAuditRounds` caps each grind stage
   separately.
4. **Implement** — developer builds the feature + the spec's tests, keeps
   typecheck/tests green.
5. **Ralph code-audit loop** — two grinds in sequence: a single combined
   sonnet reviewer grinds (fix → re-audit) to its own convergence, then a
   two-lens Opus grind (auditor + line-reviewer in parallel) runs to
   convergence — a clean Opus pass is the sole exit. Each stage has its own
   `maxAuditRounds` budget. Non-convergence stops the run BEFORE the PR
   (the loop ends on a clean audit, never on a fix).
6. **Context** — `/update-context` + `/update-progress` conventions.
7. **PR** — pr-creator opens the PR **as a draft** (`Closes #N` + issue
   comment). Draft PRs skip every `ci.yml`/`security.yml` job (#1231), so
   the review loop below costs zero CI runs; the agent also dispatches ONE
   `workflow_dispatch` CI + security smoke run against the branch for early
   env-only-failure signal.
8. **Copilot loop** — after every push the repo ruleset re-runs Copilot
   review (drafts included — `review_draft_pull_requests: true`); the
   workflow waits ~10 min, checks for unresolved threads, and runs the
   `/resolve-review-feedback` procedure (fix or push back, one commit,
   resolve every thread, summary comment) — repeating until a wait finds
   zero new threads (cap: 10 rounds). The fix agent runs on Opus.
9. **Learn** — once the review cycle ends, the `/learn` retrospective
   harvests every finding from the cycle, encodes the recurrence-class
   lessons into `{{PATHS_RULES_DIR}}/` / skills / agent definitions, commits on
   the feature branch (still draft — zero CI cost) and **pushes so the PR
   is updated with the lesson changes**, and posts a "📚 Learn:" PR comment
   mapping each lesson to its destination file.
10. **CI gate (terminal)** — marks the draft ready for review;
    `ready_for_review` fires the one full merge-ref CI + security run.
    Then a babysit loop (cap: `maxCiRounds`): watch checks to completion;
    on failure, an Opus developer diagnoses from the actual job logs —
    real defects get a fix commit (whose push auto-re-triggers BOTH CI and
    Copilot review, so the Copilot loop re-converges each round), pure
    infra flakes get `{{VCS_RERUN_FAILED_CHECKS}}` with no commit — until all
    checks are green.

The lock is released on every exit path. The terminal state is always
"PR ready for review" — merging is never the workflow's call.

## Notes

- Worktree-isolated: the whole run happens in a dedicated
  `.claude/worktrees/ship-<issue>` worktree, so the main working tree is
  free (keep editing while a ship runs) and **parallel ship runs across
  terminals are safe** — each issue gets its own worktree + branch. The
  same-issue `agent:in-progress` lock still serializes duplicate runs of one
  issue. Phases within a run are sequential and coordinate through that
  shared worktree + remote pushes. `/board` remains the per-step
  (worktree-isolated) alternative.
- GitHub-native (issue fetch + board + Copilot via `gh`). Adapting to Jira
  would swap only the Setup agent's fetch step, given a Jira connection.
