---
name: github-issue
description: Create, update, list, or close {{VOCAB_ISSUES}} on {{VCS_REPO_SLUG}}
user_invocable: true
---

<!-- host-specific: the tracker/host commands shown below are worked examples from
     one setup. Your configured equivalents live in claudetools.config.json
     (TRACKER_* / VCS_* tokens) — the CONTRACT each step implements is what
     ports; the exact invocation is not. -->


# {{VOCAB_ISSUE_CAP}} Management

Manage {{VOCAB_ISSUES}} on the `{{VCS_REPO_SLUG}}` repository.

## Usage
- `/github-issue create [title]` — Create a new issue
- `/github-issue list` — List open issues
- `/github-issue view [number]` — View issue details
- `/github-issue close [number]` — Close an issue
- `/github-issue update [number]` — Update an issue

## Process

### Create
1. Ask the user for details if not provided (title, description, labels)
2. Format the issue body with:
   - `## Summary` — 1-3 bullet points
   - `## Acceptance Criteria` — What "done" looks like
   - `## Notes` — Any context, constraints, or references
3. Create via: `{{TRACKER_CREATE_ISSUE}}`
4. Return the issue URL
5. **Update project board**: The issue is auto-added to the {{TRACKER_BOARD_NAME}} (Backlog). If the issue is well-defined and ready for spec work, advance it to "Ready for Spec". See `{{PATHS_CONTEXT_DIR}}/PROJECT_BOARD.md` for status IDs and CLI commands.

### List
Run: `{{TRACKER_LIST_ISSUES}}`

### View
Run: `{{TRACKER_VIEW_ISSUE}}`

### Close
Run: `{{TRACKER_CLOSE_ISSUE}}`

### Update
Run: `gh issue edit [number] --repo {{VCS_REPO_SLUG}} --title "..." --body "..."`

## Project Board Integration

All issues are tracked on the **{{TRACKER_BOARD_NAME}}** project board ([view board]({{TRACKER_BOARD_URL}})).

After creating or updating an issue, set its board status appropriately:
- **Backlog** — Rough idea, not yet actionable
- **Ready for Refinement** — Needs discussion or clarification
- **Refined** — Requirements are clear, acceptance criteria defined
- **Ready for Spec** — Approved and ready for `/create-spec`

See `{{PATHS_CONTEXT_DIR}}/PROJECT_BOARD.md` for the full status list, option IDs, and GraphQL commands to update status.

To update status: get the item ID from the board, then call the `updateProjectV2ItemFieldValue` mutation with the appropriate option ID.

## Labels
Use labels when appropriate:
- `bug` — Something is broken
- `enhancement` — New feature or improvement
- `design` — Architecture/design work
- `audit` — Audit or remediation task

## Rules
- Every issue should have a clear title (under 70 characters)
- Use the body for details, not the title
- Reference related issues with `#N` syntax
- When creating a spec after an issue, note the issue number in the spec's Context section
