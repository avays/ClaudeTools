---
name: cleanup
description: Post-merge cleanup — pull main, delete merged feature branches, remove stranded ralph worktrees, kill leftover dev processes, close the issue. Run after the user says "merged" or "cleanup please".
---

<!-- host-specific: the tracker/host commands shown below are worked examples from
     one setup. Your configured equivalents live in claudetools.config.json
     (TRACKER_* / VCS_* tokens) — the CONTRACT each step implements is what
     ports; the exact invocation is not. -->


# Cleanup

Run after a PR has been merged. Returns the repo + dev environment to a clean state and closes the related {{VOCAB_ISSUE}}.

## When to run

The user has explicitly told you a PR was merged (e.g. "merged", "ok merged", "merged, cleanup") or asked for cleanup. Do NOT run this proactively — only when asked.

## Steps

Run the steps in order. If a step has nothing to do, skip it silently — don't add ceremony for no-op cases.

### 1. Git state

```bash
git checkout main
git pull --ff-only
```

Then delete the just-merged local feature branch. The name was almost certainly `feature/<issue>-<short>` from the work just merged:

```bash
git branch -d feature/<issue>-<short>
```

If the user didn't say which branch, look at the most-recent merge commit on origin/main to identify it:

```bash
git log origin/main --oneline -5
```

The squash commit's message starts with `feat(#N):` / `fix(#N):` — that's the issue number.

`git branch -d` warns if HEAD doesn't include the squash (which is normal — squash merges don't fast-forward to `main`'s HEAD). The branch is fully merged on origin, so the warning is expected; proceed.

### 2. Worktrees

Remove any leftover ralph worktrees from the merged work:

```bash
git worktree list                                  # see what's still around
git worktree remove .claude/worktrees/ralph-<N>-<pid>   # for each ralph worktree tied to this issue
```

If `git worktree remove` complains about modified files (ralph leaves uncommitted state when an iteration was killed mid-run), use `--force`:

```bash
git worktree remove --force .claude/worktrees/ralph-<N>-<pid>
```

Don't touch worktrees you didn't create. `freshTree`, `admin_refactor`, and any path that isn't `ralph-<issue>-<pid>` belongs to the user — leave it alone.

### 3. Background processes

Kill anything spawned for the merged work — typically a backend dev server, BullMQ worker, or polling shells.

```bash
ps -ef | grep -E "tsx watch|worker.ts|backend dev|playwright|ralph" | grep -v grep
```

For each PID that this session started (check `etime` to spot processes from BEFORE the session began — those belong to the user), `kill <pid>`. Process trees sometimes need killing root-first (`pnpm dev` → `sh -c` → `tsx` → `node`); if the child survives, kill it directly.

The frontend dev server, the user's interactive `claude` process, and anything started before this session are NOT yours to kill.

### 4. Issue + board

Close the {{VOCAB_ISSUE}} that the merged PR resolved:

```bash
gh issue close <N> --repo {{VCS_REPO_SLUG}} --comment "Done in PR #<P> (squash \`<sha>\`)."
```

The squash SHA is the first commit on `origin/main` after the pull, returned by `git log origin/main --oneline -1`.

### 5. Report back

Summarize what was cleaned and offer the next ticket. Format:

```
Cleanup done:
- On `main` at `<sha>` (PR #<P> squashed)
- Local feature branch deleted
- (Worktree removed | No worktrees to clean)
- (N processes killed | No lingering processes)
- #<N> closed

Open tickets: <2-3 line summary of what's open, recommend a next pick>
```

Keep it tight. The user wants confirmation + a launching pad, not a status dump.

## What NOT to do

- **Don't run `git push` or `git push --delete origin <branch>`.** Most hosts delete the remote branch on squash merge; trying to delete an already-deleted ref errors out. The local delete is sufficient.
- **Don't run `{{PKG_INSTALL}}`, `{{PKG_SYNC_AGENTS}}`, or context refresh.** Those belong to the implementation phase, not cleanup. The merged PR already ran them.
- **Don't open a new branch or start the next ticket.** Cleanup ends with a recommendation; the user picks what's next.
- **Don't kill processes you didn't start.** A process older than the current session belongs to the user.
- **Don't `rm -rf` anything outside `.claude/worktrees/`.** Worktree removal is a `git worktree remove` operation, not a filesystem delete.

## Edge cases

- **Local branch already gone**: skip the `git branch -d` step silently.
- **No worktrees match the issue number**: skip step 2. `git worktree list` is the source of truth — only act on entries you recognize.
- **Issue is already closed**: `gh issue close` errors out with "issue already closed". Treat as success.
- **Multiple PRs merged in sequence**: ask the user which to clean (or do all of them if they explicitly say "cleanup everything"). Don't guess.
- **User didn't give the PR number**: derive it from `gh pr list --state merged --limit 5` and the issue body / branch name. If still ambiguous, ask.

## Precedents

This skill was extracted after running the same sequence manually across PRs #647, #657, #661, #667, #671, #676, #687 — same five steps every time. Codifying it avoids forgetting any of them.
