---
name: github-issue
description: Create, update, list, or close GitHub issues on Digital-Synchrony/ORM
user_invocable: true
---

# GitHub Issue Management

Manage GitHub issues on the `Digital-Synchrony/ORM` repository.

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
3. Create via: `gh issue create --repo Digital-Synchrony/ORM --title "..." --body "..."`
4. Return the issue URL
5. **Update project board**: The issue is auto-added to the ORM Build project board (Backlog). If the issue is well-defined and ready for spec work, advance it to "Ready for Spec". See `.ai/context/PROJECT_BOARD.md` for status IDs and CLI commands.

### List
Run: `gh issue list --repo Digital-Synchrony/ORM --state open --limit 20`

### View
Run: `gh issue view [number] --repo Digital-Synchrony/ORM`

### Close
Run: `gh issue close [number] --repo Digital-Synchrony/ORM`

### Update
Run: `gh issue edit [number] --repo Digital-Synchrony/ORM --title "..." --body "..."`

## Project Board Integration

All issues are tracked on the **ORM Build** project board ([view board](https://github.com/orgs/Digital-Synchrony/projects/1)).

After creating or updating an issue, set its board status appropriately:
- **Backlog** — Rough idea, not yet actionable
- **Ready for Refinement** — Needs discussion or clarification
- **Refined** — Requirements are clear, acceptance criteria defined
- **Ready for Spec** — Approved and ready for `/create-spec`

See `.ai/context/PROJECT_BOARD.md` for the full status list, option IDs, and GraphQL commands to update status.

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
