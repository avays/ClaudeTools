# The rule-governance system

Why it exists, what each gate proves, and how to operate it.

## The problem

An agent's rule files are written by accretion. Every review cycle surfaces a
lesson; the lesson gets written down; nothing is ever removed. This is correct
behaviour locally and catastrophic globally:

- **Prompt budget.** Automated PR reviewers have a hard prompt ceiling shared
  between your instructions and the diff. Past a certain size, large PRs stop
  being reviewed at all — the reviewer fails rather than truncating, so the
  symptom is "review didn't run", not "review was worse".
- **Signal dilution.** A 46 KB conventions file is one an agent skims.
- **The cleanup trap.** Eventually someone shrinks the files. Without a gate,
  a well-meant "tighten the prose" commit deletes the one sentence that
  encoded three review rounds of hard-won knowledge, and nobody notices for
  months.

Budgets alone cause the third problem. Preservation alone permits the first.
You need both, and they have to disagree with each other productively:
**the budget says "get smaller", the preservation gate says "not by losing
anything".** The only way to satisfy both is genuine compression.

## The three gates

### `check-rule-budget.sh` — regrowth

Reads `<rules>/rule-budgets.json`: a per-file byte cap plus `totalCap`.

Enforced invariants:
- Every rule file has a budget entry (a file with none fails — no silent
  exemption by omission).
- Every budget entry has a rule file (a stale entry for a deleted rule fails).
- `totalCap == sum(files)`, so the per-file and directory-total constraints
  can never quietly disagree.
- No file over its own cap; directory total under `totalCap`.

Adding a rule file means adding its entry at introduction size +15% **and**
adding the same amount to `totalCap`. `ct render` generates the whole file, so
this only comes up when you author a rule by hand afterwards.

### `check-rule-preservation.sh` — silent fact loss

Runs only on files that **shrank**, comparing against a base commit. Five
checks:

1. **Precedent refs** — issue/PR numbers cited in the file.
2. **Command content** — fenced blocks and inline commands.
3. **Frozen headings** — headings other files cite by exact text.
4. **Operational-fact census** — backticked paths, filenames, identifiers.
5. **Modal density** — the count of MUST/NEVER/ALWAYS-class words.

The fifth is the subtle one: prose can be "tightened" in a way that preserves
every fact while quietly downgrading a MUST to a "should". Counting modals
catches a rewrite that keeps the words and loses the force.

**It must not fire on a benign reflow.** `extract-rule-headings.sh` joins
wrapped bullet leads before extracting, so a key is wrap-independent — without
that, re-wrapping a paragraph changes the extracted heading and the gate
false-fires. A gate that cries wolf gets disabled, so this property is
load-bearing and is covered by the acceptance test below.

**Escape hatch.** A genuinely-intended fact removal opts out with a commit
trailer on a commit touching the file:

```
preservation-override: workflow — the BullMQ chain moved to docs/examples/
```

Visible in history, greppable, and requires stating a reason.

### `build-frozen-headings.sh` — dangling citations

Scans agents, skills, scripts, and your source corpus for text that cites a
rule heading by name, and writes the cited headings to `.frozen-headings.txt`.
Renaming one without updating its citers then fails check 3.

Two details worth knowing:

- It reads **tracked** files (`git ls-files`), so it produces nothing until
  your first commit. `ct render` runs it and reports if it was skipped.
- The citation corpus includes `{{PATHS_SRC_GLOBS}}` — headings cited in source
  comments count. Set that to your real first-party source globs or those
  citations go untracked.

## Operating it

### Normal flow

Add a lesson to a rule file. If the file is now over budget, you do **not**
raise the cap — you compress an existing lesson in that same file. This is the
policy `/learn` hard rule 6 encodes, and it is what keeps total size flat while
knowledge still accumulates: each new lesson displaces the least-load-bearing
existing prose rather than appending.

### Rebaselining after a deliberate rewrite

After an intentional editorial pass that legitimately shrinks files:

```bash
ct render --target . --force     # regenerates budgets from new sizes
bash scripts/build-frozen-headings.sh
git commit -m "chore: rebaseline rule budgets after editorial pass

preservation-override: <file> — <why the removed facts were removable>"
```

### CI

`templates/ci/github-actions/agent-instructions-sync.yml` wires all three.
Note `fetch-depth: 0` — the preservation gate diffs against the merge base, and
a shallow clone makes it silently unable to find it.

## Acceptance test

Run these against a rendered repo to confirm the system is live. All four must
behave as shown:

```bash
BASE=$(git rev-parse HEAD)

# 1. regrowth is caught
head -c 40000 /dev/urandom | base64 >> .claude/rules/workflow.md
bash scripts/check-rule-budget.sh          # expect: OVER BUDGET, exit 1
git checkout .claude/rules/workflow.md

# 2. a renamed frozen heading is caught
sed -i 's/^## Agent Locking.*/## Locking stuff/' .claude/rules/workflow.md
bash scripts/check-rule-preservation.sh workflow "$BASE"   # expect: LOST FROZEN HEADING(S)
git checkout .claude/rules/workflow.md

# 3. silent body deletion is caught
python3 -c "import pathlib;p=pathlib.Path('.claude/rules/workflow.md');L=p.read_text().split(chr(10));del L[40:75];p.write_text(chr(10).join(L))"
bash scripts/check-rule-preservation.sh workflow "$BASE"   # expect: LOST REFS / LOST FACTS
git checkout .claude/rules/workflow.md

# 4. a pure re-wrap does NOT fire  <-- the one that matters
#    (reflow prose paragraphs to a different width, then:)
bash scripts/check-rule-preservation.sh workflow "$BASE"   # expect: OK, exit 0
```

If 4 fails, the heading extractor has become wrap-dependent — fix that before
anything else, because a false-firing gate is worse than no gate.
