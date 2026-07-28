#!/usr/bin/env bash
#
# security-scan.sh — local mirror of .github/workflows/security.yml
# (#1123, follow-up to #1073).
#
# Runs all five CI security scanners with the same configs (osv-scanner.toml,
# .gitleaks.toml, .hadolint.yaml, .trivyignore) and pinned tool versions.
# Everything runs via Docker (except `pnpm audit`) — nothing to install but
# pnpm + docker. Each scanner runs independently (keeps going on failure); a
# PASS/FAIL/INFO/SKIP summary is printed at the end. Exits non-zero if a
# gating scanner fails — or if an informational (--full) scanner itself errors
# (exit >1, i.e. couldn't run) — so it drops into a pre-commit/pre-push hook
# cleanly. A --full scanner that merely has FINDINGS is informational and does
# NOT affect the exit code.
#
# Usage:
#   pnpm security:scan                 # diff-scoped vs origin/main + GATING (mirrors CI; fast pre-push check)
#   pnpm security:scan --full          # semgrep whole-tree + gitleaks full-history (INFORMATIONAL deep sweep)
#   pnpm security:scan --skip-container # skip the 4 Trivy image builds (the slow part)
#   pnpm security:scan --help
#   BASE_REF=origin/staging pnpm security:scan   # diff base for the diff-scoped scanners
#
# Notes:
#   - Diff-scoped mode compares against your LOCAL copy of the base ref — run
#     `git fetch origin` first if origin/main (or BASE_REF) may be stale.
#   - --full runs semgrep whole-tree + gitleaks full-history as INFORMATIONAL:
#     a whole-tree run surfaces pre-existing backlog CI never gates on (CI is
#     diff-scoped), so failing the aggregate on it would mislead.
#
set -uo pipefail

if [ "${BASH_VERSINFO[0]:-0}" -lt 4 ]; then
  echo "security-scan.sh needs bash >= 4 (associative arrays); macOS system bash is 3.2 — install a newer bash, e.g. 'brew install bash'." >&2
  exit 2
fi

# Print the header comment block (from line 3 until the first non-comment
# line), stripping the leading "# ". Robust to header length changes.
usage() { awk 'NR>=3 && /^#/ {sub(/^#[ ]?/,""); print; next} NR>=3 {exit}' "$0"; exit "${1:-0}"; }

# Parse args BEFORE the git/docker prerequisite checks so `--help` (and the
# unknown-flag error) work outside a repo or on a host without Docker.
# Diff baseline for the diff-scoped scanners (Semgrep/Gitleaks). Defaults to
# origin/main — this repo's actual PR target. Override to match a different PR
# base, e.g. `BASE_REF=origin/staging pnpm security:scan`.
BASE_REF="${BASE_REF:-origin/main}"
FULL=0
SKIP_CONTAINER=0
for arg in "$@"; do
  case "$arg" in
    --full) FULL=1 ;;
    --skip-container) SKIP_CONTAINER=1 ;;
    -h|--help) usage 0 ;;
    *) { echo "unknown flag: $arg"; usage 2; } >&2 ;;
  esac
