#!/usr/bin/env bash
# check-rule-preservation.sh <rule-name> [base-ref] — run BEFORE committing a
# rewrite (default base HEAD), or with an explicit base (e.g. a PR's
# merge-base) as CI does for any PR that shrinks a rule file (#1243).
# Legitimate fact REMOVALS (an obsolete port, a deleted env var) that shrink
# a file are unblocked in CI by a commit-message trailer on a commit touching
# the file: `preservation-override: <rule-name> — <one-line justification>`.
set -euo pipefail
export LC_ALL=C
cd "$(git rev-parse --show-toplevel)"
[ $# -ge 1 ] || { echo "usage: check-rule-preservation.sh <rule-name> [base-ref]"; exit 2; }
f="{{PATHS_RULES_DIR}}/$1.md"
BASE="${2:-HEAD}"
git cat-file -e "$BASE:$f" 2>/dev/null || { echo "no $BASE version of $f (new file — nothing to preserve)"; exit 2; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
old() { git show "$BASE:$f"; }
fail=0

# Precondition FIRST (before any check runs): check 3 needs the shared
# extractor; a missing one must be an unambiguous exit 2 up front — not a
# late abort that discards findings the earlier checks already printed (#1243).
[ -r scripts/extract-rule-headings.sh ] || { echo "MISSING scripts/extract-rule-headings.sh — run Sub-Phase A first"; exit 2; }

# 1. Precedent refs: every #NNN/#NNNN in OLD appears in NEW
old       | { grep -oE '#[0-9]{3,4}' || true; } | sort -u > "$tmp/old-refs"
{ grep -oE '#[0-9]{3,4}' "$f" || true; }        | sort -u > "$tmp/new-refs"
m=$(comm -23 "$tmp/old-refs" "$tmp/new-refs"); [ -z "$m" ] || { echo "LOST REFS: $m"; fail=1; }

# 2a. Fenced-block count must not decrease. NOTE the [[:space:]]* — many
#     fences are indented inside list items (frontend-components.md has 26
#     indented vs 22 column-0 markers); a column-0 anchor is blind to them.
oldfence=$(old | { grep -c '^[[:space:]]*```' || true; }); newfence=$({ grep -c '^[[:space:]]*```' "$f" || true; })
[ "$newfence" -ge "$oldfence" ] || { echo "FENCE COUNT DROPPED: $oldfence -> $newfence"; fail=1; }

# 2b. Fenced command CONTENT survives (not just the fence count) — same
#     indented-fence awareness as 2a.
fenced() { awk '/^[[:space:]]*```/{c=!c;next} c' | { grep -E '^[[:space:]]*(grep|rg|comm|find|git|awk|sed|pnpm)' || true; } | sort -u; }
old | fenced > "$tmp/old-fenced"; fenced < "$f" > "$tmp/new-fenced"
m=$(comm -23 "$tmp/old-fenced" "$tmp/new-fenced"); [ -z "$m" ] || { echo "LOST FENCED CMDS:"; echo "$m"; fail=1; }

# 2c. Inline command proxies survive. The [[:space:]] separator after the
#     verb is required — a bare-prefix match false-positives on
#     `common:nextPage` ("comm") and `findEmbeddingReconciliationCandidates()`
#     ("find"). All genuine inline commands have a space after the verb.
inline() { { grep -ohE '`(grep|rg|comm|find|git diff|git log)[[:space:]][^`]{8,}`' || true; } | sort -u; }
old | inline > "$tmp/old-cmds"; inline < "$f" > "$tmp/new-cmds"
m=$(comm -23 "$tmp/old-cmds" "$tmp/new-cmds"); [ -z "$m" ] || { echo "LOST INLINE CMDS: $m"; fail=1; }

# 3. Frozen headings (committed list) present in OLD must survive in NEW.
#    Harvest via the SHARED extractor (headings AND bolded bullet leads) —
#    harvesting only ^#+ lines here would silently un-enforce every
#    bullet-lead entry the builder emits (#1243). Invoked via `bash`
#    (no +x dependency); its existence is guarded as the top-of-script
#    precondition above.
if [ -f {{PATHS_RULES_DIR}}/.frozen-headings.txt ]; then
  headings() { bash scripts/extract-rule-headings.sh; }
  old | headings > "$tmp/old-headings"; headings < "$f" > "$tmp/new-headings"
  sort -u {{PATHS_RULES_DIR}}/.frozen-headings.txt > "$tmp/frozen"
  frozen_in_old=$(comm -12 "$tmp/frozen" "$tmp/old-headings")
  m=$(printf '%s\n' "$frozen_in_old" | { comm -23 - "$tmp/new-headings" || true; } | sed '/^$/d')
  [ -z "$m" ] || { echo "LOST FROZEN HEADING(S):"; echo "$m"; fail=1; }
fi

# 4. Operational-fact census: backticked paths, underscore-bearing ids in
#    BOTH cases (SCREAMING_SNAKE constants AND lowercase snake_case table/
#    column names — `approval_current_approvers`, `tenant_id`), SQL/RLS
#    keyword allowlist, test filenames. (Bare ALL-CAPS words like
#    WRONG/BEFORE are prose emphasis, deliberately NOT counted — invariant 5
#    sanctions deleting WRONG blocks. A WRONG-block deletion may still drop
#    snake_case locals unique to that block — list them under the
#    invariant-5 override in the commit body. Ports are reviewer-checked,
#    not censused — a bare 4-digit alternative would swallow years/line
#    numbers.)
census() { { grep -ohE '`[a-zA-Z0-9_./-]+\.(ts|tsx|sql|json|md|mjs|sh|yml)`|\b[A-Z][A-Z0-9]*(_[A-Z0-9]+)+\b|\b[a-z][a-z0-9]*(_[a-z0-9]+)+\b|\b(JSONB|CASCADE|RESTRICT|BYPASSRLS|SAVEPOINT|NOSUPERUSER)\b|[a-z0-9-]+\.(test|spec)\.tsx?' || true; } | sort -u; }
old | census > "$tmp/old-facts"; census < "$f" > "$tmp/new-facts"
m=$(comm -23 "$tmp/old-facts" "$tmp/new-facts"); [ -z "$m" ] || { echo "LOST FACTS:"; echo "$m"; fail=1; }

# 5. Normative-modal DENSITY (per KB) must not decrease. Absolute count is
#    informational only — compression legitimately merges duplicate
#    restatements, so an absolute non-decrease would fire on every file.
mod() { { grep -oiE '\b(must not|must|never|always|required|mandatory|forbidden|do not)\b' || true; } | wc -l; }
oldmod=$(old | mod); newmod=$(mod < "$f")
oldbytes=$(old | wc -c); newbytes=$(wc -c < "$f")
olddens=$(( oldmod * 1000000 / oldbytes )); newdens=$(( newmod * 1000000 / newbytes ))
[ "$newdens" -ge "$olddens" ] || { echo "MODAL DENSITY DROPPED: $olddens -> $newdens per MB ($oldmod -> $newmod modals)"; fail=1; }

hdrmsg="headings preserved"
[ -f {{PATHS_RULES_DIR}}/.frozen-headings.txt ] || hdrmsg="headings SKIPPED (no .frozen-headings.txt — run Sub-Phase A first)"
[ "$fail" -eq 0 ] && echo "OK: $f — refs/cmds/facts preserved; $hdrmsg; fences $oldfence->$newfence; modals $oldmod->$newmod"
exit "$fail"
