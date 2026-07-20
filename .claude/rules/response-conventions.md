---
globs: []
---

# Response Conventions

Session-wide communication rules. These apply to every response in every
agent session, regardless of file scope.

## End-of-response PR link

**When the current work has an open GitHub PR — either created during this
session OR being actively discussed — end the response with a one-line link
to that PR.** The user should never have to ask "what's the PR link?" or
"what PR number?" twice.

Format the trailing line as a plain Markdown link on its own:

```
PR: https://github.com/Digital-Synchrony/ORM/pull/<N>
```

If there is no open PR (e.g. pre-spec discussion, post-merge cleanup,
branch-less chat), omit the trailing line — don't fabricate or guess a URL.

**When the trailing line applies:**
- During implementation, audit, or review of a feature with an open PR
- After pushing a commit that updates the open PR
- After resolving Copilot threads or fixing CI on the PR
- When reporting CI status, ralph audit results, or merge-readiness

**When to omit:**
- The PR is already merged (cleanup phase)
- No PR exists yet (spec writing, planning, board triage)
- The response is itself the PR creation message (URL already in body)
- Pure non-feature work (skill updates, doc sweeps to main)

If multiple PRs are in flight in the same conversation, link the one most
relevant to the current response. If the response touches several, list each
on its own trailing line.

Rationale: trailing PR links are zero-cost for the assistant and remove a
recurring friction point ("can you give me the link?") that has come up
across several sessions.
