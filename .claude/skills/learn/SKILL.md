---
name: learn
description: Post-review retrospective — harvest every finding from a PR's review cycle (Copilot rounds, ralph audit passes, human threads), distill the recurrence-class lessons, and encode them into the repo's rules/skills/agents so the same mistakes stop happening. Runs automatically as the ship workflow's terminal phase; also runnable manually after any review cycle. Usage: /learn <PR number> [issue number]
user_invocable: true
argument-hint: "<pr_number> [issue_number]"
---

# Learn — encode review lessons so they don't recur

Every review round on this repo is expensive: a Copilot round costs a
wait+fix+resolve cycle; a ralph audit pass costs a full reviewer run. Most
findings are *instances of a class* — and the repo already has the machinery
to kill a class permanently: path-scoped rules in `.claude/rules/`, skill
checklists (create-spec pre-flight, resolve-copilot-feedback sweep), and
agent definitions. This skill is the feedback edge that actually writes the
lesson down where the next agent will see it.

Precedent for the whole idea: `resolve-copilot-feedback` step 3 exists
because PR #707 cycled through 8 Copilot rounds; each check in that sweep is
one encoded lesson. `/learn` generalizes that: after every review cycle,
harvest → distill → encode.

## When to run

- **Automatically**: the `ship` workflow runs it as the terminal phase, after
  the Copilot feedback loop ends.
- **Manually**: after finishing a `/resolve-copilot-feedback` cycle or a
  ralph audit convergence, run `/learn <PR>`.

## Process

### 1. Harvest — collect every finding from the cycle

```bash
# All review threads (Copilot + human), including resolved ones:
gh api repos/Digital-Synchrony/ORM/pulls/<PR>/comments --paginate \
  --jq '.[] | {path, body: (.body | .[:600])}'

# The resolution summary comments we posted (map finding → fix / push-back):
gh pr view <PR> --repo Digital-Synchrony/ORM --json comments \
  --jq '.comments[] | select(.body | startswith("Resolved")) | .body'

# Audit-loop fix commits on the branch (each message enumerates findings):
git log origin/main..<branch> --oneline --grep "audit" --grep "Copilot" --grep "findings" -i
# For merged PRs, use the squash commit body: git show <sha> --no-patch --format=%B
```

Also read: the PR body's convergence note, the spec's deferred/push-back
sections, and — when invoked from a live session — the session's own audit
reports if the caller pasted them into the prompt.

### 2. Distill — keep only recurrence-class lessons

For each finding ask: **"Would a rule, checklist line, or grep have
prevented this — and will the situation plausibly recur?"**

- **Encode**: pattern mistakes (wrong API shape, missed companion edit,
  convention violation, a category Copilot caught that our pre-emptive sweep
  lacks, a workflow-ordering error like lock-before-status).
