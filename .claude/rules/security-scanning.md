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

Applies to `.github/workflows/security.yml`, `.github/dependabot.yml`, and
every tool ignore/allowlist file at repo root (`osv-scanner.toml`,
`.semgrepignore`, `.gitleaks.toml`, `.trivyignore`, `.hadolint.yaml`).
Codifies the pattern introduced in #1072.

`Digital-Synchrony/ORM` is a **private** repository without GitHub Advanced
Security (GHAS) — CodeQL and the Security tab's SARIF upload/display, plus
GitHub's native secret scanning, all require GHAS on private repos and are
not available on this plan. Every tool below is free/OSS and reports via
job logs + the GitHub Actions job summary (`$GITHUB_STEP_SUMMARY`), not
SARIF upload.

## What each tool checks

| Tool | Checks | Scope |
|------|--------|-------|
| **OSV-Scanner** + `pnpm audit --prod` | Known-CVE dependency vulnerabilities against `pnpm-lock.yaml` | Whole repo (single root lockfile) |
| **Semgrep** | SAST — `p/typescript p/nodejs p/react p/owasp-top-ten` OSS rulesets | PR diff only (`--baseline-commit`) |
| **Gitleaks** | Secret scanning (API keys, tokens, credentials committed to git) | PR diff only (`--log-opts=base..HEAD`) |
| **Trivy** | OS + npm package CVEs inside the built container image | 4 production Dockerfiles (backend api, backend worker, frontend, registry) |
| **Hadolint** | Dockerfile best-practice lint | All 6 Dockerfiles in the repo |
| **Dependabot** | Automatic update PRs (npm workspace root + `github-actions` action pins) | Weekly, targets `main` |

## Running the scanners locally (`pnpm security:scan`)

