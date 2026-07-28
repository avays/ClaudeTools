#!/usr/bin/env bash
# extract-rule-headings.sh — stdin: rule-file markdown → stdout: candidate
# citation texts (markdown headings + bolded bullet leads), one per line.
# Shared by build-frozen-headings.sh AND check-rule-preservation.sh check 3.
set -euo pipefail
export LC_ALL=C
in=$(cat)
{ printf '%s\n' "$in" | { grep -E '^#+ ' || true; } | sed 's/^#* *//'
  # Bullet leads: JOIN continuation lines until the closing ** is seen, so
  # the emitted key is wrap-independent — a line-based cut makes the frozen
  # key depend on where the source happens to wrap, and a pure re-wrap of
  # the bullet would then false-fire check 3; backend-database.md:89–90
  # closes its bold span on line 90 (#1243).
  printf '%s\n' "$in" \
    | awk '/^[-*] \*\*/{buf=$0; while (buf !~ /\*\*.*\*\*/ && (getline nx)>0) { sub(/^[[:space:]]+/,"",nx); buf=buf" "nx } print buf}' \
    | sed -E 's/^[-*][[:space:]]*\*\*//; s/\*\*.*//' | sed 's/[[:space:]]*$//'
} | sort -u
