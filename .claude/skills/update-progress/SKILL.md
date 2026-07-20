---
name: update-progress
description: Update project progress — overwrite CLAUDE.md Current Focus, append to CHANGELOG.md, refresh BUILD_STATE.md
---

# Update Progress

**CLAUDE.md is a lean index/loader.** It must not grow. Per-feature history
lives in `.ai/context/CHANGELOG.md`; the phase + feature status table lives in
`.ai/context/BUILD_STATE.md`. This skill enforces that separation.

## Hard rules

1. **CLAUDE.md `## Current Focus` is exactly one short line, and you must
   OVERWRITE it.** Never append. Never add extra lines. After this skill
   runs, `grep -c "Current focus\|Current Focus" CLAUDE.md` should return
   2 at most (the `## Current Focus` header + the `/update-progress` skill
   reference in Available Skills).

2. **Per-feature history goes to `.ai/context/CHANGELOG.md`.** Append a new
   bullet under the appropriate thematic heading (Core Phases, Backlog &
   Remediation, Frontend, Backend DRY & Refactoring, Advanced Features,
   Integrations, Docker & Infrastructure, Testing, Super Admin & Agent
   Platform, etc.). If no heading fits, add a new one at the bottom.

3. **`.ai/context/BUILD_STATE.md` gets phase/feature table rows + key count
   updates.** Append a row to the phase status table with issue number (if
   any), feature name, DONE/IN PROGRESS, migration numbers, and domains
   touched. Refresh the "Key Counts" section if counts changed (migrations,
   domains, tables, endpoints, skills, etc.).

4. **Do NOT add bullet points or tables to CLAUDE.md.** If you find yourself
   wanting to, the content belongs in CHANGELOG.md or BUILD_STATE.md.

5. **Do NOT modify the Key Architecture section unless a genuinely new
   architectural paradigm was introduced** (e.g. a new core system like
   "BullMQ automation" or "AI agent platform"). Feature additions don't
   count.

## Steps

1. **Read the current state**:
   - `CLAUDE.md` (confirm it's still the lean index format)
   - `.ai/context/BUILD_STATE.md` (current phase table + key counts)
   - `.ai/context/CHANGELOG.md` (existing thematic headings)

2. **Verify no drift in CLAUDE.md**:
   - `wc -l CLAUDE.md` should be roughly ≤ 180 lines. If it's much bigger,
     something was appended that shouldn't have been — find it and move it
     to CHANGELOG.md or BUILD_STATE.md before continuing.
   - `grep -c "Current focus" CLAUDE.md` should be ≤ 2.

3. **Overwrite the Current Focus line in CLAUDE.md**:
   - Locate the `## Current Focus` section.
   - Replace the single line under it with a new short focus (one sentence
     max, ~15–25 words, mentioning the issue number if applicable).
   - Do NOT add a second line. Do NOT keep the old line as "prior focus".
   - **Issue/epic + changelog pointer ONLY** — no branch names, no PR
     numbers, no stacked-on/merge-status narrative. Those go stale the
     moment a PR merges or retargets and belong in `CHANGELOG.md`.
     (PR #988 burned two Copilot review rounds on this line alone.)
   - After ANY edit to CLAUDE.md, run `pnpm sync-agents` and stage the
     regenerated files (`AGENTS.md .agents/ .codex/ .github/`) in the same
     commit — the `agent-instructions-sync` CI job fails on staleness.

4. **Append the new feature to `CHANGELOG.md`**:
   - Find the right thematic section (or create a new one at the bottom
     only if none fit).
   - Write a single bullet with the feature name, issue number, DONE/IN
     PROGRESS status, and a factual summary of what changed (files,
     migrations, API endpoints, frontend components, test coverage).

5. **Append to `BUILD_STATE.md`**:
   - Add a row to the phase status table with issue number, feature name,
     status, migration numbers, and domains touched.
   - Refresh "Key Counts" if any of the counted items changed (migrations,
     domains, tables, API endpoints, skills, agents, field types, flow
     steps, custom action types, etc.).

6. **Run `/update-context`** to refresh `.ai/context/*.md` files for any
   subsystem that was touched (schema, API endpoints, domains,
   infrastructure, automation, AI_AGENTS, integrations, frontend).

## Anti-patterns (what caused the 332-line bloat)

- Stacking multiple `**Current focus**:` lines instead of overwriting the
  last one.
- Adding a new row to CLAUDE.md's "Implementation Status" table for every
  feature (those belong in `BUILD_STATE.md`).
- Adding a new bullet to CLAUDE.md's "Implementation Progress" section for
  every feature (those belong in `CHANGELOG.md`).
- Expanding "Key Architecture" from one-liners back into multi-sentence
  paragraphs.
- Copying architectural details from `.claude/rules/` back into CLAUDE.md.

If any of these happen, revert the problematic additions: move appended
content out of `CLAUDE.md` back into `CHANGELOG.md` or `BUILD_STATE.md`
where it belongs.
