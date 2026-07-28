#!/usr/bin/env bash
# build-frozen-headings.sh — regenerate {{PATHS_RULES_DIR}}/.frozen-headings.txt
set -euo pipefail
export LC_ALL=C
cd "$(git rev-parse --show-toplevel)"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

# Req 1: normalized one-line-per-file corpus
git ls-files {{PATHS_AGENTS_DIR}} {{PATHS_SKILLS_DIR}} .claude/workflows scripts {{PATHS_SRC_GLOBS}} \
| while IFS= read -r c; do
  sed -E 's@^[[:space:]]*(//|\*+|#+)[[:space:]]?@@' "$c" | tr '\n' ' ' | tr -s ' '
  echo
done > "$tmp/corpus"

# Req 4: cited-in-corpus test — window around the match must name a .md file
cited() {
  awk -v key="$1" '
    { line = $0
      while ((i = index(line, key)) > 0) {
        w = substr(line, (i > 100 ? i-100 : 1), 200 + length(key))
        if (w ~ /[a-z-]+\.md/) { found = 1; exit }
        line = substr(line, i + 1)
      } }
    END { exit found ? 0 : 1 }' "$tmp/corpus"
}

# Req 2 via the shared extractor; Req 3: full 40-char prefix OR lead segment
cat {{PATHS_RULES_DIR}}/*.md | bash scripts/extract-rule-headings.sh | while IFS= read -r h; do
  full=$(printf '%s' "$h" | tr -d '`' | cut -c1-40)
  lead=$(printf '%s' "$h" | tr -d '`' | sed -E 's/ — .*//; s/ \(.*//' | cut -c1-40)
  emit=0
  if [ "${#full}" -ge 12 ] && cited "$full"; then emit=1; fi
  if [ "$emit" -eq 0 ] && [ "$lead" != "$full" ] && [ "${#lead}" -ge 12 ] && cited "$lead"; then emit=1; fi
  if [ "$emit" -eq 1 ]; then printf '%s\n' "$h"; fi
done > {{PATHS_RULES_DIR}}/.frozen-headings.txt
exit 0   # the while loop's last-iteration status must not leak (set -e)