- **Skip**: true one-offs (a typo, a merge race, a finding specific to one
  file's quirk). Encoding one-offs bloats the rules and dilutes the real
  ones — rule files are loaded into every matching session's context, so
  every line must earn its tokens.
- **Cap at ~5 lessons per run**, highest-recurrence-risk first. If a cycle
  produced more, encode the top 5 and list the rest in the report as
  not-encoded (with one-line reasons).

### 3. Dedup — check whether the lesson is already written down

```bash
grep -rn -i "<topic keywords>" .claude/rules/ .claude/skills/ .claude/agents/
```

Three outcomes:
- **Not present** → encode it (step 4).
- **Present but was missed anyway** → the lesson is about *placement or
  strength*, not existence: sharpen the wording, add a greppable proxy, add
  the new precedent PR#, or move/copy the rule to the checklist that the
  responsible agent actually loads (e.g. from a prose paragraph into the
  create-spec pre-flight numbered list). Never duplicate a rule verbatim
  into a second home without a pointer — twins drift.
- **Present and followed, finding was a false positive we pushed back on** →
  if Copilot keeps raising it, add the push-back rationale to the relevant
  rule so future sessions can cite it instead of re-litigating (precedent:
  the "nullable JSONB union" note in backend-database.md exists exactly
  because two reviewers ping-ponged over it).

### 4. Encode — route each lesson to its ONE right home

| Lesson class | Destination |
|---|---|
| Code pattern (backend/frontend/schema/test) | The matching `.claude/rules/<area>.md` — follow house style: the rule, the WHY, a greppable proxy, `Precedent: PR #<P> round <R>` |
| A category Copilot caught that our sweep lacks | `resolve-copilot-feedback/SKILL.md` step 3 — add a numbered check WITH a grep command |
| Spec-stage miss (missing companion file, wrong count, unregistered chain) | `create-spec/SKILL.md` pre-flight checklist (and `workflow.md` "Completeness traps" if it's an incomplete-chain class) |
| Agent behavior miss (wrong tool, skipped step, bad ordering) | The `.claude/agents/<agent>.md` definition |
| Workflow/pipeline ordering (locks, board, CI) | `.claude/rules/workflow.md` or the ship workflow's prompts in `.claude/workflows/ship.js` |
| Genuinely new area with no existing home | New `.claude/rules/<name>.md` **plus** a `file-patterns.json` entry (a rule file without a pattern entry is never loaded — and the `agent-instructions-sync` CI job fails on orphans) |

Style contract for encoded lessons (matches every existing rule):
- State the rule imperatively, then the failure it prevents.
- Give a greppable proxy when one exists — checks that can be run beat prose.
- Cite the precedent (`PR #1128 round 2`) so future readers can see the
  original context.
- Never weaken or delete an existing rule as part of a learn pass.

### 5. Sync + commit

```bash
pnpm sync-agents          # regenerate AGENTS.md / .github / .agents / .codex
git add -A
git commit -m "learn(#<issue>): encode review lessons from PR #<P>

- <lesson 1> → <file>
- <lesson 2> → <file>"
git push
```

Commit to the **current branch**: when run as ship's terminal phase the PR is
still open, so the lessons ride along and merge with the feature. A rules
edit may trigger one more Copilot round — that's fine; docs-only commits
rarely draw comments, and if one does, `/resolve-copilot-feedback` handles it
(the ship workflow re-enters its Copilot loop automatically after a Learn push).

### 6. Post the PR comment

If a PR is open for the harvested cycle (always true when run as ship's
terminal phase), post a comment titled **"📚 Learn:"** listing each lesson →
destination file — or stating that zero lessons survived distillation (in
which case nothing was committed):

```bash
gh pr comment <PR> --repo Digital-Synchrony/ORM --body "📚 Learn: encoded <N> lesson(s) from this review cycle

- <lesson 1> → <file>
- <lesson 2> → <file>"
```

This comment is part of the skill's contract — `ship`'s Learn phase and
`ship/SKILL.md` both describe it, so manual `/learn` runs must post it too.

### 7. Report

End with a table: `finding → lesson → destination file` (or "not encoded —
one-off"), plus the count of findings harvested vs lessons encoded. If zero
findings survived distillation, say so plainly and change nothing — a clean
cycle is a valid outcome, and empty learn commits are noise.

## Hard rules

1. **Every encoded lesson needs a destination that gets loaded.** A rule
   file without a `file-patterns.json` entry, or a note in a file no agent
   reads, is a lesson lost.
2. **Sharpen, don't duplicate.** If the rule existed and was missed, fix
   placement/strength — a second copy drifts.
3. **No rule bloat.** One-offs are skipped, runs are capped, and every line
   added must plausibly change a future session's behavior.
4. **Never weaken existing rules.** Learn adds guardrails; loosening one
   requires its own deliberate change with the user.
5. **Always `pnpm sync-agents` before committing** — a stale generated file
   fails CI (`agent-instructions-sync`).
