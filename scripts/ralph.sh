#!/usr/bin/env bash
#
# HOST-SPECIFIC COMMANDS. The gh invocations below are GitHub's, kept as-is
# because they are the ones that have been exercised in production. For a
# different tracker, replace the lock helpers' bodies with your config's
# TRACKER_LOCK_ACQUIRE / TRACKER_LOCK_RELEASE / TRACKER_LOCK_QUERY commands.
# The contract they implement is host-independent: acquire before the status
# move, release on EVERY exit path including the trap, and never auto-clear
# a stale lock (surface it instead).
#
# NOTE ON ATOMICITY: this loop's parallel-safety assumes the lock acquire is
# atomic. GitHub labels are; a JIRA label edit is NOT (read-modify-write).
# See templates/trackers/jira/profile.json notes before running a fleet.
#
# Ralph loop — headless Claude running /board in a continuous drain over the
# {{TRACKER_BOARD_NAME}}. Each iteration spawns a fresh Claude process,
# picks the furthest-progressed issue in an actionable status, runs one
# /board step, exits. Repeat until the board has nothing actionable.
#
# Uses `--dangerously-skip-permissions` so agent work isn't blocked waiting
# for prompts. The /board skill already runs each agent in an isolated git
# worktree and pushes after every commit, so crashes don't strand work.
#
# Usage:
#   scripts/ralph.sh                                        # drain the board forever
#   scripts/ralph.sh --dry-run                              # show picks, never invoke claude
#   scripts/ralph.sh --max 5                                # cap iterations
#   scripts/ralph.sh --once                                 # one iteration then exit
#   scripts/ralph.sh --issue 520                            # pin to one issue, skip board polling
#   scripts/ralph.sh --issue 505 --audit-passes 2 --pr 508  # audit→fix→audit on PR #508's branch
#   scripts/ralph.sh --issue 505 --audit-passes 2 --branch feature/foo
#                                                           # same, with explicit branch
#   scripts/ralph.sh --issue 520 --audit-passes 2 --no-worktree
#                                                           # audit in cwd (legacy behavior)
#   scripts/ralph.sh --sleep 30                             # sleep between iterations
#   scripts/ralph.sh --empty-sleep 600                      # sleep when board is empty
#   scripts/ralph.sh --log /tmp/r.log                       # custom log path
#
# Audit mode:
#   --audit-passes N runs N audit passes with (N-1) fix passes between them.
#   N=2 matches the "audit → fix → audit before PR" rule. Requires --issue.
#
#   Runs in an isolated git worktree by default, at
#   .claude/worktrees/ralph-ISSUE-PID/. Target branch must be specified via
#   --branch BRANCH or --pr PR_NUMBER (PR head ref is resolved via `gh`).
#   The worktree is kept after the run so you can inspect the commits;
#   remove with `git worktree remove <path>`. Pass --no-worktree to run
#   in the current working directory instead (legacy behavior — branch
#   = whatever you have checked out).
#
#   Findings are written to .ai/audit-findings/issue-ID-pass-K.md in the
#   main repo (not the worktree), so they survive worktree removal.
#
# Stop mid-run:
#   touch .ralph-stop                                       # graceful stop after current iter
#   Ctrl-C                                                  # hard stop
#
# Requires: gh (authed), jq, claude CLI in PATH.

set -euo pipefail

# --- Config / constants (mirror {{PATHS_CONTEXT_DIR}}/PROJECT_BOARD.md) ----------------

readonly PROJECT_OWNER="{{VCS_REPO_SLUG}}"
readonly PROJECT_NUMBER=1

# Statuses ordered furthest-progressed first. Ralph drains near-done work
# before picking up fresh refinement, to keep WIP low.
# "Ready for PR" removed — it does not exist on {{TRACKER_BOARD_NAME}};
# Context Complete is the pre-PR gate and the pr step runs from there.
readonly ACTIONABLE_STATUSES=(
  "Ready for Context"
  "Ready for Tests"
  "Ready for Code"
  "Ready for Spec"
  "Ready for Refinement"
)

