---
globs: []
---

# Response Conventions

Session-wide communication rules — every response, every agent session,
regardless of file scope.

## End-of-response {{VOCAB_PR}} link

**When the current work has an open {{VOCAB_PR}} — created during this session
OR being actively discussed — end the response with a one-line link to it.**
The user should never have to ask "what's the PR link?" twice. Format, on
its own trailing line:

```
{{VOCAB_PR}}: {{VCS_PR_URL_FORMAT}}
```

If there is no open PR (pre-spec discussion, post-merge cleanup,
branch-less chat), omit the line — never fabricate or guess a URL.

**Applies:** during implementation/audit/review of a feature with an open
PR; after pushing a commit that updates it; after resolving Copilot threads
or fixing CI on it; when reporting CI status, ralph audit results, or
merge-readiness.

**Omit:** PR already merged (cleanup phase); no PR yet (spec writing,
planning, board triage); the response is itself the PR-creation message
(URL already in body); pure non-feature work (skill updates, doc sweeps to
main).

If multiple {{VOCAB_PRS}} are in flight, link the one most relevant to the current
response; if the response touches several, one trailing line each.
Rationale: zero-cost, removes a recurring "can you give me the link?"
friction.
