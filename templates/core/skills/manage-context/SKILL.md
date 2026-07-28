---
name: manage-context
description: Add, update, or review project context files (CLAUDE.md, rules, skills)
argument-hint: "[add-rule|add-skill|review|update] [name]"
---

# Manage Context: $ARGUMENTS

## Commands

### `add-rule [name]`
Create a new rule file at `{{PATHS_RULES_DIR}}/{name}.md`:
- Ask what file paths/globs the rule should scope to
- Ask what conventions/instructions to include
- Write the file with NO `globs:` frontmatter, and add the rule's glob list
  to `{{PATHS_RULES_DIR}}/file-patterns.json` — the ONLY scoping source (see
  Frontmatter Reference below; `globs:` frontmatter is vestigial) — PLUS a
  `{{PATHS_RULES_DIR}}/rule-budgets.json` entry (introduction size +15%, and add
  the same amount to `totalCap`) — the `agent-instructions-sync` CI job
  fails on a rule file with no budget entry (`check-rule-budget.sh`)

### `add-skill [name]`
Create a new skill at `{{PATHS_SKILLS_DIR}}/{name}/SKILL.md`:
- Ask what the skill should do
- Ask if it should be user-invocable, model-invocable, or both
- Write the SKILL.md with proper frontmatter
- Support `$ARGUMENTS` and `$N` placeholders for dynamic input

### `review`
Audit all context files for quality:
1. Read `CLAUDE.md` — check it stays a lean index (~250-line ceiling; 219 as of #1243), progress section is compact
2. Read `{{PATHS_CONTEXT_DIR}}/CHANGELOG.md` — check detailed progress lives here, not CLAUDE.md
3. Verify all 20 context files exist in `{{PATHS_CONTEXT_DIR}}/`: BUILD_STATE, SCHEMA, API_ENDPOINTS, DOMAINS, INFRASTRUCTURE, SHARED_TYPES, AI_AGENTS, INTEGRATIONS, AUTOMATION, AUTH_SECURITY, FRONTEND, REALTIME, DEPLOYMENT, PACKAGES, STYLE_GUIDE, CHANGELOG, PROJECT_BOARD, DEFERRED_ITEMS, PRODUCT_SPEC, IMPLEMENTATION_SPEC
4. List `{{PATHS_RULES_DIR}}/` — check each has a `file-patterns.json` entry AND
   a `rule-budgets.json` entry (run `scripts/check-rule-budget.sh`;
   `globs:` frontmatter is vestigial — flag it for removal, never add it)
5. List `{{PATHS_SKILLS_DIR}}/` — check each has valid SKILL.md with frontmatter
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
- Rules: `{{PATHS_RULES_DIR}}/*.md` (path scoping via `{{PATHS_RULES_DIR}}/file-patterns.json` — see Frontmatter Reference below)
- Skills: `{{PATHS_SKILLS_DIR}}/{name}/SKILL.md`
- Project settings: `.claude/settings.json`
- Specs (read-only reference): `{{PATHS_CONTEXT_DIR}}/`

## Frontmatter Reference

### Rules

Path scoping lives in `{{PATHS_RULES_DIR}}/file-patterns.json` — one entry per
rule file, keyed by the rule's basename (no extension), value a
comma-separated glob list. `scripts/sync-copilot-instructions.mjs` reads it
to set `applyTo:` on the generated `.github/instructions/` variants. A `"**"`
value means always-on (e.g. `architecture-principles`, `workflow`):

```json
{ "backend-api": "{{PATHS_SRC_GLOBS}}/domains/**/*.routes.ts" }
```

Every rule file MUST have a `file-patterns.json` entry AND a
`rule-budgets.json` entry — the `agent-instructions-sync` CI job fails on
orphans and on a rule file with no budget entry (`check-rule-budget.sh`). `globs:` YAML frontmatter
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
