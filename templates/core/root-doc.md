# {{PROJECT_NAME}}

{{PROJECT_DESCRIPTION}}

**This file is a lean index/loader.** It stays short on purpose: it is loaded
into every agent session, so anything that grows here is paid for on every
turn. Per-feature history goes in `{{PATHS_CONTEXT_DIR}}/CHANGELOG.md`; current
state in `{{PATHS_CONTEXT_DIR}}/BUILD_STATE.md`; conventions in
`{{PATHS_RULES_DIR}}/`.

Target ceiling: ~250 lines. If it is growing, the content belongs somewhere
else — that is nearly always true.

## Current focus

<!-- ONE line. Overwritten by /update-progress each cycle, never appended to. -->
_Not started._

## Project structure

```
{{PATHS_SRC_GLOBS}}
{{PATHS_CONTEXT_DIR}}/    Long-lived project state
{{PATHS_SPECS_DIR}}/      Per-feature implementation specs
{{PATHS_RULES_DIR}}/      Path-scoped coding conventions
```

## Development workflow (required)

Every feature follows this order — see `{{PATHS_RULES_DIR}}/workflow.md`:

1. **{{VOCAB_ISSUE_CAP}} first** — no work without a tracked {{VOCAB_ISSUE}}.
2. **Spec first** — `/create-spec`, approved before any code.
3. **Branch** — never commit feature work to `{{PROJECT_MAIN_BRANCH}}`.
4. **Implement** against the spec, committing incrementally.
5. **Self-audit** — the loop ends on a clean audit pass, never on a fix.
6. **{{VOCAB_PR}} + stop** — get it merge-ready, then stop.
   **Never merge without explicit human approval**, including in autonomous
   runs and under "go all the way" instructions.

## Commands

{{#if PKG_INSTALL}}- `{{PKG_INSTALL}}` — install dependencies{{/if}}
{{#if PKG_BUILD}}- `{{PKG_BUILD}}` — build{{/if}}
{{#if PKG_TYPECHECK}}- `{{PKG_TYPECHECK}}` — type-check{{/if}}
{{#if PKG_TEST}}- `{{PKG_TEST}}` — run tests{{/if}}
{{#if PKG_LINT}}- `{{PKG_LINT}}` — lint{{/if}}
- `bash scripts/check-rule-budget.sh` — rule-file size gate

## Context files

`{{PATHS_CONTEXT_DIR}}/` is the source of truth for current state. See its
README for the file set and the staleness rule.

## Conventions

`{{PATHS_RULES_DIR}}/` holds path-scoped conventions, scoped by
`file-patterns.json` and size-capped by `rule-budgets.json`. Adding a rule file
requires an entry in BOTH — CI fails on either omission.

## Tracker

{{VOCAB_ISSUE_CAP}}s live in {{TRACKER_BOARD_NAME}}. Repo: {{VCS_REPO_URL}}.

The agent working lock is {{TRACKER_LOCK_MECHANISM}}. Confirm that acquire is
atomic on your tracker before running agents in parallel — see
`{{PATHS_RULES_DIR}}/workflow.md` "Agent Locking".
