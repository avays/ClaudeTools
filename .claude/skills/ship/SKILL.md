---
name: ship
description: Drive a GitHub issue end-to-end to a merge-ready PR as one deterministic multi-agent Workflow — spec → spec-audit loop → implement+tests → ralph code-audit loop → context update → PR → Copilot-feedback loop → learn retrospective. Usage: /ship <issue_number>
user_invocable: true
argument-hint: "<issue_number> [no-pr] [dry-run]"
---

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
- `no-pr` → `args.pr = false` (skip PR creation + Copilot loop + Learn retrospective — no PR to harvest or comment on; context update still runs)
- `dry-run` → `args.dryRun = true` (validate the script; spawns no agents)
- Optional overrides: `args.maxAuditRounds` (default 5),
  `args.maxCopilotRounds` (default 10), `args.copilotWaitSeconds` (default 600)

When the workflow completes, report: branch, spec path, audit-loop
convergence, PR URL, the Copilot-loop outcome (converged, or the
outstanding threads if it hit the round cap), and the Learn summary
(which rules/skills were updated, or that no lessons were encoded).

## What the workflow does

1. **Setup** — fetch issue, acquire the `agent:in-progress` label lock
   (aborts if another agent holds it), create the feature branch.
2. **Spec** — spec-writer drafts `.ai/specs/<slug>.md` per `/create-spec`.
3. **Spec audit loop** — tiered: a sonnet grind auditor clears the obvious
   layer, then an Opus confirming gate certifies → revise → re-audit until a
   clean Opus pass (a sonnet-clean only escalates; the strongest reviewer
   certifies clean).
4. **Implement** — developer builds the feature + the spec's tests, keeps
   typecheck/tests green.
5. **Ralph code-audit loop** — tiered: a single combined sonnet reviewer
   grinds, then a two-lens Opus gate (auditor + line-reviewer in parallel)
   certifies; fix → re-audit until a clean Opus gate. Once the gate reopens
   findings it stays on Opus. Non-convergence stops the run BEFORE the PR (the
   loop ends on a clean audit, never on a fix).
6. **Context** — `/update-context` + `/update-progress` conventions.
7. **PR** — pr-creator opens the PR (`Closes #N` + issue comment).
8. **Copilot loop** — after every push the repo ruleset re-runs Copilot
   review; the workflow waits ~10 min, checks for unresolved threads, and
   runs the `/resolve-copilot-feedback` procedure (fix or push back, one
   commit, resolve every thread, summary comment) — repeating until a wait
   finds zero new threads (cap: 10 rounds).
9. **Learn (terminal)** — once the review cycle ends, the `/learn`
   retrospective harvests every finding from the cycle, encodes the
   recurrence-class lessons into `.claude/rules/` / skills / agent
   definitions, commits on the feature branch and **pushes so the PR is
   updated with the lesson changes**, and posts a "📚 Learn:" PR comment
   mapping each lesson to its destination file.

The lock is released on every exit path. The terminal state is always
"PR ready for review" — merging is never the workflow's call.

## Notes

- Single-flight: runs sequentially in the current working tree. For
  parallel issue processing across terminals, use `/board` (worktree-
  isolated step mode) instead.
- GitHub-native (issue fetch + board + Copilot via `gh`). Adapting to Jira
  would swap only the Setup agent's fetch step, given a Jira connection.
