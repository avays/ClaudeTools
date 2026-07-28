#!/usr/bin/env bash
# setup.sh — copy .claude/ and scripts/ into a target repo, substituting the
# {{TOKEN}} placeholders for your tracker, code host, and build commands.
#
#   ./setup.sh --target ../my-repo --profile github --slug acme/platform
#   ./setup.sh --target ../my-repo --profile jira --slug widgets/svc --src app
#
# Everything it does is `sed` and `cp`. Read the rendered files afterwards;
# they are the real thing, with your real commands in them.
set -euo pipefail
export LC_ALL=C

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- args --------------------------------------------------------------------
TARGET=""; PROFILE="github"; SLUG=""; NAME=""; BRANCH="main"
SRC_GLOBS="src"; PKG="npm"; FORCE=0; DRY=0

usage() {
  cat <<EOF
usage: ./setup.sh --target <repo> [options]

  --target  <dir>    repo to install into (required)
  --profile <name>   $(ls "$HERE/profiles" | sed 's/\.env//' | tr '\n' '|' | sed 's/|$//')  (default: github)
  --slug    <o/n>    repo slug, e.g. acme/platform
  --name    <str>    project name for CLAUDE.md
  --branch  <str>    main branch (default: main)
  --src     <globs>  first-party source globs, space-separated (default: src)
  --pkg     <mgr>    pnpm|npm|yarn|bun|none (default: npm)
  --force            overwrite files that already exist
  --dry-run          show what would happen, write nothing

Rules you don't want are just files — delete them after install.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --target)  TARGET="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --slug)    SLUG="$2"; shift 2 ;;
    --name)    NAME="$2"; shift 2 ;;
    --branch)  BRANCH="$2"; shift 2 ;;
    --src)     SRC_GLOBS="$2"; shift 2 ;;
    --pkg)     PKG="$2"; shift 2 ;;
    --force)   FORCE=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

[ -n "$TARGET" ] || { echo "ERROR: --target is required" >&2; usage; exit 2; }
[ -d "$TARGET" ] || { echo "ERROR: target does not exist: $TARGET" >&2; exit 2; }
PROFILE_FILE="$HERE/profiles/$PROFILE.env"
[ -r "$PROFILE_FILE" ] || { echo "ERROR: no profile '$PROFILE' (have: $(ls "$HERE/profiles" | sed 's/\.env//' | tr '\n' ' '))" >&2; exit 2; }
[ -n "$SLUG" ] || echo "WARN: no --slug given; {{VCS_REPO_SLUG}} will be empty"

# --- values ------------------------------------------------------------------
PROJECT_NAME="${NAME:-$(basename "$(cd "$TARGET" && pwd)")}"
PROJECT_MAIN_BRANCH="$BRANCH"
VCS_REPO_SLUG="$SLUG"
PATHS_RULES_DIR=".claude/rules"
PATHS_SKILLS_DIR=".claude/skills"
PATHS_AGENTS_DIR=".claude/agents"
PATHS_SPECS_DIR=".ai/specs"
PATHS_CONTEXT_DIR=".ai/context"
PATHS_SRC_GLOBS="$SRC_GLOBS"

case "$PKG" in
  pnpm) PKG_INSTALL="pnpm install"; PKG_BUILD="pnpm build"; PKG_TYPECHECK="pnpm typecheck"; PKG_TEST="pnpm test" ;;
  npm)  PKG_INSTALL="npm install";  PKG_BUILD="npm run build"; PKG_TYPECHECK="npm run typecheck"; PKG_TEST="npm test" ;;
  yarn) PKG_INSTALL="yarn install"; PKG_BUILD="yarn build"; PKG_TYPECHECK="yarn typecheck"; PKG_TEST="yarn test" ;;
  bun)  PKG_INSTALL="bun install";  PKG_BUILD="bun run build"; PKG_TYPECHECK="bun run typecheck"; PKG_TEST="bun test" ;;
  none) PKG_INSTALL=""; PKG_BUILD=""; PKG_TYPECHECK=""; PKG_TEST="" ;;
  *) echo "ERROR: unknown --pkg '$PKG'" >&2; exit 2 ;;
esac
PKG_SYNC_AGENTS=""   # only if you run a derived-instructions sync; see scripts/

# Profile supplies every TRACKER_* / VCS_* / VOCAB_* value. It is sourced AFTER
# the vars above because several profile entries interpolate them.
# shellcheck disable=SC1090
. "$PROFILE_FILE"

TOKENS="PROJECT_NAME PROJECT_MAIN_BRANCH VCS_REPO_SLUG
PATHS_RULES_DIR PATHS_SKILLS_DIR PATHS_AGENTS_DIR PATHS_SPECS_DIR PATHS_CONTEXT_DIR PATHS_SRC_GLOBS
PKG_INSTALL PKG_BUILD PKG_TYPECHECK PKG_TEST PKG_SYNC_AGENTS
VOCAB_ISSUE VOCAB_ISSUES VOCAB_ISSUE_CAP VOCAB_PR VOCAB_PRS VOCAB_BOARD VOCAB_REVIEWER
TRACKER_ISSUE_REF_FORMAT TRACKER_ISSUE_URL TRACKER_VIEW_ISSUE TRACKER_LIST_ISSUES
TRACKER_CREATE_ISSUE TRACKER_COMMENT_ISSUE TRACKER_CLOSE_ISSUE TRACKER_ADD_LABEL
TRACKER_REMOVE_LABEL TRACKER_SET_STATUS TRACKER_BOARD_NAME TRACKER_BOARD_URL
TRACKER_CLOSE_KEYWORD TRACKER_REF_KEYWORD TRACKER_LOCK_MECHANISM TRACKER_LOCK_ACQUIRE
TRACKER_LOCK_RELEASE TRACKER_LOCK_QUERY
VCS_DEFAULT_BASE VCS_CREATE_PR VCS_CREATE_DRAFT_PR VCS_VIEW_PR VCS_PR_CHECKS
VCS_MARK_READY VCS_RERUN_FAILED_CHECKS VCS_PR_URL_FORMAT VCS_LIST_REVIEW_THREADS VCS_RESOLVE_THREAD"