readonly STOP_FILE=".ralph-stop"
readonly LOCK_FILE="/tmp/ralph-$(id -u).lock"
readonly DEFAULT_LOG="./ralph.log"

# --- Defaults ----------------------------------------------------------------

dry_run=0
once=0
max_iters=0          # 0 = unlimited
sleep_secs=60
empty_sleep_secs=300
pin_issue=""
audit_passes=0
target_branch=""
target_pr=""
no_worktree=0
log_path="$DEFAULT_LOG"
model_flag=""

# --- Args --------------------------------------------------------------------

usage() {
  sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while (($#)); do
  case "$1" in
    -n|--dry-run)     dry_run=1; shift ;;
    --once)           once=1; shift ;;
    -m|--max)         max_iters="$2"; shift 2 ;;
    --sleep)          sleep_secs="$2"; shift 2 ;;
    --empty-sleep)    empty_sleep_secs="$2"; shift 2 ;;
    --issue)          pin_issue="$2"; shift 2 ;;
    --audit-passes)   audit_passes="$2"; shift 2 ;;
    --branch)         target_branch="$2"; shift 2 ;;
    --pr)             target_pr="$2"; shift 2 ;;
    --no-worktree)    no_worktree=1; shift ;;
    --log)            log_path="$2"; shift 2 ;;
    --model)          model_flag="--model $2"; shift 2 ;;
    -h|--help)        usage 0 ;;
    *)                echo "unknown arg: $1" >&2; usage 1 ;;
  esac
done

# --- Helpers -----------------------------------------------------------------

log() {
  local msg="[$(date -u +%FT%TZ)] $*"
  echo "$msg" >&2
  echo "$msg" >>"$log_path"
}

# Tracks the issue currently holding an agent:in-progress lock acquired by
# this process. Set by acquire_issue_lock, cleared by release_issue_lock.
# The EXIT trap reads this to release a stranded lock on Ctrl-C or crash.
held_issue=""

cleanup() {
  # Best-effort: release any in-flight issue lock so a Ctrl-C / crash
  # doesn't strand the issue as unpickable. If gh isn't available or the
  # call fails, the operator can recover manually per
  # {{PATHS_RULES_DIR}}/workflow.md "Stale lock recovery". Skip the real API
  # call in dry-run — acquire_issue_lock didn't actually set the label,
  # so removing it would violate dry-run semantics (real mutation to
  # GitHub state).
  if [[ -n "$held_issue" ]]; then
    if ((dry_run)); then
      log "cleanup: DRY-RUN — would release lock on issue #$held_issue (no API call)"
    else
      log "cleanup: releasing stranded lock on issue #$held_issue"
      gh issue edit "$held_issue" --repo "$GH_REPO" --remove-label "$RALPH_LOCK_LABEL" >/dev/null 2>&1 || \
        log "cleanup: failed to release lock on #$held_issue (manual cleanup: gh issue edit $held_issue --repo $GH_REPO --remove-label '$RALPH_LOCK_LABEL')"
    fi
    held_issue=""
  fi
  rm -f "$LOCK_FILE"
  log "ralph: exiting"
}
trap cleanup EXIT
trap 'log "ralph: interrupted"; exit 130' INT TERM

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 2; }
}

