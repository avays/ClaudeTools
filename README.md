# ClaudeTools

Claude Code tooling extracted from the ORM platform repo — agent definitions,
path-scoped rules, workflow skills, the deterministic ship workflow, and the
supporting orchestration scripts. Paths mirror their in-repo locations so the
contents can be dropped into another project as-is.

## Layout

```
.claude/
  agents/       Agent definitions (spec-writer, developer, auditor, line-reviewer,
                board-runner, pr-creator, refinement, test-runner, context-updater, ...)
  rules/        Path-scoped coding conventions + file-patterns.json (drives agent-sync)
  skills/       Workflow skills (/ship, /board, /ralph, /create-spec, /audit-phase,
                /learn, /resolve-copilot-feedback, /cleanup, /update-context, ...)
  workflows/    ship.js — deterministic multi-agent Workflow (spec → audit loops →
                implement → PR → Copilot loop → learn)
  settings.json Shared project permissions (local settings intentionally excluded)
scripts/
  ralph.sh                      Headless Claude loop (board drain / audit cycles)
  sync-copilot-instructions.mjs Generates Copilot/Codex variants from .claude sources
```

## Notes

- `settings.local.json`, runtime lockfiles, and worktree state were deliberately
  excluded.
- Some skills/rules reference repo-specific context (`.ai/context/`, the
  Digital-Synchrony/ORM board); adapt those paths when reusing elsewhere.