`scripts/security-scan.sh` (aliased `pnpm security:scan`, #1123) mirrors this
workflow: it runs all five scanners with the same configs — Docker-based except
`pnpm audit`, which runs on the host — keeps going on failure, and prints a
PASS/FAIL/INFO summary. Use it to reproduce a CI security failure or pre-flight
a change before pushing.

**Tool pins:** OSV-Scanner, Gitleaks, and Semgrep match `security.yml`'s pins
exactly. Trivy and Hadolint are invoked in CI via GitHub Actions wrappers
(`trivy-action` / `hadolint-action`) that bundle their own binary with no
explicit tool-version input, so the script pins those two images locally —
bump them together with the CI action pins.

```bash
pnpm security:scan                 # diff-scoped vs origin/main + GATING — mirrors CI
pnpm security:scan --full          # semgrep whole-tree + gitleaks full-history (INFORMATIONAL deep sweep)
pnpm security:scan --skip-container # skip the 4 Trivy image builds (the slow part)
BASE_REF=origin/staging pnpm security:scan   # diff base for the diff-scoped scanners
```

- **Gating** locally: SCA (OSV + `pnpm audit`), Hadolint (6 Dockerfiles),
  Trivy (4 images). Semgrep + Gitleaks gate in the default (diff-scoped) mode.
- `--full` runs Semgrep whole-tree + Gitleaks full-history **informationally**
  (findings do not affect exit) — a whole-tree run surfaces pre-existing backlog CI never
  gates on, so failing the aggregate on it would mislead.
- Requires only `pnpm` + `docker` on the host. Exit code is non-zero if a
  gating scanner fails, or if an informational (`--full`) scanner itself errors
  (exit > 1, i.e. couldn't run); a `--full` scanner that merely has findings is
  informational and does not affect the exit code. Drops into a
  pre-commit/pre-push hook cleanly.

## Where each tool's ignore/allowlist file lives

| Tool | File | Format |
|------|------|--------|
| OSV-Scanner | `osv-scanner.toml` (repo root) | `[[IgnoredVulns]]` entries, one per GHSA/CVE id |
| Semgrep | `.semgrepignore` (repo root) + inline `// nosemgrep: rule-id` | Path exclusions (gitignore-style) + per-line suppression |
| Gitleaks | `.gitleaks.toml` (repo root) | `[allowlist]` regexes + paths |
| Trivy | `.trivyignore` (repo root) | One CVE ID per line |
| Hadolint | `.hadolint.yaml` (repo root) | `ignored:` rule-id list |

## How to add a justified suppression

Every suppression entry — in any of the five files above — MUST carry:

1. A comment explaining **why** it's suppressed (false positive, no fix
   available upstream, unreachable code path, etc.).
2. For real vulnerability/finding suppressions (not test-fixture
   allowlisting): a tracking issue number so the suppression isn't
   indefinite.

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

No blanket or wildcard suppressions (e.g. ignoring an entire severity tier,
or a whole rule category) — every entry is scoped to a specific finding id.

### `nosemgrep` — check_id, placement, and mandatory re-scan verification

Inline `// nosemgrep: <id>` / `# nosemgrep: <id>` suppressions have two
non-obvious correctness requirements that syntax review alone will not
catch — a suppression that looks right can silently suppress nothing:

1. **Use the scanner's reported `check_id`, not the rule name from the
   findings summary or path.** For `generic`/composite rules, Semgrep
   doubles the final segment: the real id is
   `<path>.<rule-name>.<rule-name>` (e.g.
   `generic.nginx.security.request-host-used.request-host-used`,
   `javascript.express.security.cors-misconfiguration.cors-misconfiguration`),
   not the shorter `<path>.<rule-name>` form that appears in the CLI
   summary. A truncated id is silently inert — the comment stays in the
   file, but the finding still fires.
2. **The marker must sit on the finding's own line, or the line
   immediately preceding it.** Semgrep does not honor a `nosemgrep`
   comment sitting several lines above the flagged statement, or above a
   multi-line comment block that precedes the flagged code — put the
   marker on the exact line, moving multi-line justification prose above
   it if needed.
3. **Verify by re-running the pinned scanner — never trust the string or
   the placement by inspection alone.** After adding or editing any
   `nosemgrep` marker, run `pnpm security:scan` (or a matching pinned
   `semgrep --config ... --json` invocation for whole-tree rules not
   covered by the diff-scoped default) and confirm the specific finding
   is gone from the output. This is the one step that would have caught
   both (1) and (2) immediately instead of across three audit rounds —
   treat "the suppression compiles" and "the suppression suppresses" as
   two separate, both-required checks.

Separately — **a suppression's scoping justification must be verified
against the actual routing/config match, not the caller's intended usage
pattern.** "This endpoint is only ever called for X" is not the same
claim as "this config block only matches X" — an nginx `location /api/`
block matches every `/api/*` path regardless of which paths the SPA
happens to call. Read the actual match pattern (nginx `location` prefix,
regex `.include` filter, etc.) before writing a scoping justification; if
the block is broader than the claim, either narrow the block/predicate or fix
the underlying condition instead of suppressing. Canonical example: a
`platform-admin/nginx.conf` suppression justified the forwarded `Host`
header as "only reaches `/api/v1/platform-admin/*`", but the actual
`location /api/` block matches every `/api/*` path — the config doesn't
enforce the claimed restriction. Fixed by replacing `proxy_set_header
Host $host;` with `proxy_set_header Host $proxy_host;` (the
`proxy_pass`-derived upstream host), which removes the finding's
underlying condition entirely instead of suppressing it.

Precedent: PR #1155 (#1131) — self-audit rounds 1–3 fixed 6 truncated
`check_id`s and 2 misplaced markers across `nginx.conf.template`,
`platform-admin/nginx.conf`, and `cors.ts` before a live pinned-semgrep
re-run confirmed zero remaining matches; a Copilot review round separately
caught a `location /api/` scoping justification that didn't hold under
the block's actual (broader) match pattern.

## Blocking status per job (all blocking as of #1073)

| Job | Scope | Gate |
|-----|-------|------|
| `sast-semgrep` | PR-diff scoped | **Blocking** (`--error`) |
| `secret-scan-gitleaks` | PR-diff scoped | **Blocking** (`--exit-code=1`) |
| `sca-dependency-scan` | Whole lockfile | **Blocking** (no `continue-on-error`; OSV `exit $OSV_EXIT` + `pnpm audit` under `set -o pipefail`) |
| `container-scan-trivy` | Per production image | **Blocking** (`exit-code: '1'`, `ignore-unfixed: true`) |
| `dockerfile-lint-hadolint` | Per Dockerfile | **Blocking** (`no-fail: false`, `failure-threshold: warning`) |

Semgrep and Gitleaks are diff-scoped, so pre-existing findings on `main`
never block a PR — the diff-scoping mechanism itself is the baseline, which
is why they were blocking from day one. SCA, container, and Dockerfile
scanning operate against the whole lockfile / whole image, so a pre-existing
backlog would block every PR regardless of what it touches — they shipped
report-only in #1072 and were flipped to blocking in #1073 after the initial
baseline was triaged to zero (see the CHANGELOG entry: `websocket-driver`
bumped to 0.7.5; the node runtime images (`node:24-alpine`) strip the unused
global npm CLI + corepack pnpm cache and `apk upgrade` OS packages; all
Dockerfile `RUN cd &&` converted to `WORKDIR`). The Trivy gate uses
`ignore-unfixed: true` so a future *unfixable* base-image CVE (no upstream
patch yet) doesn't block every unrelated PR — only fixable CRITICAL/HIGH
findings fail the gate.

**Blocking scanners must not run a tool on a floating `latest`.** A new tool
version can change behavior or its vuln-DB format and break every PR at once.
Each tool is pinned: the Semgrep container image (`semgrep/semgrep:<version>`),
the OSV-Scanner + Gitleaks release assets (`<version>` in the download URL),
and every third-party action by commit SHA (`# vX.Y.Z` comment kept in sync by
Dependabot). Bumping these pins is periodic maintenance tracked in #1073.

## Findings must be fixed and logged, not silently suppressed indefinitely

Matches the established Dependabot-alert triage precedent (#638/#639/#640 —
alerts were fixed or dismissed with `tolerable_risk` + a tracking issue,
never silently ignored). When a scan surfaces a real finding:

1. Prefer fixing it (bump the dependency, patch the code, fix the
   Dockerfile).
2. If the fix isn't immediately available or the risk is accepted, add a
   justified suppression entry per the format above, referencing a
   tracking issue.
3. Log the outcome in `.ai/context/BUILD_STATE.md` / `CHANGELOG.md` per the
   repo's usual per-feature history convention — a scan result that
   changes what ships in production is a build-state fact, not a
   throwaway CI log line.

## Gitleaks self-scan gotcha

`.gitleaks.toml` is itself scanned by Gitleaks on any PR that touches it.
Prefer regex allowlisting over literal-string allowlisting so the config
file doesn't become a leak vector for the very values it's meant to
exempt. Where a literal fixture value is unavoidable (e.g. the fixed
64-hex-char test `ENCRYPTION_KEY` shared across `ci.yml`/`e2e.yml`/
`slow-tier-e2e.yml`), the config's own path
(`\.gitleaks\.toml$`) is added to `[allowlist].paths` so Gitleaks does not
flag its own allowlist entries as findings.

## Adding a new CI test-fixture secret

When a new workflow file introduces a new low-entropy placeholder secret
(a `JWT_SECRET` / `ENCRYPTION_KEY` fixture value used only in CI test
environments, never a real credential), add a matching regex to
`.gitleaks.toml`'s `[allowlist].regexes` in the same PR — otherwise the
`secret-scan-gitleaks` job (which is **blocking**) will fail the very PR
that introduces the fixture.

## Follow-up work

The initial baseline triage and the flip from report-only to blocking for
`sca-dependency-scan`, `container-scan-trivy`, and `dockerfile-lint-hadolint`
completed in #1073 (all five jobs now blocking; the one-time full-history
Gitleaks scan was run and its 11 findings were confirmed non-secret fixtures
and allowlisted in `.gitleaks.toml`). Remaining periodic maintenance, still
tracked under #1073:

- Bump the pinned tool versions as new stable releases ship: Semgrep image
  (`semgrep/semgrep:1.170.0`), OSV-Scanner asset (`v2.4.0`), Gitleaks asset
  (`v8.30.1`), and the SHA-pinned third-party actions (Dependabot proposes the
  bumps; each `uses:` line carries a `# vX.Y.Z` comment it keeps in sync).
- Re-run the one-time full-history Gitleaks scan only if the allowlist or
  history is materially rewritten; the recurring CI job is diff-scoped and
  covers new commits.
- **Enforcement**: making a job "blocking" (`exit-code`/`no-fail`) only fails
  the *check run* — it does not stop a merge unless the check is a **required
  status check** in branch protection / a repo ruleset for `main` and
  `staging`. Configuring those required checks is a repo-admin action outside
  this workflow file; verify it is in place (or file a follow-up) so the
  blocking flip is actually enforced at merge time.
- Optional future scope (not required for the blocking flip): image-scan the
  two non-Railway Dockerfiles (`packages/ui`, `packages/platform-admin`) —
  both are `nginxinc/nginx-unprivileged:alpine` static-site servers (#1130),
  already Hadolint-linted.
