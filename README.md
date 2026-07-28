# ClaudeTools

A portable Claude Code toolchain: the agent pipeline (spec → implement →
audit-loop → PR), path-scoped coding rules, and — the part that actually
matters over time — **a governance system that stops agent context from
rotting.**

Install it into any repo, on any tracker. Nothing here assumes GitHub, Node,
or a particular stack.

```bash
git clone https://github.com/avays/ClaudeTools
cd ClaudeTools
./bin/ct init   --target ../my-repo     # interactive; writes claudetools.config.json
./bin/ct render --target ../my-repo     # renders .claude/, scripts/, CI
./bin/ct check  --target ../my-repo     # verifies the result
```

## Why the governance system is the point

Agent rule files rot in a specific, predictable way: every review cycle adds a
lesson, nothing ever removes one, and eighteen months later the "conventions"
are 400 KB that no longer fit in a review prompt. Then someone does a cleanup
pass and silently deletes hard-won knowledge to get the size down.

Three scripts close both failure modes:

| Script | Stops |
|---|---|
| `check-rule-budget.sh` | **Regrowth.** Per-file byte caps plus a directory total, with the invariant `totalCap == sum(files)` enforced so the two can't disagree. Over budget means compress an existing lesson, not grow the file. |
| `check-rule-preservation.sh` | **Silent fact loss.** On any rule file that SHRANK, diffs precedent references, command content, frozen headings, the operational-fact census, and modal density against the merge base. |
| `build-frozen-headings.sh` | **Dangling citations.** Regenerates the list of headings cited by exact text elsewhere, so renaming one without updating its citers fails. |

They work. Verified against a freshly rendered repo:

```
$ bash scripts/check-rule-budget.sh                          # after appending 40 KB
OVER BUDGET: workflow is 69283 B > cap 17532 B — compress an existing lesson

$ bash scripts/check-rule-preservation.sh workflow HEAD~1    # after deleting 35 lines
LOST REFS: #1157 #843
LOST FACTS: `.claude/agents/developer.md` `.claude/skills/learn/SKILL.md`

$ bash scripts/check-rule-preservation.sh workflow HEAD~1    # after a pure re-wrap
OK: refs/cmds/facts preserved; headings preserved; fences 4->4; modals 26->26
```

That last line is the hard part — the gate must not fire on a benign reflow, or
it gets disabled within a week.

## How portability works

Templates carry `{{TOKEN}}` placeholders; `ct render` substitutes them from
your config. No runtime indirection, no wrapper scripts to debug — the rendered
files contain your real commands.

| Namespace | Examples |
|---|---|
| `TRACKER_*` | `VIEW_ISSUE`, `ADD_LABEL`, `LOCK_ACQUIRE`, `CLOSE_KEYWORD` |
| `VCS_*` | `CREATE_PR`, `PR_CHECKS`, `RESOLVE_THREAD`, `DEFAULT_BASE` |
| `VOCAB_*` | issue/ticket, PR/MR, board names |
| `PKG_*` | build, typecheck, test, lint |
| `PATHS_*` | rules, skills, specs, context, source globs |

Conditional blocks handle capability differences:

```
{{#if VCS_RESOLVE_THREAD}}...{{/if}}        # host supports thread resolution
{{#if TRACKER_KIND=github}}...{{/if}}       # host-exact command block
{{#if PACK:react-vite}}...{{/if}}           # pack is installed
```

A capability your host lacks doesn't render as a broken instruction — the
section disappears.

### Trackers

`github` (gh CLI), `jira` (jira CLI), `none` (markdown files + a lock
directory). Adding one is a `profile.json`, not a code change.

**Read the JIRA profile's notes before running parallel agents.** The pipeline's
parallel-safety rests on an atomic lock acquire. GitHub labels are atomic;
JIRA's label edit is a read-modify-write, so the profile routes the lock through
the assignee field and documents the read-back verification you need. This is
the one place where "swap the tracker" is not purely mechanical, and it is
called out rather than papered over.

