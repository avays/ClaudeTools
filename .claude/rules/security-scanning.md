---
globs:
  - ".github/workflows/security.yml"
  - ".github/dependabot.yml"
  - ".trivyignore"
  - ".gitleaks.toml"
  - "osv-scanner.toml"
  - ".hadolint.yaml"
  - ".semgrepignore"
---

# CI Security Scanning Conventions

Applies to `.github/workflows/security.yml`, `.github/dependabot.yml`, and every
tool ignore/allowlist file at repo root (see the ignore-file table) — #1072.

`{{VCS_REPO_SLUG}}` is a **private** repo: CodeQL, the Security tab's SARIF
upload/display, and GitHub's native secret scanning all require GitHub Advanced
Security (GHAS) on private repos, unavailable on this plan. Every tool below is
free/OSS and reports via job logs + the Actions job summary
(`$GITHUB_STEP_SUMMARY`), not SARIF upload.

## What each tool checks

| Tool | Checks | Scope |
|------|--------|-------|
| **OSV-Scanner** + `pnpm audit --prod` | Known-CVE dependency vulnerabilities against `pnpm-lock.yaml` | Whole repo (single root lockfile) |
| **Semgrep** | SAST — `p/typescript p/nodejs p/react p/owasp-top-ten` OSS rulesets | PR diff only (`--baseline-commit`) |
| **Gitleaks** | Secret scanning (API keys, tokens, credentials committed to git) | PR diff only (`--log-opts=base..HEAD`) |
| **Trivy** | OS + npm package CVEs inside the built container image | 4 production Dockerfiles (backend api, backend worker, frontend, registry) |
| **Hadolint** | Dockerfile best-practice lint | All 6 Dockerfiles in the repo |
| **Dependabot** | Automatic update PRs (npm workspace root + `github-actions` action pins) | Weekly, targets `main` |

## Running the scanners locally

A local runner script (not shipped here — it was specific to the upstream repo's
CI) can mirror this
workflow: all five scanners, same configs, Docker-based except host-run `pnpm
audit`; keeps going on failure and prints a PASS/FAIL/INFO summary. Use it to
reproduce a CI security failure or pre-flight a push.

```bash
pnpm security:scan                 # diff-scoped vs origin/main + GATING — mirrors CI
pnpm security:scan --full          # semgrep whole-tree + gitleaks full-history (INFORMATIONAL deep sweep)
pnpm security:scan --skip-container # skip the 4 Trivy image builds (the slow part)
BASE_REF=origin/staging pnpm security:scan   # diff base for the diff-scoped scanners
```

- **Gating** locally: SCA (OSV + `pnpm audit`), Hadolint (6 Dockerfiles), Trivy
  (4 images); Semgrep + Gitleaks gate in the default (diff-scoped) mode.
- `--full` is **informational**: findings never affect exit. A whole-tree run
  surfaces pre-existing backlog CI never gates on, so failing the aggregate on
  it would mislead.
