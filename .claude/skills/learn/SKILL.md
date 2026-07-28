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
to kill a class permanently: path-scoped rules in `{{PATHS_RULES_DIR}}/`, skill
checklists (create-spec pre-flight, resolve-review-feedback sweep), and
agent definitions. This skill is the feedback edge that actually writes the
lesson down where the next agent will see it.

Precedent for the whole idea: `resolve-review-feedback` step 3 exists
because PR #707 cycled through 8 Copilot rounds; each check in that sweep is
one encoded lesson. `/learn` generalizes that: after every review cycle,
harvest → distill → encode.

## When to run

- **Automatically**: the `ship` workflow runs it as the terminal phase, after
  the Copilot feedback loop ends.
- **Manually**: after finishing a `/resolve-review-feedback` cycle or a
  ralph audit convergence, run `/learn <PR>`.

## Process

### 1. Harvest — collect every finding from the cycle

```bash
# All review threads (Copilot + human), including resolved ones:
gh api repos/{{VCS_REPO_SLUG}}/pulls/<PR>/comments --paginate \
  --jq '.[] | {path, body: (.body | .[:600])}'

# The resolution summary comments we posted (map finding → fix / push-back):
gh pr view <PR> --repo {{VCS_REPO_SLUG}} --json comments \
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
grep -rn -i "<topic keywords>" {{PATHS_RULES_DIR}}/ {{PATHS_SKILLS_DIR}}/ {{PATHS_AGENTS_DIR}}/
```

Three outcomes:
- **Not present** → encode it (step 4).
- **Present but was missed anyway** → the lesson is about *placement or
  strength*, not existence: sharpen the wording, add a greppable proxy, add
  the new precedent PR#, or move/copy the rule to the checklist that the
  responsible agent actually loads (e.g. from a prose paragraph into the
  create-spec pre-flight numbered list) — and delete the superseded prose
  in the same edit: a sharpened rule replaces its predecessor, it does not
  append to it. Never duplicate a rule verbatim into a second home without
  a pointer — twins drift.
- **Present and followed, finding was a false positive we pushed back on** →
  if Copilot keeps raising it, add the push-back rationale to the relevant
  rule so future sessions can cite it instead of re-litigating (precedent:
  the "nullable JSONB union" note in backend-database.md exists exactly
  because two reviewers ping-ponged over it).

### 4. Encode — route each lesson to its ONE right home

