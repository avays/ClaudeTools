---
name: get-issue
description: Survey open GitHub issues and epics, exclude anything already in flight (agent:* labels, open PRs, remote branches), and recommend what to pursue next by epic. Usage: /get-issue [epic_number | quick]
user_invocable: true
argument-hint: "[epic_number | quick]"
---

# Get Issue — recommend the next issue to pursue

Read-only triage over the whole open-issue landscape: gather issues, epics,
open PRs, remote branches, and agent locks; group by epic; work out each
epic's unblocked frontier; and recommend one issue to do next (balanced
verdict), with a quick-win and a critical-path alternate.

**This skill mutates nothing.** No labels, no board moves, no locks, no
branches. It ends with an offer — never by starting work.

## Arguments

- *(none)* — full analysis across every open issue.
- `<epic_number>` — scope the analysis to that epic's children only.
- `quick` — skip epic analysis; rank standalone, small (size:S/M or
  unlabeled), low-risk issues only.

## Steps

### 1. Gather

Run the read-only sweep (first three in parallel):

```bash
gh issue list --repo Digital-Synchrony/ORM --state open --limit 200 \
  --json number,title,labels,updatedAt \
  --jq '.[] | "\(.number)\t\([.labels[].name] | join(","))\t\(.updatedAt)\t\(.title)"'

gh pr list --repo Digital-Synchrony/ORM --state open \
  --json number,title,headRefName,body,isDraft \
  --jq '.[] | "\(.number)\t\(.headRefName)\t\(.isDraft)\t\(.title)\t\(.body | gsub("\n"; " ") | .[0:200])"'

git fetch origin --prune && git ls-remote --heads origin 'feature/*'
```

Then fetch the body of every open issue whose title starts with `Epic:`
(one `gh issue view <N> --repo Digital-Synchrony/ORM --json body` each) —
epic bodies carry the child task lists and dependency annotations.

**Board status is best-effort only.** If you want it, use the issue-side
query (`repository.issue(N).projectItems` filtered to project 1 — see
`.ai/context/PROJECT_BOARD.md`), try it ONCE, and on any scope error
(`INSUFFICIENT_SCOPES`) proceed without board data. Labels, PRs, and
branches are the source of truth; a board failure is never fatal.

### 2. Exclude what's in flight

Three independent signals, checked per issue:

1. **Any `agent:*` label** → hard-exclude. These are the repo's working
   locks (`.claude/rules/workflow.md`); `agent:awaiting-input` and
   `agent:error` additionally mean "human-gated — do not touch".
2. **An open PR references it** — body contains `Closes #N` / `Fixes #N`
   / `Resolves #N`, or the `headRefName` slug obviously matches the issue
   title → hard-exclude, and report the PR number next to the exclusion.
3. **A remote `feature/*` branch slug-matches the issue** but no open PR
   exists → soft-flag: list the issue as "likely in flight — verify
   before starting" rather than excluding it silently (the branch may be
   abandoned).

Slug-matching is heuristic: compare branch name words against issue title
keywords (e.g. `feature/record-embedding-reconciliation` ↔ "record_embeddings
has no automatic reconciliation"). When unsure, soft-flag instead of
excluding.

### 3. Group by epic

- **Epics** are open issues titled `Epic: …`. Their children are the
  `#NNNN` references in the epic body's task lists (`- [ ] #NNNN` /
  `- [x] #NNNN`). There is no epic label and no sub-issue API usage in
  this repo — body task lists are the only linkage. Series title
  prefixes (`[CH-…]`, `[Cardhouse P…]`) corroborate membership; never
  invent membership from a prefix alone without a body reference.
- Parse each epic body's ordering signals: phase headings, and the
  inline annotations `(dep: …)`, `(blocks …)`, `(gated by …)`,
  `(parallel)`.
- Every open issue not claimed by any epic goes in a **Standalone**
  group.

### 4. Analyze — find each epic's frontier, then rank

Per epic, the **frontier** is the set of children whose stated
dependencies are all closed (checked-off in the task list or closed on
GitHub) and which carry no in-flight signal from step 2.

Flag frontier items an agent cannot complete alone — spikes needing
external account approvals, vendor sign-ups, or explicit human
decisions (e.g. OAuth verification kickoffs). They stay listed but are
marked "needs Andy".

Rank the overall recommendation as a **balanced verdict**, weighing:

- **Critical-path value** — how many downstream children the candidate
  unblocks (count the `dep:`/`blocks` edges).
- **Quick-win value** — size label (S/M beats L/XL), standalone-ness,
  low blast radius.
- **Severity** — production correctness bugs outrank feature work of
  similar size.
- **Staleness** — long-unassigned bugs get a nudge.

### 5. Report

Keep it scannable:

1. Per-epic table: epic → frontier candidates (with size labels) →
   what the rest is blocked on → in-flight exclusions (with PR/branch).
2. **Standalone** section: same treatment.
3. **Recommended next: #N** — 2–3 sentences of rationale referencing the
   weights above.
4. **Quick-win alternate** and **critical-path alternate**, one line each.
5. Close with the offer: "Want me to `/ship <N>`?" — and stop. Never
   launch `/ship`, acquire a lock, or edit anything unprompted.

## What NOT to do

- No `gh issue edit`, no label changes, no board mutations, no branch
  creation — this skill is strictly read-only.
- Never recommend an issue carrying any in-flight signal without
  surfacing that signal.
- Don't fail the run because the board API errored — degrade to
  labels/PRs/branches.
- Don't dump the full issue list — the report is the analysis, not the
  inventory.

## Edge cases

- **Issue in an epic task list but already closed**: treat as a
  satisfied dependency; don't list it.
- **Epic with zero unblocked children**: say what the epic is waiting on
  (e.g. "all children dep on #NNNN, in flight as PR #MMMM").
- **Two epics claiming the same child**: list it under both, note the
  duplication.
- **`quick` mode with no small standalone issues**: say so and fall back
  to the smallest frontier items across epics.
- **`<epic_number>` argument that isn't an epic**: if the issue exists
  but isn't titled `Epic:`, treat it as a lone issue — report its own
  in-flight status and dependencies instead.

## Precedents

- In-flight filter conventions: `scripts/ralph.sh pick_next_issue`
  (OPEN + no `agent:*` label) and `.claude/rules/workflow.md` (lock
  vocabulary).
- Live examples this skill exists for (2026-07-19): #1130 was already
  covered by open PR #1158, and #1105 carried `agent:in-progress` plus a
  remote `feature/record-embedding-reconciliation` branch — both must be
  excluded by steps 2.1–2.3.
