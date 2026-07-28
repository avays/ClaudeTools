---
name: update-progress
description: Update project progress — overwrite CLAUDE.md Current Focus, append to CHANGELOG.md, refresh BUILD_STATE.md
---

# Update Progress

**CLAUDE.md is a lean index/loader.** It must not grow. Per-feature history
lives in `{{PATHS_CONTEXT_DIR}}/CHANGELOG.md`; the phase + feature status table lives in
`{{PATHS_CONTEXT_DIR}}/BUILD_STATE.md`. This skill enforces that separation.

## Hard rules

1. **CLAUDE.md `## Current Focus` is exactly one short line — a SINGLE
   sentence — and you must OVERWRITE it.** Never append. Never add extra
   lines. "One short line" means one sentence, not two-or-three sentences
   packed onto one physical line: push any re-sequencing history, rationale,
   or per-issue detail to `{{PATHS_CONTEXT_DIR}}/CHANGELOG.md` / `BUILD_STATE.md`, and
   leave only the active-issue pointer here. After this skill runs,
   `grep -c "Current focus\|Current Focus" CLAUDE.md` should return 2 at most
   (the `## Current Focus` header + the `/update-progress` skill reference in
   Available Skills). Precedent: PR #1216 (#1210) Copilot round 1 — the
   Current Focus line was flagged for being two long sentences with detail
   that belonged in CHANGELOG/BUILD_STATE.

2. **Per-feature history goes to `{{PATHS_CONTEXT_DIR}}/CHANGELOG.md`.** Append a new
   bullet under the appropriate thematic heading (Core Phases, Backlog &
   Remediation, Frontend, Backend DRY & Refactoring, Advanced Features,
   Integrations, Docker & Infrastructure, Testing, Super Admin & Agent
   Platform, etc.). If no heading fits, add a new one at the bottom.

3. **`{{PATHS_CONTEXT_DIR}}/BUILD_STATE.md` gets phase/feature table rows + key count
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

6. **`BUILD_STATE.md`'s "Last updated" line follows the SAME one-short-line,
   no-history discipline as CLAUDE.md's Current Focus (Rule 1).** It is a
   short pointer to the current update — not a running log with "Previously
   …" segments or a label/status assertion. Detail belongs in `CHANGELOG.md`.
   Precedent: PR #1227 (#1191) Copilot round 1 — the "Last updated" line had
   grown into a long history-carrying sentence duplicating CHANGELOG. Recurred
   PR #1235 (#1184) Copilot round 1 — the line had accumulated a "Previously …"
   segment plus detailed narrative; the fix that stuck also added this
   discipline to `{{PATHS_AGENTS_DIR}}/context-updater.md` (the agent that actually
   writes the line), since that agent's BUILD_STATE.md step previously only
   said "update counts and phase status."

7. **Never assert a mutable `agent:*` label or board-status inside a context
   doc** (`CLAUDE.md`, `BUILD_STATE.md`, `CHANGELOG.md`, `DEFERRED_ITEMS.md`).
   A doc stating "the issue stays labeled `agent:awaiting-input`" (or any
   `agent:speccing` / board-column claim) goes stale the moment the label
   changes — and it changes constantly during the pipeline. State the fact
   without the label claim, or point at the issue number and let the live
   issue own its label state. Precedent: PR #1227 (#1191) Copilot rounds 1–3
   — three separate context docs each asserted an `agent:awaiting-input`
   label that wasn't actually on #1191.

## Steps

1. **Read the current state**:
   - `CLAUDE.md` (confirm it's still the lean index format)
   - `{{PATHS_CONTEXT_DIR}}/BUILD_STATE.md` (current phase table + key counts)
   - `{{PATHS_CONTEXT_DIR}}/CHANGELOG.md` (existing thematic headings)

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
   - After ANY edit to CLAUDE.md, run `{{PKG_SYNC_AGENTS}}` and stage the
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

6. **Run `/update-context`** to refresh `{{PATHS_CONTEXT_DIR}}/*.md` files for any
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
- Copying architectural details from `{{PATHS_RULES_DIR}}/` back into CLAUDE.md.

If any of these happen, revert the problematic additions: move appended
content out of `CLAUDE.md` back into `CHANGELOG.md` or `BUILD_STATE.md`
where it belongs.