done

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "not a git repo" >&2; exit 2; }
cd "$REPO_ROOT" || { echo "cannot cd to repo root: $REPO_ROOT" >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { echo "docker not found on PATH — required for every scanner except 'pnpm audit'." >&2; exit 2; }

# Resolve the diff baseline to BASE_REF's TIP commit — deliberately NOT the
# merge-base. CI baselines Semgrep/Gitleaks on the PR event's base SHA, i.e.
# the base branch tip (see security.yml), and mirroring CI is the whole point
# of this script.
#
# Why the tip and not `git merge-base`: Semgrep reports
# findings(current) − findings(baseline). If the base branch FIXED a finding
# that this branch still carries, a merge-base baseline still contains that
# finding, so it gets subtracted and silently hidden — while CI (base tip)
# reports it. Base-tip is the stricter, CI-faithful choice. Don't "simplify"
# this to merge-base; it under-reports reintroduced findings.
#
# Only the diff-scoped (non---full) mode uses it.
BASE_COMMIT=""
if [ "$FULL" != 1 ]; then
  if ! BASE_COMMIT="$(git rev-parse --verify --quiet "${BASE_REF}^{commit}")"; then
    echo "cannot resolve BASE_REF '$BASE_REF' — fetch it first (e.g. 'git fetch origin'), or set BASE_REF to a ref you have." >&2
    exit 2
  fi
fi

# --- Tool pins ---------------------------------------------------------------
# OSV/Gitleaks/Semgrep match security.yml's pins exactly. Trivy + Hadolint are
# run as GitHub Actions in CI (trivy-action@v0.36.0 / hadolint-action@v3.3.0),
# which bundle their own binary — these image tags track those closely; bump
# together when the CI action pins move.
OSV_IMAGE="ghcr.io/google/osv-scanner:v2.4.0"
GITLEAKS_IMAGE="ghcr.io/gitleaks/gitleaks:v8.30.1"
SEMGREP_IMAGE="semgrep/semgrep:1.170.0"
TRIVY_IMAGE="aquasec/trivy:0.67.0"
HADOLINT_IMAGE="hadolint/hadolint:v2.14.0"

# Let the scanners that shell out to git accept the host-owned mount (git
# ≥2.35.2 refuses a repo owned by a different UID with "dubious ownership").
GIT_SAFE_SRC=(-e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0=/src)
GIT_SAFE_REPO=(-e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0=/repo)

# 4 production images (Trivy) + the 2 extra Dockerfiles (Hadolint only).
TRIVY_TARGETS=(
  "backend-api|packages/backend/Dockerfile"
  "backend-worker|packages/backend/Dockerfile.worker"
  "frontend|packages/frontend/Dockerfile"
  "registry|packages/registry/Dockerfile"
)
HADOLINT_FILES=(
  packages/backend/Dockerfile
  packages/backend/Dockerfile.worker
  packages/frontend/Dockerfile
  packages/registry/Dockerfile
  packages/ui/Dockerfile
  packages/platform-admin/Dockerfile
)

# Colours only when stdout is a TTY (keeps hook/CI captured output clean).
if [ -t 1 ]; then
  BOLD=$'\033[1m'; GREEN=$'\033[32m'; RED=$'\033[31m'; YEL=$'\033[33m'; GREY=$'\033[90m'; OFF=$'\033[0m'
else
  BOLD=''; GREEN=''; RED=''; YEL=''; GREY=''; OFF=''
fi

declare -A RESULT   # step -> PASS | FAIL | INFO | INFO(findings) | SKIP
ORDER=()

record() { RESULT["$1"]="$2"; ORDER+=("$1"); }
hdr() { printf '\n%s══ %s ══%s\n' "$BOLD" "$1" "$OFF"; }

# ----------------------------------------------------------------------------
hdr "SCA — pnpm audit (--prod, high+)"
if pnpm audit --prod --audit-level=high; then record "pnpm-audit" PASS; else record "pnpm-audit" FAIL; fi

hdr "SCA — OSV-Scanner (pnpm-lock.yaml)"
if docker run --rm -v "$REPO_ROOT:/src" -w /src "$OSV_IMAGE" \
     scan source --lockfile=pnpm-lock.yaml:pnpm-lock.yaml --config=osv-scanner.toml; then
  record "osv-scanner" PASS; else record "osv-scanner" FAIL; fi

hdr "Secret scan — Gitleaks"
if [ "$FULL" = 1 ]; then
  echo "(full git history — informational)"
  # Distinguish findings (exit 1) from a real tool/config error (exit >1) —
  # only the former is informational backlog; an error must not masquerade as
  # "findings" in the non-gating summary.
  docker run --rm "${GIT_SAFE_REPO[@]}" -v "$REPO_ROOT:/repo" "$GITLEAKS_IMAGE" \
    detect --source=/repo --log-opts="--all" --config=/repo/.gitleaks.toml --redact --exit-code=1
  gl=$?
  case "$gl" in
    0) record "gitleaks" INFO ;;
    1) record "gitleaks" "INFO(findings)" ;;
    *) echo "  ✗ gitleaks errored (exit $gl)"; record "gitleaks" FAIL ;;
  esac
else
  echo "(diff-scoped: ${BASE_REF} tip ${BASE_COMMIT:0:12}..HEAD — gating)"
  if docker run --rm "${GIT_SAFE_REPO[@]}" -v "$REPO_ROOT:/repo" "$GITLEAKS_IMAGE" \
       detect --source=/repo --log-opts="${BASE_COMMIT}..HEAD" --config=/repo/.gitleaks.toml --redact --exit-code=1; then
    record "gitleaks" PASS; else record "gitleaks" FAIL; fi
fi

hdr "SAST — Semgrep"
SEMGREP_COMMON=(semgrep scan --config=p/typescript --config=p/nodejs --config=p/react --config=p/owasp-top-ten --metrics=off --error)
if [ "$FULL" = 1 ]; then
  echo "(whole-tree — informational)"
  # Semgrep: exit 1 = findings, exit >1 = execution error. Only findings are
  # informational backlog; surface a real error as FAIL, don't mislabel it.
  docker run --rm "${GIT_SAFE_SRC[@]}" -v "$REPO_ROOT:/src" -w /src "$SEMGREP_IMAGE" \
    "${SEMGREP_COMMON[@]}"
  sg=$?
  case "$sg" in
    0) record "semgrep" INFO ;;
    1) record "semgrep" "INFO(findings)" ;;
    *) echo "  ✗ semgrep errored (exit $sg)"; record "semgrep" FAIL ;;
  esac
