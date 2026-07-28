# Adding a tracker profile

A tracker is a `templates/trackers/<kind>/profile.json`. No code changes.

```bash
mkdir templates/trackers/linear
cp templates/trackers/github/profile.json templates/trackers/linear/profile.json
# fill in the command strings, then:
node tools/check.mjs --templates
```

Add the kind to `claudetools.config.schema.json` → `tracker.TRACKER_KIND.enum`,
and to `VOCAB_PRESETS` in `tools/init.mjs` if the vocabulary differs
("ticket" vs "issue").

## The tokens

Command strings use `${ID}`, `${BODY}`, `${LABEL}`, `${STATUS}`, `${TITLE}`.
`${REPO}` is substituted by `ct render` from `vcs.VCS_REPO_SLUG`. Anything else
must be resolvable in the environment where the command runs.

An **empty string means "this host has no such capability"**, and templates
gate on that (`{{#if TRACKER_SET_STATUS}}`). Prefer an honest empty over a
command that will fail — a rendered instruction to run something that does not
exist is worse than a missing section.

## The one thing that is not mechanical: the lock

The pipeline supports parallel agents on distinct issues. That rests entirely
on `TRACKER_LOCK_ACQUIRE` being **atomic**: two agents must not both observe an
unlocked issue and both come away believing they hold it.

Check which case your tracker is in before writing the profile:

| Mechanism | Atomic? | Why |
|---|---|---|
| GitHub label add | Yes | Server-side set semantics; the loser sees the winner's label on re-read |
| POSIX `mkdir` | Yes | Fails if the directory exists — the classic filesystem CAS. **A lockfile via `touch` is not**, and must not be substituted |
| JIRA label edit | **No** | Read-modify-write on an array; both writers merge and both "succeed" |
| Single-valued field assignment | Effectively | Second write overwrites — but you must **read back** to learn whether you won |
| Optimistic concurrency (`If-Match`, version precondition) | Yes | The correct general answer where available |

If your tracker's natural mechanism is not atomic, the profile MUST:

1. Route `TRACKER_LOCK_ACQUIRE` through something that is (a single-valued
   field, or a versioned REST call).
2. Say so in `TRACKER_LOCK_MECHANISM` — that string renders directly into
   `workflow.md`, so the reader is told the real semantics instead of
   inheriting an assumption.
3. Spell out the required read-back or fallback in `notes`.

`ct init` prints the JIRA warning at the end of setup for this reason. Losing
atomicity produces no error — just two agents quietly working the same ticket
and racing on the same branch.

## Statuses

Board/workflow status names are per-project on most trackers. The rendered
status table in `workflow.md` is a starting point to edit once after the first
render, not a contract. If your tracker has no board at all, set
`TRACKER_SET_STATUS: ""` and `ct check` will warn about any board prose that
survived.

## Verify

```bash
ct init --yes --target /tmp/probe --tracker <kind> --vcs <kind> --slug a/b --pkg none
ct render --target /tmp/probe
ct check  --target /tmp/probe
```

Expect zero failures and zero warnings. The host-leakage check will flag any
prose still naming a different tracker; a file that legitimately shows one
host's commands as worked examples opts out with:

```html
<!-- host-specific: ... -->
```
