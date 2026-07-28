# ClaudeTools

Claude Code agent tooling — rules, skills, agents, and the scripts that keep
them from rotting. Copy into a repo, run `setup.sh`, done.

Placeholders make it tracker-agnostic: GitHub Issues, JIRA, or nothing.

```bash
git clone https://github.com/avays/ClaudeTools
./ClaudeTools/setup.sh --target . --profile github --slug acme/platform --pkg pnpm --src src
```

That copies `.claude/` and `scripts/` into your repo, substitutes the
placeholders for your tracker's real commands, and generates the two files that
must be computed rather than shipped.

## Layout

```
.claude/rules/     18 path-scoped convention files
.claude/skills/    19 workflow skills (/create-spec, /audit-phase, /learn, /ship, ...)
.claude/agents/    10 agent definitions (spec-writer, developer, auditor, ...)
.claude/workflows/ ship.js — the deterministic multi-agent pipeline
scripts/           ralph.sh + the 4 rule-governance gates
profiles/          github.env | jira.env | none.env — the placeholder values
setup.sh           copy + substitute
```

Rules you don't want are just files. Delete them.

## setup.sh

```
--target  <dir>    repo to install into (required)
--profile <name>   github | jira | none          (default: github)
--slug    <o/n>    repo slug, e.g. acme/platform
--name    <str>    project name
--branch  <str>    main branch                    (default: main)
--src     <globs>  first-party source globs       (default: src)
--pkg     <mgr>    pnpm|npm|yarn|bun|none         (default: npm)
--force            overwrite existing files
--dry-run          show what would happen
```

It's `sed` and `cp`. The installed files contain your real commands — no
runtime indirection to debug.

Two files it **generates** rather than copies, because shipping them would be
wrong:

- **`rule-budgets.json`** — caps are byte counts and substitution changes byte
  counts, so they're computed from what actually landed (+15%).
- **`file-patterns.json`** — path scoping. Only cross-cutting rules (process,
  review discipline) are always-on; the rest are scoped to your `--src` globs.
  This matters: all-`"**"` would load ~310 KB into every session and review
  prompt, which is the exact failure the budget script exists to prevent. A
  rule with no entry is never loaded at all.

Then commit and run `scripts/build-frozen-headings.sh` — it reads tracked
files, so it needs one commit first.

## The governance scripts

The reason this exists as a repo rather than a gist. Agent rule files rot
predictably: every review cycle adds a lesson, nothing removes one, and
eventually the conventions are 400 KB that no longer fit a review prompt — at
which point someone "cleans up" and silently deletes hard-won knowledge.

| Script | Stops |
|---|---|
| `check-rule-budget.sh` | **Regrowth.** Per-file + directory byte caps, `totalCap == sum(files)` enforced so the two can't disagree. Over budget means compress an existing lesson, not raise the cap. |
| `check-rule-preservation.sh` | **Silent fact loss.** On any rule file that *shrank*: diffs precedent refs, command content, frozen headings, the operational-fact census, and modal density against the merge base. |
| `build-frozen-headings.sh` | **Dangling citations.** Regenerates the headings other files cite by exact text, so renaming one without updating its citers fails. |

Budgets alone cause the deletion problem; preservation alone permits the size
problem. Together the only way to satisfy both is genuine compression.

Verified against a fresh install:

```
$ bash scripts/check-rule-budget.sh                          # after appending 30 KB
OVER BUDGET: workflow is 55776 B > cap 17537 B — compress an existing lesson

$ bash scripts/check-rule-preservation.sh workflow HEAD~1    # after deleting 35 lines
LOST REFS: #1157 #843
LOST FACTS: `.claude/agents/developer.md`

$ bash scripts/check-rule-preservation.sh workflow HEAD~1    # after a pure re-wrap
OK: refs/cmds/facts preserved; headings preserved; fences 4->4; modals 26->26
```

That last line is the hard part — a gate that fires on a benign reflow gets
disabled within a week, so `extract-rule-headings.sh` joins wrapped bullet
leads before extracting to keep the keys wrap-independent.

**Escape hatch** for a deliberate removal — a commit trailer on a commit
touching the file:

```
preservation-override: workflow — the BullMQ chain moved to a worked example
```

## The one thing that isn't mechanical: the lock

The pipeline runs agents in parallel on distinct issues. That rests entirely on
the lock acquire being **atomic**.

- **GitHub** — a label add is atomic server-side. Safe as written.
- **`none`** — `mkdir` fails if the directory exists; the classic filesystem
  compare-and-set. A `touch` lockfile is *not* atomic and must not be
  substituted. Single machine only.
- **JIRA** — a label edit is a read-modify-write on an array. Two agents can
  both read an unlabelled ticket, both write their label, and **both believe
  they hold the lock.** No error — just two agents racing on one branch.

`profiles/jira.env` routes the lock through the assignee field (single-valued,
so the second write overwrites) and requires a **read-back** to learn whether
you won. `setup.sh` prints the mechanism at the end, and `workflow.md` renders
it inline, so nobody inherits GitHub's assumption silently.

If you add a profile, work out which case your tracker is in first.

## Adding a tracker

Copy a profile, fill in the command strings, done — no code changes.

```bash
cp profiles/github.env profiles/linear.env
./setup.sh --target ../repo --profile linear --slug acme/app
```

`${ID}`, `${LABEL}`, `${BODY}`, `${TITLE}`, `${PR}`, `${THREAD}` stay literal —
the agent fills them at call time. An **empty value means "this host can't do
that"**; setup.sh lists the blanks so they're visible rather than silent.

## Provenance

Extracted from a production multi-tenant SaaS platform. Rules cite the issue
and PR numbers where each lesson was learned — deliberately: "PR #1196, three
rounds, each fix reintroducing the bug" carries weight that "be careful" does
not.

Some files are unapologetically specific — `railway.md` documents one real
deployment, and its header says so. The pattern it teaches (every boot-gated
var documented per-service, with a both-processes checklist) only lands when
you can see it applied end to end.

## Refreshing from upstream

`.claude/` here is a tokenized copy of a live repo's. To pull newer content,
copy the file across and re-apply the placeholders by hand — the substitution
table is `profiles/*.env` plus the paths in `setup.sh`. There's deliberately no
sync tool; the volume is low and reverse-substitution is lossy enough that a
human should look at it.

`setup.sh` also creates `.ai/specs/` and `.ai/context/` — nearly every skill
reads or writes them, so without the directories a fresh install has agents
updating paths that don't exist.