# --- build the sed program ---------------------------------------------------
# Values are written to a script file rather than passed as -e args so that
# slashes, quotes, and newlines in a command string can't break the program.
SEDPROG="$(mktemp)"; trap 'rm -f "$SEDPROG"' EXIT
BLANK=""
for tok in $TOKENS; do
  val="${!tok-}"
  [ -n "$val" ] || BLANK="$BLANK $tok"
  # \x01 as the delimiter: it cannot appear in any of these values.
  printf 's\x01{{%s}}\x01%s\x01g\n' "$tok" "$(printf '%s' "$val" | sed 's/[&\\]/\\&/g')" >> "$SEDPROG"
done

# --- install -----------------------------------------------------------------
copied=0; skipped=0
install_tree() {
  local src_root="$1"
  find "$src_root" -type f | while IFS= read -r f; do
    rel="${f#"$HERE"/}"
    dest="$TARGET/$rel"
    if [ -e "$dest" ] && [ "$FORCE" -eq 0 ]; then
      echo "  skip (exists): $rel"; continue
    fi
    [ "$DRY" -eq 1 ] && { echo "  would write: $rel"; continue; }
    mkdir -p "$(dirname "$dest")"
    sed -f "$SEDPROG" "$f" > "$dest"
    case "$rel" in *.sh) chmod +x "$dest" ;; esac
    echo "  $rel"
  done
}

echo "Installing into $TARGET (profile: $PROFILE)"
install_tree "$HERE/.claude"
install_tree "$HERE/scripts"

if [ "$DRY" -eq 1 ]; then echo; echo "Dry run — nothing written."; exit 0; fi

# --- generate rule-budgets.json ----------------------------------------------
# Caps are BYTE counts, and substitution changes byte counts — so they must be
# computed from the files that actually landed, never shipped as constants.
# totalCap is their exact sum so the two constraints can't disagree.
RULES="$TARGET/$PATHS_RULES_DIR"
if [ -d "$RULES" ]; then
  {
    echo '{'
    echo '  "_comment": "Per-file byte caps, generated by setup.sh from installed sizes +15%. totalCap = sum of per-file caps. Enforced by scripts/check-rule-budget.sh. Over budget => compress an existing lesson in that file, do not raise the cap.",'
    echo '  "files": {'
    total=0; first=1
    for f in "$RULES"/*.md; do
      [ -e "$f" ] || continue
      n=$(basename "$f" .md); s=$(wc -c < "$f"); cap=$(( (s * 115 + 99) / 100 ))
      total=$((total + cap))
      [ "$first" -eq 1 ] || echo ','
      first=0
      printf '    "%s": %s' "$n" "$cap"
    done
    echo
    echo '  },'
    echo "  \"totalCap\": $total"
    echo '}'
  } > "$RULES/rule-budgets.json"
  echo "  generated $PATHS_RULES_DIR/rule-budgets.json"

  # file-patterns.json — every rule always-on by default. Narrow the globs for
  # stack-specific rules afterwards; a rule with no entry is never loaded.
  {
    echo '{'
    first=1
    for f in "$RULES"/*.md; do
      [ -e "$f" ] || continue
      [ "$first" -eq 1 ] || echo ','
      first=0
      printf '  "%s": "**"' "$(basename "$f" .md)"
    done
    echo
    echo '}'
  } > "$RULES/file-patterns.json"
  echo "  generated $PATHS_RULES_DIR/file-patterns.json"
fi

# --- frozen headings ---------------------------------------------------------
# Needs tracked files, so a fresh repo produces nothing until its first commit.
if [ -d "$TARGET/.git" ] && [ -x "$TARGET/scripts/build-frozen-headings.sh" ]; then
  if (cd "$TARGET" && bash scripts/build-frozen-headings.sh 2>/dev/null); then
    n=$(wc -l < "$RULES/.frozen-headings.txt" 2>/dev/null || echo 0)
    echo "  generated $PATHS_RULES_DIR/.frozen-headings.txt ($n entries)"
  else
    echo "  NOTE: frozen headings skipped — commit the installed files, then run"
    echo "        scripts/build-frozen-headings.sh from the repo root."
  fi
fi

# --- report ------------------------------------------------------------------
echo
left=$(grep -rlE '\{\{[A-Z][A-Z0-9_]*\}\}' "$TARGET/.claude" "$TARGET/scripts" 2>/dev/null || true)
if [ -n "$left" ]; then
  echo "UNSUBSTITUTED TOKENS remain in:"
  printf '  %s\n' $left
  echo "  (a token with no value in profiles/$PROFILE.env — fill it in and re-run with --force)"
fi
[ -n "$BLANK" ] && { echo "Blank values (rendered as empty — fine if the host lacks the capability):"; echo "  $BLANK"; }

cat <<EOF

Done. Next:
  1. Read $PATHS_RULES_DIR/workflow.md — it is the spine, and it now names your
     lock mechanism: $TRACKER_LOCK_MECHANISM
  2. Delete the rules that don't apply to your stack. They're just files.
  3. Narrow the globs in $PATHS_RULES_DIR/file-patterns.json (all "**" by default).
  4. Commit, then run scripts/build-frozen-headings.sh.
EOF