# Query the board once, return the top-priority actionable issue number,
# or empty string if nothing is actionable.
pick_next_issue() {
  # Paginate the full board: items(first:100) alone silently missed newer
  # issues once the board passed 100 items (it has 300+). Accumulate every
  # page's nodes into one JSON array, then filter as before.
  local nodes="[]" cursor="null" page has_next
  while :; do
    page=$(gh api graphql -f query="
      query {
        organization(login: \"$PROJECT_OWNER\") {
          projectV2(number: $PROJECT_NUMBER) {
            items(first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                fieldValueByName(name: \"Status\") {
                  ... on ProjectV2ItemFieldSingleSelectValue { name }
                }
                content {
                  ... on Issue {
                    number
                    state
                    labels(first: 20) { nodes { name } }
                  }
                }
              }
            }
          }
        }
      }" 2>/dev/null) || return 1
    nodes=$(jq -c --argjson acc "$nodes" '$acc + .data.organization.projectV2.items.nodes' <<<"$page")
    has_next=$(jq -r '.data.organization.projectV2.items.pageInfo.hasNextPage' <<<"$page")
    [[ "$has_next" == "true" ]] || break
    cursor="\"$(jq -r '.data.organization.projectV2.items.pageInfo.endCursor' <<<"$page")\""
  done
  local json
  json=$(jq -c '{data:{organization:{projectV2:{items:{nodes:.}}}}}' <<<"$nodes")

  # Skip issues that are closed OR carry an agent:* label (in-progress /
  # awaiting-input / errored — human needs to unblock).
  for status in "${ACTIONABLE_STATUSES[@]}"; do
    local pick
    pick=$(jq -r --arg s "$status" '
      .data.organization.projectV2.items.nodes[]
      | select(.content != null)
      | select(.content.state == "OPEN")
      | select(.fieldValueByName.name == $s)
      | select((.content.labels.nodes | map(.name) | map(startswith("agent:")) | any) | not)
      | .content.number
    ' <<<"$json" | head -n1)
    if [[ -n "$pick" ]]; then
      echo "$pick|$status"
      return 0
    fi
  done
  echo ""
}

run_claude() {
  local label="$1" prompt="$2" model_override="${3:-}"
  if ((dry_run)); then
    log "DRY-RUN [$label]: claude -p${model_override:+ --model $model_override} \"${prompt:0:120}$([ ${#prompt} -gt 120 ] && echo '...')\""
    return 0
  fi
  log "invoking claude: $label${model_override:+ (model=$model_override)}"
  # Per-call model override wins over the global --model flag.
  local effective_model_flag="$model_flag"
  if [[ -n "$model_override" ]]; then
    effective_model_flag="--model $model_override"
  fi
  # stream-json keeps the log parseable; tee so we still see a heartbeat.
  if ! claude \
        -p "$prompt" \
        --dangerously-skip-permissions \
        --output-format stream-json \
        --verbose \
        ${effective_model_flag} \
        2>&1 | tee -a "$log_path"; then
    log "claude exited non-zero [$label]"
    return 1
  fi
  return 0
}

run_board_once() {
  run_claude "board #$1" "/board $1"
}

# --- Agent lock helpers ------------------------------------------------------
#
# Drain mode coordinates concurrent Ralph workers via the `agent:in-progress`
# label. The window between pick_next_issue and the /board call is the race
# we close: without the lock, two Ralphs that query the board within a few
# seconds of each other both pick the same issue.
#
# board-runner adds a more specific `agent:<step>` label inside its own flow;
# Ralph's generic `agent:in-progress` is the outer fence. Both are filtered
# by pick_next_issue (any agent:* label = skip).
#
# Lock contract documented in {{PATHS_RULES_DIR}}/workflow.md "Agent Locking".

readonly RALPH_LOCK_LABEL="agent:in-progress"
readonly GH_REPO="{{VCS_REPO_SLUG}}"

acquire_issue_lock() {
  local issue="$1"
  ((dry_run)) && { log "DRY-RUN: would add label '$RALPH_LOCK_LABEL' to issue #$issue"; held_issue="$issue"; return 0; }
  log "acquiring lock on issue #$issue (label: $RALPH_LOCK_LABEL)"
  if ! gh issue edit "$issue" --repo "$GH_REPO" --add-label "$RALPH_LOCK_LABEL" >>"$log_path" 2>&1; then
    log "warning: failed to add lock label on issue #$issue (continuing — board-runner will set its own)"
    return 1
  fi
  held_issue="$issue"
  return 0
}

release_issue_lock() {
  local issue="$1"
  ((dry_run)) && { log "DRY-RUN: would remove label '$RALPH_LOCK_LABEL' from issue #$issue"; held_issue=""; return 0; }
  log "releasing lock on issue #$issue"
  if ! gh issue edit "$issue" --repo "$GH_REPO" --remove-label "$RALPH_LOCK_LABEL" >>"$log_path" 2>&1; then
    log "warning: failed to remove lock label on issue #$issue — may need manual cleanup"
    log "         gh issue edit $issue --repo $GH_REPO --remove-label '$RALPH_LOCK_LABEL'"
    # Leave held_issue set so the EXIT trap retries.
    return 1
  fi
  held_issue=""
  return 0
}

# True if cwd is inside a linked git worktree (not the main checkout).
# In a linked worktree, .git is a file; in the main repo, it's a directory.
is_linked_worktree() {
  [[ -f .git ]]
}

# Resolve the target branch for audit mode from --branch or --pr.
# Echoes the branch name on stdout on success.
resolve_target_branch() {
  if [[ -n "$target_branch" ]]; then
    echo "$target_branch"
    return 0
  fi
  if [[ -n "$target_pr" ]]; then
    local branch
    branch=$(gh pr view "$target_pr" --repo {{VCS_REPO_SLUG}} \
              --json headRefName -q .headRefName 2>/dev/null) || return 1
    if [[ -z "$branch" || "$branch" == "null" ]]; then
      log "error: PR #$target_pr has no headRefName"
      return 1
    fi
    echo "$branch"
    return 0
  fi
  return 1
}

# Resolve the BASE branch for audit mode (the branch this PR targets). Used
# to anchor `git diff` so the auditor and line-reviewer compare against the
# PR's actual base, not always main. The project's release flow is
# feature/* → staging → main, so PRs frequently target staging — comparing
# against origin/main would surface the staging→main delta as noise.
#
# Echoes the base branch on stdout. Defaults to "main" if no PR is given
# (matches the prior hardcoded behavior for --branch-only runs).
resolve_base_branch() {
  if [[ -n "$target_pr" ]]; then
    local base
    base=$(gh pr view "$target_pr" --repo {{VCS_REPO_SLUG}} \
            --json baseRefName -q .baseRefName 2>/dev/null) || { echo "main"; return 0; }
    if [[ -z "$base" || "$base" == "null" ]]; then
      echo "main"
      return 0
    fi
    echo "$base"
    return 0
  fi
  echo "main"
  return 0
}

# Create an isolated git worktree for audit mode. Echoes the worktree path
# on stdout on success. Fails if the branch is already checked out elsewhere.
setup_audit_worktree() {
  local branch="$1" issue="$2" repo_root="$3"

  local existing_path
  existing_path=$(git worktree list --porcelain | awk -v b="refs/heads/$branch" '
    $1=="worktree" { wt=$2 }
    $1=="branch" && $2==b { print wt; exit }
  ')
  if [[ -n "$existing_path" ]]; then
    log "error: branch '$branch' is already checked out at $existing_path"
    log "       switch that worktree off the branch first, or use --no-worktree"
    return 1
  fi

  log "fetching origin/$branch"
  if ! git fetch origin "$branch" >>"$log_path" 2>&1; then
    log "failed to fetch origin/$branch"
    return 1
  fi

  local wt_path="$repo_root/.claude/worktrees/ralph-${issue}-$$"
  mkdir -p "$(dirname "$wt_path")"

  log "creating worktree: $wt_path ← $branch"
  if git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null 2>&1; then
    if ! git worktree add "$wt_path" "$branch" >>"$log_path" 2>&1; then
      log "failed: git worktree add $wt_path $branch"
      return 1
    fi
    # Fast-forward to origin/$branch so we start from the latest pushed state.
    if ! (cd "$wt_path" && git merge --ff-only "origin/$branch" >>"$log_path" 2>&1); then
      log "warning: could not fast-forward $branch to origin/$branch — continuing with local tip"
    fi
  else
    if ! git worktree add --track -b "$branch" "$wt_path" "origin/$branch" >>"$log_path" 2>&1; then
      log "failed: git worktree add --track -b $branch"
      return 1
    fi
  fi

  echo "$wt_path"
}

# Audit loop: N audits interleaved with (N-1) fix passes.
# Runs inside $worktree_path if given, otherwise in $PWD. Findings are always
# written to the main repo's .ai/audit-findings/ (absolute path) so they
# survive worktree cleanup.
run_audit_loop() {
  local issue="$1" passes="$2" worktree_path="${3:-}" repo_root="$4" branch_override="${5:-}" base_branch="${6:-main}"
  local findings_dir="$repo_root/.ai/audit-findings"
  mkdir -p "$findings_dir"

  if [[ -n "$worktree_path" ]]; then
    if ! cd "$worktree_path"; then
      log "failed to cd into worktree $worktree_path"
      return 1
    fi
  fi

  local branch
  if [[ -n "$branch_override" ]]; then
    branch="$branch_override"
  else
    branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  fi
  if [[ -n "$worktree_path" ]]; then
    log "audit mode: issue #$issue, $passes pass(es), branch=$branch (base=$base_branch), worktree=$worktree_path"
  else
    log "audit mode: issue #$issue, $passes pass(es), branch=$branch (base=$base_branch) (no worktree)"
  fi
  if [[ "$branch" == "main" || "$branch" == "master" ]]; then
    log "WARNING: running audit mode on $branch — expected a feature branch"
  fi

  # Make sure the base branch is fetched so origin/$base_branch is current.
  # The line-reviewer and auditor both diff against this ref.
  if ((dry_run == 0)); then
    git fetch origin "$base_branch" >>"$log_path" 2>&1 || \
      log "warning: failed to fetch origin/$base_branch — diff may be stale"
  fi

  local worktree_note=""
  if [[ -n "$worktree_path" ]]; then
    worktree_note="You are running in a git worktree at ${worktree_path} on branch ${branch}. "
    worktree_note+="The worktree is ephemeral — commits MUST be pushed to origin/${branch} or they will be lost. "
  fi

  local pass
  for ((pass=1; pass<=passes; pass++)); do
    [[ -e "$repo_root/$STOP_FILE" ]] && { log "stop file found, halting audit loop"; rm -f "$repo_root/$STOP_FILE"; return 0; }

    # Each pass runs TWO reviewers in series, writing to distinct findings files:
    #   * auditor   (Sonnet, spec + architecture + 5 dimensions)  → issue-N-pass-K.md
    #   * line-reviewer (Opus, diff line-by-line + Copilot-style) → issue-N-pass-K-line.md
    # The pass is considered "clean" iff BOTH files say "No findings." Otherwise
    # the fix pass that follows consumes the union of findings from both files.
    local findings_file="$findings_dir/issue-${issue}-pass-${pass}.md"
    local line_findings_file="$findings_dir/issue-${issue}-pass-${pass}-line.md"
    log "audit pass $pass/$passes → $findings_file"

    local audit_prompt
    audit_prompt="${worktree_note}"
    audit_prompt+="Run the /audit-phase skill for GitHub issue #${issue} on the current branch (${branch}). "
    audit_prompt+="Locate the spec at {{PATHS_SPECS_DIR}}/ (match by issue number or feature name). "
    audit_prompt+="Examine only files changed on this branch vs origin/${base_branch} "
    audit_prompt+="(this PR's target branch — use 'git diff origin/${base_branch}...HEAD' to scope the diff). "
    audit_prompt+="Apply every rule in {{PATHS_RULES_DIR}}/*.md and every pitfall in {{PATHS_AGENTS_DIR}}/auditor.md. "
    audit_prompt+="Write EVERY finding (CRITICAL, HIGH, MEDIUM, LOW) to the ABSOLUTE path ${findings_file} "
    audit_prompt+="with concrete file:line references and prescribed fixes. If there are no findings, "
    audit_prompt+="write exactly 'No findings.' as the file contents. Do NOT modify any source code. "
    audit_prompt+="Do NOT commit. This is pass ${pass} of ${passes}."

    if ! run_claude "audit pass $pass/$passes" "$audit_prompt"; then
      log "audit pass $pass failed — aborting audit loop"
      return 1
    fi

    log "line-review pass $pass/$passes → $line_findings_file (opus)"

    local line_review_prompt
    line_review_prompt="${worktree_note}"
    line_review_prompt+="Read {{PATHS_AGENTS_DIR}}/line-reviewer.md and follow its instructions exactly. "
    line_review_prompt+="You are the line-reviewer agent: a Copilot-style line-by-line diff reviewer that "
    line_review_prompt+="complements the architectural auditor. Get the diff with 'git diff origin/${base_branch}...HEAD' "
    line_review_prompt+="on the current branch (${branch}) — base branch is '${base_branch}' (the PR's target). "
    line_review_prompt+="Walk every changed hunk; flag every concern "
    line_review_prompt+="(CRITICAL, HIGH, MEDIUM, LOW — LOW findings are welcome). Cross-check against "
    line_review_prompt+="{{PATHS_RULES_DIR}}/frontend-components.md 'Recurring correctness rules'. "
    line_review_prompt+="If ${findings_file} exists, read it first and DO NOT duplicate findings it already lists. "
    line_review_prompt+="Write findings to the ABSOLUTE path ${line_findings_file} using the format in "
    line_review_prompt+="{{PATHS_AGENTS_DIR}}/line-reviewer.md. If there are no findings after a thorough walk, "
    line_review_prompt+="write exactly 'No findings.' as the file contents. Do NOT modify any source code. "
    line_review_prompt+="Do NOT commit. This is line-review pass ${pass} of ${passes}."

    if ! run_claude "line-review pass $pass/$passes" "$line_review_prompt" "opus"; then
      log "line-review pass $pass failed — aborting audit loop"
      return 1
    fi

    # Short-circuit: both findings files must be clean for the pass to be considered clean.
    if ((dry_run == 0)); then
      local auditor_clean=0
      local line_clean=0
      [[ -f "$findings_file" ]] && grep -qE '^No findings\.?\s*$' "$findings_file" && auditor_clean=1
      [[ -f "$line_findings_file" ]] && grep -qE '^No findings\.?\s*$' "$line_findings_file" && line_clean=1
      if ((auditor_clean && line_clean)); then
        log "audit pass $pass: both reviewers reported no findings — audit loop complete"
        return 0
      fi
      if ((auditor_clean)); then
        log "audit pass $pass: auditor clean, line-reviewer has findings — continuing to fix pass"
      elif ((line_clean)); then
        log "audit pass $pass: line-reviewer clean, auditor has findings — continuing to fix pass"
      else
        log "audit pass $pass: both reviewers have findings — continuing to fix pass"
      fi
    fi

    # No fix pass after the final audit — the last audit is the verification.
    if ((pass < passes)); then
      [[ -e "$repo_root/$STOP_FILE" ]] && { log "stop file found, halting audit loop"; rm -f "$repo_root/$STOP_FILE"; return 0; }
      log "fix pass $pass (responding to $findings_file + $line_findings_file)"

      local fix_prompt
      fix_prompt="${worktree_note}"
      fix_prompt+="Read BOTH findings files: ${findings_file} (architectural auditor) and "
      fix_prompt+="${line_findings_file} (line-by-line reviewer). Implement the prescribed fix for EVERY "
      fix_prompt+="finding in both files (CRITICAL, HIGH, MEDIUM, and LOW — severity orders work, it does "
      fix_prompt+="not license deferral). If a file contains only 'No findings.', skip it. "
      fix_prompt+="If the two files list the same issue, fix it once and note the dedup. "
      fix_prompt+="Follow {{PATHS_RULES_DIR}}/*.md for conventions. Comment hygiene (#843): source comments and test "
      fix_prompt+="names cite an issue anchor (#${issue}) plus a plain-English rationale ONLY — NEVER audit-pass/"
      fix_prompt+="fix-pass/finding-code metadata like '(audit pass 1, LOW #3)' or 'line-review #1'; the arch test "
      fix_prompt+="no-agent-iteration-comments.test.ts fails CI on these, run it before your final push. "
      fix_prompt+="After fixing, sweep your own blast radius: if a fix changed behavior or method names, grep "
      fix_prompt+="{{PATHS_CONTEXT_DIR}}/ for the symbols you touched and update stale doc mentions; if a fix removed an "
      fix_prompt+="assignment or branch, re-read the surrounding function for now-dead conditionals. "
      fix_prompt+="Commit incrementally with descriptive "
      fix_prompt+="messages referencing issue #${issue}. After each commit run '{{PKG_BUILD}}' "
      fix_prompt+="then '{{PKG_TYPECHECK}}'. Push to origin/${branch} after EACH commit "
      fix_prompt+="(the worktree is ephemeral). Do NOT open a PR, do NOT change board status. "
      fix_prompt+="This is fix pass ${pass} of $((passes-1))."

      if ! run_claude "fix pass $pass" "$fix_prompt"; then
        log "fix pass $pass failed — aborting audit loop"
        return 1
      fi
    fi
  done

  log "audit loop complete ($passes passes)"
  return 0
}

# --- Preflight ---------------------------------------------------------------

require_cmd gh
require_cmd claude
# jq is only needed for board polling; audit mode doesn't touch the board.
if ((audit_passes == 0)); then
  require_cmd jq
fi

if [[ -e "$LOCK_FILE" ]]; then
  pid=$(cat "$LOCK_FILE" 2>/dev/null || true)
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "another ralph is running (pid $pid). rm $LOCK_FILE if stale." >&2
    exit 3
  fi
fi
echo "$$" >"$LOCK_FILE"

gh auth status >/dev/null 2>&1 || { echo "gh not authenticated" >&2; exit 4; }

# --- Repo root -------------------------------------------------------------

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "not inside a git repository" >&2
  exit 6
}
readonly REPO_ROOT

# --- Audit mode short-circuit -----------------------------------------------

if ((audit_passes > 0)); then
  if [[ -z "$pin_issue" ]]; then
    echo "--audit-passes requires --issue ISSUE_NUM" >&2
    exit 5
  fi
  if ((audit_passes < 1)); then
    echo "--audit-passes must be >= 1" >&2
    exit 5
  fi

  # Resolve the PR's base branch (the target of the PR) so the reviewers
  # diff against the right ref. Defaults to "main" if no --pr is given.
  base_branch=$(resolve_base_branch)

  worktree_path=""
  if ((no_worktree == 0)); then
    branch=$(resolve_target_branch) || {
      echo "--audit-passes requires --branch BRANCH or --pr PR_NUMBER (or pass --no-worktree to run in cwd)" >&2
      exit 5
    }
    log "ralph: start AUDIT MODE (dry-run=$dry_run issue=$pin_issue passes=$audit_passes branch=$branch base=$base_branch worktree=on)"
    if ((dry_run)); then
      log "DRY-RUN: would create worktree for '$branch' at $REPO_ROOT/.claude/worktrees/ralph-${pin_issue}-$$"
      worktree_path=""  # skip cd in dry-run; stays in cwd
      branch_override="$branch"
    else
      worktree_path=$(setup_audit_worktree "$branch" "$pin_issue" "$REPO_ROOT") || {
        log "worktree setup failed"
        exit 7
      }
      branch_override=""
    fi
  else
    log "ralph: start AUDIT MODE (dry-run=$dry_run issue=$pin_issue passes=$audit_passes base=$base_branch worktree=off)"
    branch_override=""
  fi

  run_audit_loop "$pin_issue" "$audit_passes" "$worktree_path" "$REPO_ROOT" "$branch_override" "$base_branch"
  rc=$?
  if [[ -n "$worktree_path" ]]; then
    log "audit worktree kept at $worktree_path"
    log "remove with: git worktree remove $worktree_path"
  fi
  exit $rc
fi

# Drain mode sanity check: /board handles its own worktrees, but if ralph
# itself is being run from a linked worktree, warn — it likely means the
# user cd'd into a worktree by mistake and runs will be scoped to that
# worktree's branch context.
if is_linked_worktree; then
  log "WARNING: ralph is running from a linked git worktree ($PWD)."
  log "         /board will still worktree its sub-agents correctly, but you likely"
  log "         meant to run from the main repo checkout. Continuing anyway."
fi

log "ralph: start (dry-run=$dry_run once=$once max=$max_iters sleep=${sleep_secs}s empty-sleep=${empty_sleep_secs}s pin=${pin_issue:-none})"

# --- Main loop ---------------------------------------------------------------

iter=0
last_issue=""
consecutive_same=0

while :; do
  if [[ -e "$STOP_FILE" ]]; then
    log "stop file found ($STOP_FILE), exiting"
    rm -f "$STOP_FILE"
    break
  fi

  iter=$((iter + 1))
  if ((max_iters > 0 && iter > max_iters)); then
    log "hit --max $max_iters, exiting"
    break
  fi

  log "iteration $iter"

  if [[ -n "$pin_issue" ]]; then
    issue="$pin_issue"
    status="pinned"
  else
    pick=$(pick_next_issue || true)
    if [[ -z "$pick" ]]; then
      log "board empty — sleeping ${empty_sleep_secs}s"
      ((once)) && break
      sleep "$empty_sleep_secs"
      continue
    fi
    issue="${pick%%|*}"
    status="${pick##*|}"
  fi

  # Same issue three iterations in a row without advancing = stuck. Back off
  # hard so a wedged issue doesn't burn the whole budget.
  if [[ "$issue" == "$last_issue" ]]; then
    consecutive_same=$((consecutive_same + 1))
  else
    consecutive_same=1
    last_issue="$issue"
  fi
  if ((consecutive_same >= 3)); then
    log "issue #$issue stuck in '$status' for $consecutive_same iters — sleeping ${empty_sleep_secs}s"
    ((once)) && break
    sleep "$empty_sleep_secs"
    consecutive_same=0
    continue
  fi

  log "picked issue #$issue (status: $status)"

  # Acquire the working lock BEFORE invoking /board, so a concurrent Ralph
  # querying the board between this iteration's pick and the /board call
  # filters this issue out via pick_next_issue's agent:* exclusion.
  acquire_issue_lock "$issue" || true   # best-effort — board-runner sets its own per-step lock too

  if ! run_board_once "$issue"; then
    log "board run failed, backing off ${empty_sleep_secs}s"
    # Release the lock even on failure — the issue should be re-pickable
    # next iteration. Never auto-clear agent:awaiting-input / agent:error
    # (release_issue_lock only touches agent:in-progress).
    release_issue_lock "$issue" || true
    ((once)) && break
    sleep "$empty_sleep_secs"
    continue
  fi

  # Release the generic lock on success. board-runner manages its own
  # per-step lock label inside its flow; this only clears Ralph's outer fence.
  release_issue_lock "$issue" || true

  ((once)) && { log "--once set, exiting"; break; }
  log "sleeping ${sleep_secs}s before next iteration"
  sleep "$sleep_secs"
done
