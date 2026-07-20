---
name: manage-context
description: Add, update, or review project context files (CLAUDE.md, rules, skills)
argument-hint: "[add-rule|add-skill|review|update] [name]"
---

# Manage Context: $ARGUMENTS

## Commands

### `add-rule [name]`
Create a new rule file at `.claude/rules/{name}.md`:
- Ask what file globs it should apply to
- Ask what conventions/instructions to include
- Write the file with proper frontmatter (`globs:` array)
- Rules without globs load on every session — use sparingly

### `add-skill [name]`
Create a new skill at `.claude/skills/{name}/SKILL.md`:
- Ask what the skill should do
- Ask if it should be user-invocable, model-invocable, or both
- Write the SKILL.md with proper frontmatter
- Support `$ARGUMENTS` and `$N` placeholders for dynamic input

### `review`
Audit all context files for quality:
1. Read `CLAUDE.md` — check it's under 200 lines, progress section is compact
2. Read `.ai/context/CHANGELOG.md` — check detailed progress lives here, not CLAUDE.md
3. Verify all 20 context files exist in `.ai/context/`: BUILD_STATE, SCHEMA, API_ENDPOINTS, DOMAINS, INFRASTRUCTURE, SHARED_TYPES, AI_AGENTS, INTEGRATIONS, AUTOMATION, AUTH_SECURITY, FRONTEND, REALTIME, DEPLOYMENT, PACKAGES, STYLE_GUIDE, CHANGELOG, PROJECT_BOARD, DEFERRED_ITEMS, PRODUCT_SPEC, IMPLEMENTATION_SPEC
4. List `.claude/rules/` — check each has valid `globs:` frontmatter
5. List `.claude/skills/` — check each has valid SKILL.md with frontmatter
6. Check for contradictions between rules and context files
7. Check for outdated information (stale context files should have header notes)
8. Report findings and suggest fixes

### `update [file]`
Update a specific context file:
- Read the current file
- Check if information is still accurate against the codebase
- Suggest and apply updates
- For CLAUDE.md: verify progress section matches reality

## File Locations
- Root context: `CLAUDE.md`
- Rules: `.claude/rules/*.md` (path scoping via `.claude/rules/file-patterns.json` — see Frontmatter Reference below)
- Skills: `.claude/skills/{name}/SKILL.md`
- Project settings: `.claude/settings.json`
- Specs (read-only reference): `.ai/context/`

## Frontmatter Reference

### Rules

Path scoping lives in `.claude/rules/file-patterns.json` — one entry per
rule file, keyed by the rule's basename (no extension), value a
comma-separated glob list. `scripts/sync-copilot-instructions.mjs` reads it
to set `applyTo:` on the generated `.github/instructions/` variants. A `"**"`
value means always-on (e.g. `architecture-principles`, `workflow`):

```json
{ "backend-api": "packages/backend/src/domains/**/*.routes.ts" }
```

Every rule file MUST have a `file-patterns.json` entry — the
`agent-instructions-sync` CI job fails on orphans. `globs:` YAML frontmatter
found in older rule files is vestigial: the sync script never reads it, so
don't add it to new rules and don't trust it as the scoping source.

### Skills
```yaml
---
name: skill-name
description: When to use this skill
argument-hint: "[arg1] [arg2]"
user-invocable: false            # Only Claude can invoke
allowed-tools: Read, Grep, Glob  # Restrict tool access
---
```
