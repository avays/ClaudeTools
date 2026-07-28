#!/usr/bin/env bash
# check-rule-budget.sh — enforce per-file + directory-total size budgets on
# {{PATHS_RULES_DIR}}/*.md so agent rule files don't regrow. Budgets live
# in {{PATHS_RULES_DIR}}/rule-budgets.json (per-file caps = post-rewrite size +15%;
# totalCap = sum of per-file caps, so the two constraints cannot disagree).
# /learn hard rule 6: if a file exceeds its cap, compress an existing lesson
# in that file rather than growing it; if the total exceeds the cap, compress
# the largest file over its own target. check-rule-preservation.sh is the
# companion gate proving a compression lost nothing.
set -euo pipefail
export LC_ALL=C
cd "$(git rev-parse --show-toplevel)"
budgets={{PATHS_RULES_DIR}}/rule-budgets.json
[ -r "$budgets" ] || { echo "MISSING $budgets — regenerate with \`ct render\`, or seed it by hand (per-file cap = current size +15%, totalCap = their sum)"; exit 2; }

# Node (already provisioned in the agent-instructions-sync CI job) reads the
# JSON; values passed via argv so filenames can't break the program text.
jsonget() { node -e 'const d=require(process.argv[1]); const k=process.argv[3]; const v=process.argv[2]==="totalCap"?d.totalCap:(Object.hasOwn(d.files,k)?d.files[k]:0); console.log(v)' "$PWD/$budgets" "$1" "${2:-}"; }

fail=0
total=0
for f in {{PATHS_RULES_DIR}}/*.md; do
  name=$(basename "$f" .md)
  size=$(wc -c < "$f")
  total=$((total + size))
  cap=$(jsonget files "$name")
  if [ "$cap" -eq 0 ]; then
    echo "NO BUDGET ENTRY for $name — add it to $budgets (new rule files get size at introduction +15%, added to totalCap too)"
    fail=1
    continue
  fi
  if [ "$size" -gt "$cap" ]; then
    echo "OVER BUDGET: $name is ${size} B > cap ${cap} B — compress an existing lesson in this file (see /learn hard rule 6)"
    fail=1
  fi
done

capTotal=$(jsonget totalCap)

# The budgets file's stated invariant — totalCap = sum of per-file caps — is
# enforced here so the two constraints can never silently disagree, and a cap
# entry for a deleted rule file is flagged rather than going stale.
node -e '
const d = require(process.argv[1]);
const fs = require("fs");
const sum = Object.values(d.files).reduce((a, b) => a + b, 0);
let bad = 0;
if (sum !== d.totalCap) { console.log(`BUDGET INVARIANT BROKEN: sum(files)=${sum} != totalCap=${d.totalCap} (delta ${sum - d.totalCap})`); bad = 1; }
for (const name of Object.keys(d.files)) {
  if (!fs.existsSync(`{{PATHS_RULES_DIR}}/${name}.md`)) { console.log(`STALE BUDGET ENTRY: ${name} has no matching {{PATHS_RULES_DIR}}/${name}.md`); bad = 1; }
}
process.exit(bad);
' "$PWD/$budgets" || fail=1

if [ "$total" -gt "$capTotal" ]; then
  echo "DIRECTORY TOTAL ${total} B > cap ${capTotal} B — compress the largest file over its own target"
  fail=1
fi

[ "$fail" -eq 0 ] && echo "OK: rules total ${total} B <= ${capTotal} B; every file within its cap"
exit "$fail"