- Exit is non-zero if a gating scanner fails, or an informational (`--full`)
  scanner itself errors (exit > 1, i.e. couldn't run) — never for `--full`
  findings alone. Needs only `pnpm` + `docker`; drops into a pre-commit/pre-push
  hook cleanly.
- **Tool pins:** OSV-Scanner, Gitleaks, Semgrep match `security.yml`'s pins
  exactly. Trivy and Hadolint run in CI via Actions wrappers (`trivy-action` /
  `hadolint-action`) bundling their own binary with no tool-version input, so
  the script pins those two images locally — bump both with the CI action pins.

## Where each tool's ignore/allowlist file lives

| Tool | File | Format |
|------|------|--------|
| OSV-Scanner | `osv-scanner.toml` (repo root) | `[[IgnoredVulns]]` entries, one per GHSA/CVE id |
| Semgrep | `.semgrepignore` (repo root) + inline `// nosemgrep: rule-id` | Path exclusions (gitignore-style) + per-line suppression |
| Gitleaks | `.gitleaks.toml` (repo root) | `[allowlist]` regexes + paths |
| Trivy | `.trivyignore` (repo root) | One vulnerability ID per line — CVE or GHSA, whichever form Trivy reports; list both forms of an aliased advisory so a Trivy DB re-mapping can't un-suppress it (#1059 precedent) |
| Hadolint | `.hadolint.yaml` (repo root) | `ignored:` rule-id list |

## How to add a justified suppression

Every suppression entry — in any of the five files above — MUST carry (1) a
comment explaining **why** (false positive, no upstream fix, unreachable code
path, …), and (2) for real vulnerability/finding suppressions (not test-fixture
allowlisting), a tracking issue number so it isn't indefinite.

```toml
# osv-scanner.toml
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
reason = "No fix available upstream; usage path is unreachable in prod. Tracked in #NNNN."
```

```
# .trivyignore
CVE-YYYY-NNNNN  # justification — tracking issue #NNNN
```

No blanket or wildcard suppressions (an entire severity tier, a whole rule
category) — every entry is scoped to a specific finding id.

### `nosemgrep` — check_id, placement, and mandatory re-scan verification

Inline `// nosemgrep: <id>` / `# nosemgrep: <id>` suppressions have three
correctness requirements syntax review misses — one that looks right can
suppress nothing:

1. **Use the scanner's reported `check_id`, not the rule name in the findings
   summary or path.** `generic`/composite rules double the final segment —
   `<path>.<rule-name>.<rule-name>`, e.g.
   `generic.nginx.security.request-host-used.request-host-used` or
   `javascript.express.security.cors-misconfiguration.cors-misconfiguration`,
   not the shorter `<path>.<rule-name>` the CLI summary prints. A truncated id
   is silently inert: the comment stays, the finding still fires.
2. **The marker must sit on the finding's own line, or the line immediately
   preceding it.** Semgrep ignores one placed several lines above the flagged
   statement, or above a multi-line comment block preceding it — put it on the
   exact line and move justification prose above.
3. **Verify by re-running the pinned scanner — never trust the string or the
   placement by inspection alone.** After adding or editing a marker run
   `pnpm security:scan` (or a matching pinned `semgrep --config ... --json` run
   for whole-tree rules the diff-scoped default misses) and confirm the finding
   is gone. "Compiles" and "suppresses" are two separate, both-required checks;
   this catches (1) and (2) immediately instead of across three audit rounds.

Separately — **a suppression's scoping justification must be verified against
the actual routing/config match, not the caller's intended usage pattern.**
"This endpoint is only ever called for X" ≠ "this config block only matches X":
an nginx `location /api/` block matches every `/api/*` path whatever the SPA
calls. Read the real match pattern (nginx `location` prefix, regex `.include`
filter, …) first; if it is broader than the claim, narrow the block/predicate or
fix the underlying condition instead of suppressing. Canonical example: a
`platform-admin/nginx.conf` suppression claimed the forwarded `Host` header
"only reaches `/api/v1/platform-admin/*`", but `location /api/` matched every
`/api/*` path; fixed by swapping `proxy_set_header Host $host;` for
`proxy_set_header Host $proxy_host;` (the `proxy_pass`-derived upstream host).

Precedent: PR #1155 (#1131) — self-audit rounds 1–3 fixed 6 truncated
`check_id`s and 2 misplaced markers in `nginx.conf.template`,
`platform-admin/nginx.conf`, `cors.ts`, before a live pinned-semgrep re-run
confirmed zero remaining matches; a separate Copilot round caught a
`location /api/` scoping justification that didn't hold under the block's
actual (broader) match pattern.

## Blocking status per job (all blocking as of #1073)

| Job | Scope | Gate |
|-----|-------|------|
| `sast-semgrep` | PR-diff scoped | **Blocking** (`--error`) |
| `secret-scan-gitleaks` | PR-diff scoped | **Blocking** (`--exit-code=1`) |
| `sca-dependency-scan` | Whole lockfile | **Blocking** (no `continue-on-error`; OSV `exit $OSV_EXIT` + `pnpm audit` under `set -o pipefail`) |
| `container-scan-trivy` | Per production image | **Blocking** (`exit-code: '1'`, `ignore-unfixed: true`) |
| `dockerfile-lint-hadolint` | Per Dockerfile | **Blocking** (`no-fail: false`, `failure-threshold: warning`) |

Semgrep and Gitleaks are diff-scoped, so pre-existing `main` findings never
block a PR — diff-scoping is itself the baseline, hence blocking from day one.
SCA, container, and Dockerfile scanning run against the whole lockfile / image,
where a pre-existing backlog would block every PR regardless of what it touches;
they shipped report-only in #1072, then flipped to blocking in #1073 once the
baseline hit zero (remediations in the CHANGELOG entry: `websocket-driver` →
0.7.5, `node:24-alpine` images dropping the unused global npm CLI + corepack
pnpm cache and `apk upgrade`-ing OS packages, `RUN cd &&` → `WORKDIR` in every
Dockerfile). Trivy's `ignore-unfixed: true` stops a future *unfixable*
base-image CVE (no upstream patch) from blocking unrelated PRs — only fixable
CRITICAL/HIGH findings fail the gate.

**Blocking scanners must not run a tool on a floating `latest`** — a new version
can change behavior or vuln-DB format and break every PR at once. Pinned: the
Semgrep image (`semgrep/semgrep:<version>`), the OSV-Scanner + Gitleaks release
assets (`<version>` in the download URL), and every third-party action by commit
SHA (`# vX.Y.Z` comment kept in sync by Dependabot). Bumping these pins is
periodic maintenance tracked in #1073.

## Findings must be fixed and logged, not silently suppressed indefinitely

Matches the Dependabot-alert triage precedent (#638/#639/#640 — alerts fixed or
dismissed with `tolerable_risk` + a tracking issue, never silently ignored).
When a scan surfaces a real finding:

1. Prefer fixing it (bump the dependency, patch the code, fix the Dockerfile).
2. If the fix isn't immediately available or the risk is accepted, add a
   justified suppression per the format above, with a tracking issue.
3. Log the outcome in `{{PATHS_CONTEXT_DIR}}/BUILD_STATE.md` / `CHANGELOG.md` per the
   repo's per-feature history convention — a scan result that changes what ships
   in production is a build-state fact, not a throwaway CI log line.

## Suppression parity across ALL THREE dependency scanners

A deferred-fix advisory suppressed for SCA (`osv-scanner.toml` +
`pnpm-workspace.yaml` `auditConfig.ignoreGhsas`) MUST also get a
`.trivyignore` entry (under its CVE id — Trivy prefers CVE over GHSA when
one exists) whenever the package ships inside a container image — the
backend/registry images run a workspace-root `{{PKG_INSTALL}} --prod`, so even
frontend-only deps land in them. Trivy's NVD-fed DB maps advisories on its
own schedule, so a two-scanner suppression breaks every PR the day Trivy
catches up. (#1246: GHSA-83w8/GHSA-8pvw/GHSA-qwww were suppressed in both
SCA scanners with #1236 rationale; Trivy mapped the CVEs on 2026-07-25 and
all three container scans went red repo-wide.)

## Gitleaks self-scan gotcha

`.gitleaks.toml` is itself scanned by Gitleaks on any PR that touches it. Prefer
regex allowlisting over literal-string allowlisting so the config doesn't become
a leak vector for the values it exempts. Where a literal fixture value is
unavoidable (e.g. the fixed 64-hex-char test `ENCRYPTION_KEY` shared across
`ci.yml`/`e2e.yml`/`slow-tier-e2e.yml`), the config's own path
(`\.gitleaks\.toml$`) is in `[allowlist].paths` so Gitleaks does not flag its
own allowlist entries as findings.

## Adding a new CI test-fixture secret

A workflow file that introduces a low-entropy placeholder secret (a `JWT_SECRET`
/ `ENCRYPTION_KEY` fixture used only in CI test environments, never a real
credential) MUST add a matching regex to `.gitleaks.toml`'s
`[allowlist].regexes` **in the same PR** — otherwise the blocking
`secret-scan-gitleaks` job fails the very PR that introduces the fixture.

## Follow-up work

Baseline triage and the blocking flip completed in #1073; the one-time
full-history Gitleaks scan ran, and its 11 findings were confirmed non-secret
fixtures and allowlisted in `.gitleaks.toml`. Remaining periodic maintenance,
still tracked under #1073:

- Bump the pinned tool versions as new stable releases ship: Semgrep image
  (`semgrep/semgrep:1.170.0`), OSV-Scanner asset (`v2.4.0`), Gitleaks asset
  (`v8.30.1`), and the SHA-pinned third-party actions (Dependabot proposes the
  bumps; each `uses:` line carries a `# vX.Y.Z` comment it keeps in sync).
- Re-run the one-time full-history Gitleaks scan only if the allowlist or
  history is materially rewritten; the recurring CI job is diff-scoped and
  covers new commits.
- **Enforcement**: making a job "blocking" (`exit-code`/`no-fail`) only fails
  the *check run* — it does not stop a merge unless the check is a **required
  status check** in branch protection / a repo ruleset for `main` and `staging`.
  Configuring those is a repo-admin action outside this workflow file; verify it
  is in place (or file a follow-up) so the blocking flip is actually enforced at
  merge time.
- Optional future scope (not required for the blocking flip): image-scan the two
  non-Railway Dockerfiles (`packages/ui`, `packages/platform-admin`) — both
  `nginxinc/nginx-unprivileged:alpine` static-site servers (#1130), already
  Hadolint-linted.
