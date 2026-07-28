---
name: docs-drift
description: Detect and fix drift between the @orm/docs site and the code — regenerate the committed OpenAPI + registry-reference artifacts and diff them (fail-if-stale), run the registry-reference coverage test, run the docs build (broken links / MDX), flag hardcoded counts in prose docs that disagree with the generated reference, and check for leaked agent-loader scaffolding. Run when docs may have gone stale (after registry/route changes, before a docs release, or on request).
---

# Docs Drift Check

The docs site mixes three kinds of content, each with a different drift risk:

1. **Generated artifacts** — `packages/docs/openapi/orm-api.json` (from
   `gen:openapi`) and `packages/docs/docs/reference/registries/*.md` (from
   `gen:reference`). These are committed; they go stale the moment a route or
   registry changes and nobody regenerates.
2. **Hand-written prose** — `concepts/*` and `subsystems/*` pages. These cite
   counts ("19 flow steps") and names that can drift from the registries.
3. **Upstream `{{PATHS_CONTEXT_DIR}}/*.md`** — the agent-facing notes the prose is mined
   from. These themselves drift (e.g. `AUTOMATION.md` said "18 flow steps" when
   the registry had 19).

This skill detects all three and **safely auto-fixes only the first** (it
regenerates the committed artifacts). For prose / `{{PATHS_CONTEXT_DIR}}` mismatches it
**reports and recommends** — those need human judgement.

## When to run

- After changing a registry definition, a `registerBuiltin*`, or an
  `llm-tool` route (the generated artifacts may be stale).
- Before merging/releasing docs changes.
- On request ("check docs drift", "are the docs stale?").

## Process

Run from the repo root.

### 1. Regenerate the committed artifacts and diff (fail-if-stale)

The generators read the in-process registries/routes, so first build shared
(the recurring stale-`@orm/shared` gotcha — a generator fails to load if the
dist is behind a just-merged `@orm/shared` export):

```bash
{{PKG_BUILD}}
pnpm gen:openapi      # → packages/docs/openapi/orm-api.json
pnpm gen:reference    # → packages/docs/docs/reference/registries/*.md
git status --porcelain packages/docs/openapi/ packages/docs/docs/reference/registries/
```

- **Any diff means a committed artifact was stale.** That is a finding. The safe
  fix is to keep the regenerated files — stage and commit them
  (`docs: regenerate OpenAPI/registry reference`), and report what changed
  (e.g. "field-types 22 → 23").
- The generators emit harmless `ioredis` connection warnings when Redis is
  down — ignore them; check the `[gen:*] wrote …` success line and the exit
  code.

### 2. Coverage — no registry left undocumented

```bash
{{PKG_TEST}} src/__tests__/registry-reference-coverage.test.ts
```

A failure means a new `registerBuiltin*` registry exists that is neither in the
`gen:reference` manifest nor on its `DOCUMENTED_EXCLUSIONS` list — i.e. a
registry with no reference page. Report it; the fix is a manifest entry (to
generate a page) or a documented exclusion, in `export-registries.ts`.

### 3. Build — broken links + MDX hazards

```bash
pnpm --filter @orm/docs build
```

`onBrokenLinks: 'throw'` fails the build on a dead internal link; redocusaurus
fails on a missing OpenAPI spec; MDX fails on an unescaped `{`/`<` in prose.
Any failure is a finding with the offending file in the output.

### 4. Hand-written count drift (heuristic)

The generated reference pages are the source of truth for "how many X exist".
Extract those counts, then grep the prose pages for hardcoded numbers that
disagree:

```bash
# Authoritative counts (from the generated reference)
for f in packages/docs/docs/reference/registries/*.md; do
  printf '%s: ' "$(basename "$f" .md)"; grep -oE 'There (is|are) \*\*[0-9]+\*\*' "$f" | grep -oE '[0-9]+' | head -1
done

# Prose pages that hardcode a count next to a registry/primitive word
grep -rnoE '~?[0-9]+ (flow[- ]step|field type|action type|criteria operator|layout component|context builder|permission|error code|registr)' \
  packages/docs/docs/concepts packages/docs/docs/subsystems
```

For each prose hit, compare its number to the authoritative count for that
registry. A mismatch is a finding (the canonical "18 vs 19" trap). **Preferred
fix: reword the prose to link the reference page instead of hardcoding a
number**, or correct the number. (Prose edits are recommended, not auto-applied
— flag them for the human.)

Also check the **upstream `{{PATHS_CONTEXT_DIR}}/*.md`** sources for the same drift, since
they're what the prose is mined from:

```bash
grep -rnoE '~?[0-9]+ (flow[- ]step|field type|action type|criteria operator|layout component|context builder|permission|error code)' {{PATHS_CONTEXT_DIR}}
```

Report any `{{PATHS_CONTEXT_DIR}}` file whose counts disagree with the registries and
recommend an `/update-context` refresh — but do **not** edit `{{PATHS_CONTEXT_DIR}}` here.

**`error code` counts are the highest-drift offender** — `ERROR_CODES` in
`constants/error-codes.ts` grows on nearly every feature PR, so a hardcoded
count in `{{PATHS_CONTEXT_DIR}}/SHARED_TYPES.md` goes stale faster than most other
registries (it had already drifted twice — `~139` and `~138`/`308` in two
separate rows of the same file — before a third instance was caught in PR
#1156/#1100 review). When a count-drift finding is an `error code` row,
recommend the same fix that PR applied: drop the hardcoded number entirely
and point at `constants/error-codes.ts` directly as the source of truth
("see the file directly for the current count"), rather than re-updating it
to a new number that will just drift again at the next code addition.

### 5. Leak-guard — no agent-loader scaffolding in published docs

```bash
grep -rnE 'Greppable proxy|Precedent: PR #|expression-not-required|Anti-pattern:' packages/docs/docs/
```

Must be empty. A hit means agent-facing rule/context scaffolding was pasted into
a published page instead of being humanized — a finding to fix in the prose.

### 6. Report

Summarize concisely:

- **Regenerated:** which committed artifacts were stale and regenerated (or
  "all current"). If any were stale, commit them.
- **Coverage:** pass, or the registry missing a page.
- **Build:** clean, or the broken link / MDX error.
- **Count drift:** each prose/`{{PATHS_CONTEXT_DIR}}` mismatch (file:line, stated vs
  actual) with the recommended fix.
- **Leak-guard:** clean, or the leaked lines.

Auto-apply only the regeneration (step 1). Everything else is a recommendation
for the human to action.

## Hard rules

1. **Only regeneration is auto-applied.** Never auto-rewrite prose or
   `{{PATHS_CONTEXT_DIR}}/*.md` — flag them.
2. **Never hand-edit a generated file** (`orm-api.json`,
   `reference/registries/*.md`) — regenerate via the script.
3. **Build shared before regenerating** — otherwise the generator may fail to
   load against a just-merged `@orm/shared` export.
4. **A regeneration diff is a finding, not noise** — if `gen:*` produces a diff,
   the committed docs were stale; commit the fresh output.

## Precedents

Extracted after #822 (generated registry reference) and #828/#830 (subsystem
deep-dives), where `AUTOMATION.md`/`AI_AGENTS.md` were found stale on counts
(flow steps grew, and the context-builder count grew again when the `plan`
builder landed in #813) — the exact drift step 4 catches. The "fail-if-stale"
idea in step 1 is the CI-gate-as-skill the #822 spec deferred (Risk #4).
