---
name: ralph
description: Run the Ralph loop — headless Claude driving /board drain or audit→fix→audit cycles. Usage: /ralph [drain|audit] [args]
user_invocable: true
argument-hint: "[drain | audit --issue N --pr M --passes K] [--dry-run] [--no-worktree]"
---

<!-- host-specific: the tracker/host commands shown below are worked examples from
     one setup. Your configured equivalents live in the profile you installed with (profiles/<name>.env)
     (TRACKER_* / VCS_* tokens) — the CONTRACT each step implements is what
     ports; the exact invocation is not. -->


# Ralph Loop Runner

Ralph runs headless Claude in a loop against either the project board (drain mode) or a single issue/PR (audit mode). The driver script is `scripts/ralph.sh` — this skill documents common invocations and chooses safe defaults.

The script uses `--dangerously-skip-permissions`. Always confirm the target branch before starting a long run; the wrong branch is the #1 failure mode (see "Footguns" below).

## When to use

- **Drain the board unattended** (drain mode) — walks the project board, picks the furthest-progressed `Ready for *` issue not currently held by an agent, runs one `/board` step via a fresh Claude process, sleeps, repeats.
- **Audit and fix a specific PR / feature branch twice** (audit mode) — runs `audit → fix → audit` (matches the "two-audit minimum before PR" rule). Worktree-isolated by default so commits land on the right branch regardless of what the invoking shell has checked out.

Do NOT use Ralph for a single one-shot task — just invoke `/board N <step>` directly. Ralph is for multi-iteration runs.

## Invocation patterns

If the user says "run ralph" / "start ralph" / similar and provides context, map to the right command using the table below. If context is ambiguous, ask before spawning — this is a long-running, cost-bearing operation.

| User intent | Command |
|-------------|---------|
| Drain the project board forever | `scripts/ralph.sh` |
| Drain the board, stop after N iterations | `scripts/ralph.sh --max N` |
| Run one iteration and exit (smoke test) | `scripts/ralph.sh --once` |
| Preview what drain mode would pick, no Claude calls | `scripts/ralph.sh --dry-run --once` |
| Audit PR #M twice (audit→fix→audit) | `scripts/ralph.sh --issue N --audit-passes 2 --pr M` |
| Same but on an explicit branch | `scripts/ralph.sh --issue N --audit-passes 2 --branch feature/foo` |
| Three audit passes (extra paranoid) | `scripts/ralph.sh --issue N --audit-passes 3 --pr M` |
| Audit in cwd (no worktree — legacy) | `scripts/ralph.sh --issue N --audit-passes 2 --no-worktree` |
| Audit dry-run (show prompts only) | `scripts/ralph.sh --dry-run --issue N --audit-passes 2 --pr M` |

### Stopping a run

- Graceful: `touch .ralph-stop` — Ralph exits after the current iteration completes.
- Hard stop: Ctrl-C on the terminal. Safe between iterations; mid-iteration can leave Claude orphaned but won't corrupt state (lock file auto-cleaned on EXIT trap).

### Monitoring progress

Ralph writes to `./ralph.log` (configurable via `--log`). The log is `*.log` so it's already gitignored.

- Driver lines only (no Claude stream JSON): `grep -E '^\[20[0-9-]+T[0-9:]+Z\] ' ralph.log | tail -f`
- Tool descriptions (what Claude is doing inside each iteration): `tail -c 50000 ralph.log | grep -oE '"description":"[^"]{10,120}"' | tail -20`
- Audit findings produced by the run, both files per pass:
  - `.ai/audit-findings/issue-ID-pass-K.md` — architectural auditor (Sonnet)
  - `.ai/audit-findings/issue-ID-pass-K-line.md` — line-reviewer (Opus, {{VOCAB_REVIEWER}}-style)
  - Both persist across worktree cleanup.

## How audit mode works under the hood

Each audit pass runs **two reviewers in series** — the architectural auditor and the line-reviewer — and the pass is only considered clean when **both** report no findings. This is the structural fix for the "{{VOCAB_REVIEWER}} finds nits Ralph misses" gap: the auditor (Sonnet, broad context, 5 dimensions) catches spec/architecture issues; the line-reviewer (Opus, diff-anchored, deliberately noisy) catches line-level nits. Together they cover what {{VOCAB_REVIEWER}} would flag in a typical PR review.

1. Resolve target branch from `--branch X` or `--pr M` (the latter via `{{VCS_VIEW_PR}}`). One or the other is **required** unless `--no-worktree` is passed.
2. `git fetch origin <branch>`, then `git worktree add .claude/worktrees/ralph-<issue>-<pid> <branch>`. Fails fast if the branch is already checked out in another worktree.
3. `cd` into the worktree. Run N audit passes interleaved with (N-1) fix passes.
4. **Each audit pass = auditor run, then line-reviewer run.** Findings go to two files per pass:
   - `.ai/audit-findings/issue-<id>-pass-<k>.md` — auditor (Sonnet)
   - `.ai/audit-findings/issue-<id>-pass-<k>-line.md` — line-reviewer (Opus; invoked via `--model opus`)
   - Both written to the **main repo's** `.ai/audit-findings/` (absolute path) so they survive worktree cleanup.
   - The line-reviewer is told to read the auditor's file first and skip duplicates, so the union of findings has minimal redundancy.
5. Fix pass prompt instructs Claude to read **both** findings files for the prior pass, dedup overlapping findings, fix every item from both, commit incrementally, typecheck after each commit, and push to `origin/<branch>` after every commit (worktree is ephemeral). Explicitly forbids opening a PR or changing board status.
6. Short-circuit: a pass is "clean" iff **both** findings files contain exactly `No findings.`. When that happens the loop exits early; if only one of the two is clean, the loop continues to the next fix pass.
7. Worktree is **kept** after the run so the commits + state can be inspected. Remove manually with `git worktree remove <path>` when done.