### Packs

Core installs everywhere. Stack-specific rules are opt-in:

`node-ts` · `fastify-kysely-pg` · `sql-migrations` · `react-vite` ·
`llm-tool-catalog` · `security-scanning` · `railway` · `docs-site`

A Python repo on JIRA gets 3 rule files and the full pipeline. A TypeScript
monorepo on GitHub gets 13.

## What's in core

**Rules** — `workflow.md` (the pipeline, the self-audit loop, agent locking,
the sibling sweep, completeness traps), `testing-discipline.md` (what a test
must actually prove; vacuous-assertion classes), `response-conventions.md`.

**Skills** — `/create-spec`, `/audit-phase`, `/implement-phase`, `/learn`,
`/ship`, `/board`, `/ralph`, `/get-issue`, `/cleanup`,
`/resolve-review-feedback`, `/update-context`, `/update-progress`,
`/manage-context`, `/generate-features`, `/tracker-issue`.

**Agents** — spec-writer, developer, auditor, line-reviewer, board-runner,
pr-creator, refinement, test-runner, context-updater, agent-manager.

**Scripts** — the three governance scripts above, plus `ralph.sh` (headless
drain loop) and `sync-agent-instructions.mjs` (derived Copilot/Codex variants).

## Commands

| | |
|---|---|
| `ct init` | Write a config (interactive, or `--yes` with flags) |
| `ct render` | Render into a target; then generate budgets + file-patterns |
| `ct check` | Verify a target — or `--templates` for this repo's own hygiene |
| `ct diff` | Show what a re-render would change, without writing |
| `ct extract --from <repo>` | Refresh templates from an upstream checkout |

Two things `render` **generates** rather than copies, because copying them
would be wrong:

- **`rule-budgets.json`** — caps are byte counts, and substituting tokens
  changes byte counts. Computed from what actually landed, +15%.
- **`.frozen-headings.txt`** — depends on which packs you installed and on your
  own source corpus. Built in-target after render. (It reads tracked files, so a
  brand-new repo generates it on the run after the first commit; `ct check`
  warns while it is absent.)

## Keeping up with upstream

`ct extract --from /path/to/upstream` re-tokenizes an upstream checkout into
`templates/`. It is **read-only on the upstream** — never writes, branches, or
stashes there.

Three deliberate properties:

1. An upstream file with no `templates/manifest.json` entry is a **failure**,
   not a skip. New upstream content gets classified deliberately.
2. Files marked `rewrite` stage under `templates/.staged/` instead of
   overwriting — reverse substitution is lossy and those need human review.
3. Command substitutions whose flags vary per call site are **reported, never
   auto-applied**, with the specific loss named ("loses: --json field
   selection").

Nothing is auto-committed. The output is a diff for a human.

## Development

```bash
node tools/check.mjs --templates   # token/manifest hygiene of this repo
```

It catches three classes: a token used in a template but absent from the schema
(would ship as literal `{{FOO}}`), a schema token no template uses (config
surface that does nothing), and a template file no manifest entry points at.

## Layout

```
bin/ct                        CLI
tools/                        render, check, diff, extract, init, tokenize-commands
claudetools.config.schema.json
templates/
  manifest.json               classification of every upstream file
  core/                       rules, skills, agents, scripts, context skeleton, root doc
  packs/<name>/               opt-in stack rules + patterns.json fragment
  trackers/<kind>/profile.json
  ci/<kind>/
docs/examples/                worked examples too specific to genericise
```

## Provenance

Extracted from a production multi-tenant SaaS platform. Rules cite the issue
and PR numbers where each lesson was learned — those references are kept
deliberately: a rule that says "PR #1196, three rounds, each fix reintroducing
the bug" carries weight that "be careful with X" does not.

Where a file is too specific to genericise honestly, it ships as a labelled
worked example (`packs/railway/rules/railway.md`,
`docs/examples/completeness-chains-upstream.md`) rather than being watered down
into advice.