else
  echo "(diff-scoped vs ${BASE_REF} tip ${BASE_COMMIT:0:12} — gating)"
  # `--baseline-commit` (not `--baseline-ref`) — matches security.yml; only
  # reports findings NOT already present at the baseline commit. BASE_REF is a
  # ref (origin/main) that git resolves to a commit.
  if docker run --rm "${GIT_SAFE_SRC[@]}" -v "$REPO_ROOT:/src" -w /src "$SEMGREP_IMAGE" \
       "${SEMGREP_COMMON[@]}" --baseline-commit="$BASE_COMMIT"; then
    record "semgrep" PASS; else record "semgrep" FAIL; fi
fi

hdr "Dockerfile lint — Hadolint (6 Dockerfiles)"
hadolint_fail=0
for df in "${HADOLINT_FILES[@]}"; do
  if out=$(docker run --rm -i -v "$REPO_ROOT/.hadolint.yaml:/.hadolint.yaml:ro" "$HADOLINT_IMAGE" \
             hadolint --config /.hadolint.yaml - < "$df" 2>&1); then
    printf '  ✔ %s\n' "$df"
  else
    printf '  ✗ %s\n%s\n' "$df" "$out"; hadolint_fail=1
  fi
done
record "hadolint" "$([ $hadolint_fail -eq 0 ] && echo PASS || echo FAIL)"

hdr "Container scan — Trivy (4 production images)"
if [ "$SKIP_CONTAINER" = 1 ]; then
  echo "(skipped via --skip-container)"; record "trivy" SKIP
else
  # No --scanners flag: matches the trivy-action default (vuln + secret).
  # CRITICAL,HIGH is a single --severity value, not an array separator (SC2054).
  # shellcheck disable=SC2054
  TRIVY_ARGS=(image --severity CRITICAL,HIGH --ignore-unfixed --ignorefile /.trivyignore --quiet)
  trivy_fail=0
  for entry in "${TRIVY_TARGETS[@]}"; do
    img="${entry%%|*}"; dockerfile="${entry##*|}"
    echo "  • building $img ($dockerfile)…"
    if ! build_out=$(docker build -f "$dockerfile" -t "local-scan/$img:ci" . 2>&1); then
      printf '    ✗ build failed\n%s\n' "$build_out"; trivy_fail=1; continue
    fi
    # `--exit-code 2` for findings so they're distinguishable from a Trivy
    # EXECUTION error — Trivy exits 1 on fatal errors (daemon down, image not
    # found, DB download/auth failure), so the usual "exit 1 = findings"
    # assumption would misreport a broken scan as vulnerabilities. Output is
    # captured (not discarded) so both cases print actionable detail.
    scan_out=$(docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
      -v "$REPO_ROOT/.trivyignore:/.trivyignore:ro" "$TRIVY_IMAGE" \
      "${TRIVY_ARGS[@]}" --exit-code 2 "local-scan/$img:ci" 2>&1)
    tv=$?
    case "$tv" in
      0) echo "    ✔ $img: clean (no fixable CRITICAL/HIGH)" ;;
      2) printf '    ✗ %s: fixable CRITICAL/HIGH found\n%s\n' "$img" "$scan_out"; trivy_fail=1 ;;
      *) printf '    ✗ %s: Trivy errored (exit %s) — scan did NOT complete\n%s\n' "$img" "$tv" "$scan_out"; trivy_fail=1 ;;
    esac
  done
  record "trivy" "$([ $trivy_fail -eq 0 ] && echo PASS || echo FAIL)"
fi

# --- Summary ----------------------------------------------------------------
printf '\n%s════════════ SUMMARY ════════════%s\n' "$BOLD" "$OFF"
gate_fail=0
for step in "${ORDER[@]}"; do
  case "${RESULT[$step]}" in
    PASS) printf '  %s✔ PASS%s  %s\n' "$GREEN" "$OFF" "$step" ;;
    FAIL) printf '  %s✗ FAIL%s  %s\n' "$RED" "$OFF" "$step"; gate_fail=1 ;;
    SKIP) printf '  %s– SKIP%s  %s\n' "$GREY" "$OFF" "$step" ;;
    *)    printf '  %sℹ %s%s  %s\n' "$YEL" "${RESULT[$step]}" "$OFF" "$step" ;;
  esac
done
if [ $gate_fail -eq 0 ]; then
  printf '\n%sAll gating scanners passed.%s\n' "$GREEN" "$OFF"; exit 0
else
  printf '\n%sOne or more scanners FAILED — a gating scanner, or a --full scanner that errored (see above).%s\n' "$RED" "$OFF"; exit 1
fi