## Convergence is the terminal condition — NOT the pass count

**`--audit-passes N` is a FLOOR, not a ceiling. The run is only "done" when a full audit pass (both reviewers) comes back with zero findings AFTER the most recent fix.** A fix is never the last step; a clean audit is.

This matters because the loop runs N audit passes interleaved with (N−1) fix passes — so a fixed `--audit-passes 2` (audit → fix → audit) can *terminate on an audit that still found issues*, with no fix pass after it and no confirming clean pass. That is **not** converged, even though the command "finished."

The operator's obligation after any Ralph audit run:

1. Read the **last** pass's two findings files (`issue-<id>-pass-<K>.md` and `-pass-<K>-line.md`).
2. If either is not exactly `No findings.`, the run did **not** converge. Fix the remaining items and **re-run Ralph** (or run additional `fix → audit` cycles manually) until a pass comes back clean on both. Do not open/advance the PR on a non-converged run.
3. Only report "audit clean" when you can point at a specific pass that returned `No findings.` on both reviewers. "I ran 2 passes" or "findings were decreasing" or "I verified the last fix myself" is **not** convergence — only a clean confirming pass is.

None of these substitute for a clean pass: a high pass count, findings trending down across passes, non-trivial-looking fixes, or your own manual verification of a fix. The loop closes on a reviewer pass that finds nothing, and nothing else.

**When you drive the loop by hand** (spawning the `auditor` + `line-reviewer` agents directly instead of `scripts/ralph.sh`, per `{{PATHS_RULES_DIR}}/workflow.md`), the same rule is unconditional: after fixing a pass's findings, spawn one more pass, and keep going until a pass returns zero findings. If the last thing you did was *fix something* rather than *run an audit that came back clean*, you are not done — run another pass. Budget for that final confirming pass up front; it is the most commonly skipped step.

For an unattended run, prefer a higher `--audit-passes` (3+) to reduce the chance of terminating mid-findings, and always verify the last pass is clean before trusting the result. If you need a hard guarantee of convergence, re-invoke Ralph until a whole run short-circuits clean on its *first* pass — that is the unambiguous signal that the branch has nothing left to fix.

## How drain mode works under the hood

1. GraphQL query against `organization(login:Digital-Synchrony).projectV2(number:1)` returns all items with status + labels.
2. Filter: OPEN issues in a `Ready for *` status without any `agent:*` label (agent labels mean the CI workflow is already processing the issue).
3. Walk statuses in drain order — `Ready for Context` → `Ready for Refinement` — take the first match. This finishes near-done work before starting new.
4. Invoke `claude -p "/board N"` — the `/board` skill handles the worktree for its sub-agents.
5. Sleep, loop. Stuck-issue detector: same issue picked 3× consecutively → long backoff to avoid burning budget on a wedged ticket.

## Footguns (all learned the hard way)

1. **Wrong branch commits** — the *original* audit mode (before worktree support) ran in the user's cwd, so a Ralph invocation while checked out on `feature/520` committed fixes for issue #505 onto the #520 branch. Worktree mode (now default) makes this impossible: if you pass `--pr 508` it checks out `feature/505-admin-groups-listviews` into a fresh worktree regardless of cwd. **Always prefer `--pr N` over `--branch X` if the user mentions a PR** — it's self-documenting and resolves typos automatically.
2. **Issue number vs branch mismatch** — running `--issue 505 --pr 508` where PR #508's commits are tagged with a different issue number is fine; the audit prompt is issue-driven but the branch is what gets committed to. The auditor agent will note the mismatch in its findings header. Harmless but worth flagging if the user seems surprised.
3. **PR number not found / not authorized** — `gh pr view` fails silently returning empty. Ralph's resolver reports "PR #N has no headRefName". Usually means the user typoed the number or the PR is in a different repo.
4. **Parallel Ralph instances** — one lock file per UID: `/tmp/ralph-$(id -u).lock`. A second `scripts/ralph.sh` on the same user account refuses to start if the first is alive.
5. **Worktree cleanup** — Ralph never auto-removes worktrees. They accumulate under `.claude/worktrees/`. Occasional `git worktree prune` + `git worktree list` + manual `remove` keeps the dir tidy.
6. **Running Ralph from inside a worktree** — drain mode still works (`/board` worktrees correctly) but emits a warning. Audit mode with the worktree flag works too but you end up with nested worktrees, which gets confusing. Prefer running from the main repo checkout.

## Recommending Ralph to the user

When the user mentions reviewing/auditing a PR, writing multiple audit rounds, or draining the backlog unattended, offer Ralph. Don't offer it for single-step tasks; `/board N <step>` is lighter.

For a PR audit, the canonical recommendation is:

```bash
# replace N (issue) and M (PR) — Ralph creates a clean worktree on PR M's head ref
scripts/ralph.sh --issue N --audit-passes 2 --pr M
```

`--audit-passes 2` is the **minimum floor**, not the finish line. After it runs,
check the last pass's findings files — if they are not clean, re-run (bump to 3+
or repeat) until a pass returns `No findings.` on both reviewers. See
"Convergence is the terminal condition" above: the run is done when an audit
comes back clean, never when a fix was the last action.

Expected duration: ~50–80 min per full 2-pass run (audit ~13 min + line-review ~10 min + fix ~17 min + audit ~15 min + line-review ~10 min). Line-review adds ~10 min per pass and uses Opus, which is more expensive per token than Sonnet — budget accordingly. If the first audit pass finds zero issues across BOTH reviewers the run short-circuits in ~23 min.