| Lesson class | Destination |
|---|---|
| Code pattern (backend/frontend/schema/test) | The matching `{{PATHS_RULES_DIR}}/<area>.md` — follow house style: the rule, the WHY, a greppable proxy, `Precedent: PR #<P> r<R>` |
| A category Copilot caught that our sweep lacks | `resolve-review-feedback/SKILL.md` step 3 — add a numbered check WITH a grep command |
| Spec-stage miss (missing companion file, wrong count, unregistered chain) | `create-spec/SKILL.md` pre-flight checklist (and `workflow.md` "Completeness traps" if it's an incomplete-chain class) |
| Agent behavior miss (wrong tool, skipped step, bad ordering) | The `{{PATHS_AGENTS_DIR}}/<agent>.md` definition |
| Workflow/pipeline ordering (locks, board, CI) | `{{PATHS_RULES_DIR}}/workflow.md` or the ship workflow's prompts in `.claude/workflows/ship.js` |
| Genuinely new area with no existing home | New `{{PATHS_RULES_DIR}}/<name>.md` **plus** a `file-patterns.json` entry (a rule file without a pattern entry is never loaded — and the `agent-instructions-sync` CI job fails on orphans) **plus** a `rule-budgets.json` entry (introduction size +15%, added to `totalCap` too — the same CI job fails on a rule file with no budget entry) |

Style contract for encoded lessons (matches every existing rule):
- State the rule imperatively, then the failure it prevents.
- Give a greppable proxy when one exists — checks that can be run beat prose.
- Cite the precedent (`PR #1128 r2`) so future readers can see the
  original context.
- **Budget: ≤ 12 lines per lesson.** Rule (imperative, ≤ 3 lines) +
  greppable proxy + `(PR #NNNN rX)` — no round-by-round narrative.
  Narrative belongs in the PR body / learn commit message.
- Never weaken or delete an existing rule as part of a learn pass (see
  hard rule 4 for the compression carve-out).

**Self-check your own edits before committing — a Learn commit can seed its
own review findings.** After writing each lesson, sweep the file you edited
for two failure modes the edit itself can introduce:

1. **Heading / identifier collisions.** If you added a numbered or named
   section (`### 6.`, a dimension, a step `3.15`), grep the file for that
   number/name — an insert that duplicates an existing one breaks anchors
   and any cross-reference that addresses sections by number (e.g.
   `audit-phase/SKILL.md` cites `auditor.md` dimensions by number). Prefer
   appending at the end over inserting in the middle, and update any
   cross-file "dimension N"/"step N" reference if you must renumber.
2. **Contradiction with siblings in the same file.** If the lesson adds a
   rule or exception, grep the SAME file for templates, examples, or
   checklists that still state the old behavior — e.g. adding a "use `Refs`
   for partial delivery" note while a PR-body template three sections up
   still hardcodes `Closes #{number}`. Reconcile them in the same commit;
   an agent reads the template AND the note, and a contradiction is a
   guaranteed next-round finding.

Precedent: PR #1177 (#1056) — the first Learn commit drew a second Copilot
round whose two agent-def findings were both self-inflicted: a `### 6.`
heading that collided with the existing dimension 6, and a `Refs`/`Closes`
rule that contradicted the pr-creator PR-body template in the same file.

### 5. Sync + commit

```bash # regenerate AGENTS.md / .github / .agents / .codex
git add -A
git commit -m "learn(#<issue>): encode review lessons from PR #<P>

- <lesson 1> → <file>
- <lesson 2> → <file>"
git push
```

Commit to the **current branch**: when run as ship's terminal phase the PR is
still open, so the lessons ride along and merge with the feature. A rules
edit may trigger one more Copilot round — that's fine; docs-only commits
rarely draw comments, and if one does, `/resolve-review-feedback` handles it
(the ship workflow re-enters its Copilot loop automatically after a Learn push).

### 6. Post the PR comment

If a PR is open for the harvested cycle (always true when run as ship's
terminal phase), post a comment titled **"📚 Learn:"** listing each lesson →
destination file — or stating that zero lessons survived distillation (in
which case nothing was committed):

```bash
gh pr comment <PR> --repo {{VCS_REPO_SLUG}} --body "📚 Learn: encoded <N> lesson(s) from this review cycle

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
   requires its own deliberate change with the user. Compression that
   preserves every normative statement, greppable proxy, precedent ref,
   and operational fact (see `{{PATHS_SPECS_DIR}}/rules-context-slimming.md`
   preservation invariants) is not weakening.
5. **Always ` ` before committing** — a stale generated file
   fails CI (`agent-instructions-sync`).
6. **Before committing, run `scripts/check-rule-budget.sh`.** If the edited
   file exceeds its per-file budget (`{{PATHS_RULES_DIR}}/rule-budgets.json`),
   compress an existing lesson in the same file rather than growing the
   file; if the directory total exceeds the cap, compress the largest file
   over its own target. `scripts/check-rule-preservation.sh <name>` is the
   companion gate proving a compression lost nothing — CI also runs it
   against the merge-base on any PR that shrinks a rule file; a legitimate
   fact REMOVAL that shrinks a file needs a
   `preservation-override: <rule-name> — <justification>` trailer on a
   commit touching the file. If the lesson adds or renames a heading that
   any agent/skill/script cites by exact text, re-run
   `scripts/build-frozen-headings.sh` and commit the delta.
