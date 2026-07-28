# {{PROJECT_NAME}} — project context

{{PROJECT_DESCRIPTION}}

This directory is the **long-lived state of the project**, distinct from the
three other kinds of agent-facing text:

| Lives in | Holds | Changes |
|---|---|---|
| `{{PROJECT_ROOT_DOC}}` | A lean index. Pointers, not content. | Rarely |
| `{{PATHS_RULES_DIR}}/` | How to write code here — conventions, path-scoped | On a `/learn` cycle |
| `{{PATHS_CONTEXT_DIR}}/` (here) | What exists right now — schema, endpoints, state | Every feature |
| `{{PATHS_SPECS_DIR}}/` | What one feature will do | Per feature, then frozen |

Keeping them separate is what stops `{{PROJECT_ROOT_DOC}}` growing without
bound. The failure it prevents: per-feature history accumulating in the root
document until it dominates every agent's context window, crowding out the
task at hand.

## Suggested files

Start with whichever are true for your project and delete the rest — an empty
context file is worse than a missing one, because an agent reads it and
concludes the project genuinely has nothing there.

- `BUILD_STATE.md` — phase status, feature table, key counts
- `CHANGELOG.md` — per-feature implementation log (the detail that must NOT
  live in `{{PROJECT_ROOT_DOC}}`)
- `SCHEMA.md` — data model: tables/collections, columns, relationships
- `API_ENDPOINTS.md` — routes with auth and permission requirements
- `DOMAINS.md` — module inventory and dependencies
- `INFRASTRUCTURE.md` — middleware, plugins, core systems
- `DEPLOYMENT.md` — environments, env vars, queues, storage
- `DEFERRED_ITEMS.md` — work consciously postponed, with the reason

## The one rule that matters

**A context file that has gone stale is worse than no context file.** An agent
trusts these, and a stale `SCHEMA.md` produces confidently wrong code. Either
refresh it (`/update-context`) or put a dated staleness note at its top.
