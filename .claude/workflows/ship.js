export const meta = {
  name: 'ship',
  description: 'Issue → spec → spec-audit loop → implement+tests → ralph code-audit loop → context update → draft PR → Copilot-feedback loop → learn → ready + CI gate',
  whenToUse: 'Drive a GitHub issue end-to-end to a merge-ready PR (with Copilot review rounds auto-resolved) as one deterministic pipeline. args: { issue: <number>, pr?: boolean (default true), light?: boolean (force-skip the sonnet pre-grinds; they auto-skip when the spec is <300 lines / the diff is <150 changed lines), maxAuditRounds?: number (default 5, per grind stage), maxCopilotRounds?: number (default 10), copilotWaitSeconds?: number (default 600), maxCiRounds?: number (default 3), dryRun?: boolean }',
  phases: [
    { title: 'Setup', detail: 'fetch issue, acquire agent:in-progress lock, create an isolated worktree + feature branch', model: 'haiku' },
    { title: 'Spec', detail: 'spec-writer drafts {{PATHS_SPECS_DIR}}/<slug>.md per /create-spec', model: 'fable' },
    { title: 'Spec Audit', detail: 'two grinds in sequence: sonnet grind (skipped for short specs) to convergence, then opus grind to convergence (sole exit); reviser on opus', model: 'opus' },
    { title: 'Implement', detail: 'developer builds + tests to satisfy the spec' },
    { title: 'Code Audit', detail: 'ralph loop, two grinds: sonnet (skipped for small diffs) then opus; two-lens on first + certifying rounds, combined between — exits only on a clean opus two-lens pass', model: 'opus' },
    { title: 'Context', detail: 'update-context + update-progress via context-updater' },
    { title: 'PR', detail: 'pr-creator opens a DRAFT PR (drafts skip CI, #1231) + dispatches one CI/security smoke run against the branch' },
    { title: 'Copilot Loop', detail: 'after each push: wait ~10 min for Copilot review, resolve feedback, repeat until a round finds no new threads (drafts get Copilot but no CI)', model: 'opus' },
    { title: 'Learn', detail: 'harvest the review cycle, encode recurrence-class lessons into rules/skills, push to the PR' },
    { title: 'CI Gate', detail: 'mark the draft ready (ready_for_review fires the merge-ref CI+security run), then loop: watch checks → fix failures → the fix push re-triggers both CI and Copilot → re-converge both', model: 'opus' },
  ],
}

// ─── args ────────────────────────────────────────────────────────────────
// Accept: {issue: 1129, ...}, a bare number, "1129", or a JSON-encoded string.
let raw = args
if (typeof raw === 'string') {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    try { raw = JSON.parse(trimmed) } catch { /* fall through */ }
  } else if (/^#?\d+$/.test(trimmed)) {
    raw = { issue: Number(trimmed.replace('#', '')) }
  }
}
const input = typeof raw === 'object' && raw !== null ? raw : { issue: raw }
const issue = Number(input.issue)
if (!Number.isInteger(issue) || issue <= 0) {
  throw new Error('ship workflow: pass args {issue: <GitHub issue number>} (e.g. {issue: 1130})')
}
const openPr = input.pr !== false
const MAX_AUDIT_ROUNDS = Number(input.maxAuditRounds) > 0 ? Number(input.maxAuditRounds) : 5
const MAX_COPILOT_ROUNDS = Number(input.maxCopilotRounds) > 0 ? Number(input.maxCopilotRounds) : 10
const COPILOT_WAIT_SECONDS = Number(input.copilotWaitSeconds) > 0 ? Number(input.copilotWaitSeconds) : 600
// #1231 CI gate: rounds of (watch checks → fix → re-converge Copilot) after
// the draft is marked ready. Each round costs a full CI suite, so keep small.
const MAX_CI_ROUNDS = Number(input.maxCiRounds) > 0 ? Number(input.maxCiRounds) : 3
// #3 (owner 2026-07-21): the sonnet pre-grinds exist to save Opus rounds on
// big changes; on small ones they ADD a guaranteed extra review+fix cycle
// before the Opus certifier runs anyway. Skip them below these sizes, or
// force-skip with args.light.
const light = input.light === true
const SPEC_SONNET_MIN_LINES = 300
const CODE_SONNET_MIN_LINES = 150
if (input.dryRun) {
  // Cheap resolution/syntax check — no agents spawned, no side effects.
  return { dryRun: true, issue, openPr, light, MAX_AUDIT_ROUNDS, MAX_COPILOT_ROUNDS, COPILOT_WAIT_SECONDS, MAX_CI_ROUNDS }
}

const REPO = '{{VCS_REPO_SLUG}}'

// ─── schemas ─────────────────────────────────────────────────────────────
const SETUP_SCHEMA = {
  type: 'object',
  properties: {
    issueTitle: { type: 'string' },
    branchName: { type: 'string', description: 'feature/<short-name> — created and checked out INSIDE the worktree' },
    worktreeDir: { type: 'string', description: 'absolute path to the dedicated worktree ($(git rev-parse --show-toplevel)/.claude/worktrees/ship-<issue>) with branchName checked out; empty on a blocked result' },
    specPath: { type: 'string', description: '{{PATHS_SPECS_DIR}}/<short-name>.md (planned path, not yet written)' },
    lockAcquired: { type: 'boolean' },
    blocked: { type: 'string', description: 'Non-empty iff the issue cannot proceed (already locked, closed, missing)' },
  },
  required: ['issueTitle', 'branchName', 'worktreeDir', 'specPath', 'lockAcquired'],
}

// Size signals for the #3 sonnet-pre-grind skip — reported by the agents
// that produced the artifact (the workflow script itself cannot run git).
const SPEC_SCHEMA = {
  type: 'object',
  properties: {
    specLines: { type: 'number', description: 'line count (`wc -l`) of the committed spec file' },
  },
  required: ['specLines'],
}

const IMPLEMENT_SCHEMA = {
  type: 'object',
  properties: {
    changedLines: { type: 'number', description: 'total insertions+deletions from `git diff --stat origin/{{VCS_DEFAULT_BASE}}...HEAD` after the final push' },
    summary: { type: 'string', description: 'one-paragraph implementation summary' },
  },
  required: ['changedLines'],
}

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    clean: { type: 'boolean', description: 'true ONLY when there are zero unaddressed findings' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
          file: { type: 'string' },
          line: { type: 'number', description: '1-indexed line the finding anchors to (omit if file-wide)' },
          summary: { type: 'string' },
          suggestedFix: { type: 'string', description: 'one-sentence concrete fix — the fix agent applies this instead of re-locating the issue' },
        },
        required: ['severity', 'summary'],
      },
    },
  },
  required: ['clean', 'findings'],
}

const THREADS_SCHEMA = {
  type: 'object',
  properties: {
    unresolved: { type: 'number', description: 'count of unresolved review threads on the PR' },
    threads: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          summary: { type: 'string', description: 'first ~300 chars of the thread\'s first comment' },
        },
        required: ['summary'],
      },
    },
  },
  required: ['unresolved', 'threads'],
}

// #1231 CI-gate poller output: overall check state + clipped failure evidence.
const CI_SCHEMA = {
  type: 'object',
  properties: {
    green: { type: 'boolean', description: 'true iff every completed check passed (skipped counts as passed) and none are pending' },
    failing: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'check name as shown by `gh pr checks`' },
          summary: { type: 'string', description: '~300 chars of the failing job\'s actual error, pulled from its log tail' },
        },
        required: ['name', 'summary'],
      },
    },
  },
  required: ['green', 'failing'],
}

// #1231 CI-gate fix outcome: committed=false means "pure infra flake, jobs
// re-run instead" — the gate loops back to the poller either way.
const CI_FIX_SCHEMA = {
  type: 'object',
  properties: {
    committed: { type: 'boolean', description: 'true iff a fix commit was pushed (false = flake-only, failed jobs re-run)' },
  },
  required: ['committed'],
}

const LEARN_SCHEMA = {
  type: 'object',
  properties: {
    committed: { type: 'boolean', description: 'true ONLY if a lesson commit was pushed to the branch' },
    summary: { type: 'string', description: 'one paragraph listing the files changed, or "no lessons encoded"' },
  },
  required: ['committed', 'summary'],
}

// agent() resolves to null when the subagent dies on a terminal API error
// or is skipped. For MUTATING steps that must not be silently skipped
// (spec, fixes, implement, context), a null is fatal — without this check a
// dead implement agent would send an empty diff to review and could reach PR.
const must = (value, step) => {
  if (value === null || value === undefined) throw new Error(`${step} agent failed (null result)`)
  return value
}

// Tracks the last-entered phase so the finally-block unlock (which can run
// after a throw from ANY phase) is labeled with the phase it exited from,
// instead of a hardcoded 'PR' that mislabels early-failure paths.
// Also meters output-token spend per phase via budget.spent() (#7, owner
// 2026-07-21) so future trims are guided by data instead of guesses. Caveat:
// the budget pool is turn-wide (main loop + every workflow), so anything
// else running in the same turn pollutes the deltas — ship runs are
// normally the only workflow in their turn.
let lastPhase = 'Setup'
const phaseSpend = {}
let phaseMark = budget.spent()
const flushPhaseSpend = () => {
  const now = budget.spent()
  phaseSpend[lastPhase] = (phaseSpend[lastPhase] ?? 0) + (now - phaseMark)
  phaseMark = now
}
const enterPhase = (title) => { flushPhaseSpend(); lastPhase = title; phase(title) }

const findingsBlock = (rounds) =>
  rounds
    .map((f) => {
      const lineNo = f.line !== undefined && f.line !== null ? `:${f.line}` : ''
      const where = f.file ? `${f.file}${lineNo}: ` : lineNo ? `(line${lineNo}) ` : ''
      return `- [${f.severity}] ${where}${f.summary}${f.suggestedFix ? ` — suggested fix: ${f.suggestedFix}` : ''}`
    })
    .join('\n')

// Every audit round + Copilot round appends here; the Learn phase consumes
// this instead of re-harvesting the whole review cycle from GitHub.
// Entries are truncated at push and capped at read (Learn prompt) so a
// fully-utilized run (20+ rounds) can't blow the prompt back up.
const reviewHistory = []
const pushHistory = (entry) =>
  reviewHistory.push(entry.length > 4000 ? entry.slice(0, 4000) + '\n…(entry truncated)' : entry)

const threadsBlock = (threads) =>
  threads.map((t) => `- ${t.path ? t.path + ': ' : ''}${t.summary}`).join('\n')

// ─── Setup ───────────────────────────────────────────────────────────────
enterPhase('Setup')
const setup = await agent(
  `You are the setup step of the ship pipeline for GitHub issue #${issue} in ${REPO}. Your shell starts in the repo root; THIS step runs entirely in the root — it creates a worktree but never cd's into it.
1. Run EVERY abort check BEFORE acquiring the lock (a blocked result must not strand the label): \`{{TRACKER_VIEW_ISSUE}}` — if the issue is closed, missing, or already carries ANY agent:* label, set blocked, lockAcquired=false, worktreeDir="", and do nothing else. Do NOT check working-tree cleanliness: this workflow runs in a DEDICATED worktree, so the main working tree may be dirty and is deliberately left untouched.
2. Only after all checks pass, acquire the lock: \`{{TRACKER_ADD_LABEL}}` (create-if-missing is fine). The lock must be in place BEFORE any branch/worktree changes.
3. \`git fetch origin\`. Derive \`feature/<short-name>\` from the issue title (kebab-case, ≤4 words). Compute the worktree path (gitignored): \`WT="$(git rev-parse --show-toplevel)/.claude/worktrees/ship-${issue}"\`. Clear any stale worktree there first: \`git worktree remove --force "$WT" 2>/dev/null; git worktree prune\`.
4. Create the isolated worktree with the feature branch checked out, WITHOUT changing the main tree's current branch. Decide which case via \`git ls-remote --exit-code --heads origin feature/<short-name>\`:
   - Branch exists on origin (resumed run): \`git worktree add "$WT" feature/<short-name> 2>/dev/null || git worktree add --track -b feature/<short-name> "$WT" origin/feature/<short-name>\` — the fallback creates the LOCAL tracking branch when only the remote ref exists (a plain \`git worktree add "$WT" <branch>\` needs a local branch, which \`git fetch\` alone does not create). Then \`git -C "$WT" rebase origin/{{VCS_DEFAULT_BASE}}\`.
   - Otherwise (new branch): \`git worktree add -b feature/<short-name> "$WT" origin/{{VCS_DEFAULT_BASE}}\`.
   Verify \`git -C "$WT" rev-parse --abbrev-ref HEAD\` prints the feature branch. Do NOT push yet — the Spec step makes the first commit + push.
5. Do NOT attempt any board-status updates — the gh token lacks the project scope, so board GraphQL calls always fail with INSUFFICIENT_SCOPES (this applies even where a skill/agent definition says to move the board).
Return the structured result, with worktreeDir set to the absolute "$WT" path. Do NOT write any spec or code.`,
  { label: `setup:#${issue}`, phase: 'Setup', schema: SETUP_SCHEMA, effort: 'low', model: 'haiku' },
)
if (!setup || setup.blocked) {
  // Belt-and-suspenders: the setup prompt orders abort checks before the
  // lock, but if a partial run still acquired it, release before aborting —
  // this return sits outside the try/finally that owns the normal release.
  if (setup && setup.lockAcquired) {
    await agent(
      `Release the ship pipeline lock: \`{{TRACKER_REMOVE_LABEL}}`.${setup.worktreeDir ? ` Then remove its worktree (run from the repo root, NOT inside it): \`git worktree remove --force "${setup.worktreeDir}" 2>/dev/null; git worktree prune\`.` : ''} Do nothing else.`,
      { label: `unlock:#${issue}`, phase: 'Setup', effort: 'low', model: 'haiku' },
    ).catch(() => {})
  }
  return { issue, aborted: setup ? setup.blocked : 'setup agent failed', prUrl: null }
}
log(`#${issue} "${setup.issueTitle}" → ${setup.branchName} (worktree: ${setup.worktreeDir})`)

// Every phase runs inside this dedicated worktree; the user's main working
// tree is never touched, so they can keep working / run other ships in
// parallel (a different issue → a different ship-<issue> worktree + branch).
const worktreeDir = setup.worktreeDir
const IN_WT = `Run EVERYTHING inside the isolated git worktree at \`${worktreeDir}\` — begin with \`cd "${worktreeDir}"\` (keep the quotes — the path may contain spaces) before any git, file-edit, build, or test command. It has branch ${setup.branchName} checked out with every prior phase's commits already present locally; the repo's main working tree is a separate directory and must not be touched.`

// Everything after the lock is wrapped so the lock is always released.
let result
try {
  // ─── Spec ──────────────────────────────────────────────────────────────
  enterPhase('Spec')
  const specOut = must(await agent(
    `Write the implementation spec for GitHub issue #${issue} ("${setup.issueTitle}") in ${REPO}.
${IN_WT} Follow the repo's /create-spec skill EXACTLY — read {{PATHS_SKILLS_DIR}}/create-spec/SKILL.md and its pre-flight + architectural-posture checklists, read the issue body and the relevant {{PATHS_CONTEXT_DIR}}/ files, then write ${setup.specPath}. Commit it ("spec(#${issue}): ...") and push the branch (set upstream). Skip the skill's board-status step — the gh token lacks project scope and board moves always fail. Do NOT write any implementation code. Return {specLines}: the committed spec file's \`wc -l\` line count.`,
    // Model pin: spec-writer.md declares sonnet; the spec is the highest-
    // leverage artifact in the pipeline (every later phase builds on it),
    // so draft it on the top tier.
    { label: `spec:#${issue}`, phase: 'Spec', agentType: 'spec-writer', schema: SPEC_SCHEMA, model: 'fable' },
  ), 'spec')
  const skipSonnetSpec = light || specOut.specLines < SPEC_SONNET_MIN_LINES

  // ─── Spec Audit loop (two sequential grinds) ───────────────────────────
  // MODEL POLICY — deliberate, do NOT flip to Opus-first or tier back down:
  // two grinds run in sequence, each to its own convergence.
  //   Stage 1 — SONNET grind: cheap reviewer, fix → re-audit until it
  //   returns zero findings. Sonnet never certifies — its convergence (or
  //   hitting its round cap) only hands off to stage 2.
  //   Stage 2 — OPUS grind: strongest reviewer, fix → re-audit until a
  //   zero-finding OPUS pass — the SOLE exit for the whole audit.
  // Each stage has its own MAX_AUDIT_ROUNDS budget so a stubborn sonnet
  // stage can't starve the Opus grind (it escalates on cap instead of
  // failing the run — Opus is the certifier). Single reviewer per round
  // here (the spec has no line-by-line lens) — only the model tier changes
  // between stages. The spec REVISER runs on Opus (owner preference
  // 2026-07-20 — no fable in the audit loops); only the initial draft
  // stays on fable.
  enterPhase('Spec Audit')
  let specClean = false
  let prevSpecFindings = null
  let prevSpecRoundLabel = null
  for (const stage of ['sonnet', 'opus']) {
    // #3: on a short spec the sonnet pre-grind adds a guaranteed extra
    // review+revise cycle before the Opus certifier runs anyway — skip it.
    if (stage === 'sonnet' && skipSonnetSpec) {
      log(`Spec audit: skipping the sonnet pre-grind (${light ? 'light run' : `spec is ${specOut.specLines} lines < ${SPEC_SONNET_MIN_LINES}`}) — straight to the Opus grind`)
      continue
    }
    let stageClean = false
    for (let round = 1; round <= MAX_AUDIT_ROUNDS; round++) {
      const roundLabel = `${stage} round ${round}`
      // Later rounds carry the prior review's findings so the reviewer
      // verifies the fixes instead of re-deriving the whole analysis cold.
      // Still a full review — clean=true only on a zero-finding pass over
      // everything. The label names the stage explicitly so the Opus
      // grind's first round doesn't misattribute sonnet-stage findings to
      // "the previous round" of its own stage.
      const priorContext = prevSpecFindings
        ? `\nAn earlier review round (${prevSpecRoundLabel}) found the following, addressed in a revision commit since:\n${findingsBlock(prevSpecFindings)}\nVerify each was genuinely resolved (not just reworded) or pushed back with a written justification inline in the spec — a justified push-back counts as addressed. Then sweep the full spec fresh for anything new.`
        : ''
      const review = await agent(
        `Audit the spec ${setup.specPath} (branch ${setup.branchName}) for GitHub issue #${issue} in ${REPO}.
${IN_WT} Judge it as the auditor agent: completeness vs the issue's requirements, conformance to {{PATHS_SKILLS_DIR}}/create-spec/SKILL.md pre-flight checklist + {{PATHS_RULES_DIR}}/architecture-principles.md, realistic file lists, verification steps per sub-phase, migration numbering, and missed incomplete-chain sites ({{PATHS_RULES_DIR}}/workflow.md "Completeness traps"). Report ONLY genuine defects — set clean=true when nothing unaddressed remains.${priorContext}`,
        { label: `spec-audit-${stage}:r${round}`, phase: 'Spec Audit', agentType: 'auditor', schema: FINDINGS_SCHEMA, model: stage },
      )
      if (!review) throw new Error('spec-audit agent failed')
      if (review.findings.length === 0) {
        // A reviewer returning clean=false with ZERO findings is
        // contradictory — nothing actionable to fix, so treat as clean.
        if (!review.clean) {
          log(`Spec audit ${roundLabel}: clean=false but zero findings — treating as clean`)
        }
        stageClean = true
        break
      }
      log(`Spec audit ${roundLabel}: ${review.findings.length} finding(s) — revising`)
      prevSpecFindings = review.findings
      prevSpecRoundLabel = roundLabel
      pushHistory(`Spec-audit ${roundLabel} (${review.findings.length} finding(s)):\n${findingsBlock(review.findings)}`)
      must(await agent(
        `Revise the spec ${setup.specPath} on branch ${setup.branchName} to resolve every finding below (or note push-backs inline in the spec with one-line justifications). ${IN_WT} Commit ("spec(#${issue}): audit ${roundLabel} revisions") and push.
Findings:\n${findingsBlock(review.findings)}`,
        // Opus by owner preference (2026-07-20): no fable inside the audit
        // loops — the reviser runs on Opus; only the initial draft stays fable.
        { label: `spec-fix:${stage}-r${round}`, phase: 'Spec Audit', agentType: 'spec-writer', model: 'opus' },
      ), 'spec-fix')
    }
    if (stage === 'sonnet') {
      log(stageClean
        ? 'Spec audit: sonnet grind converged — starting the Opus grind'
        : `Spec audit: sonnet grind hit the ${MAX_AUDIT_ROUNDS}-round cap — escalating to the Opus grind anyway (Opus certifies, not sonnet)`)
    } else if (stageClean) {
      specClean = true
      log('Spec audit converged: clean Opus pass')
    }
  }
  // Deliberate asymmetry with the code-audit loop below: spec non-convergence
  // THROWS (nothing shippable exists yet — fail the run loudly), while code
  // non-convergence RETURNS a structured result (real commits exist on the
  // branch; the caller needs the branch + unresolved findings to act on).
  if (!specClean) throw new Error(`Spec audit: the Opus grind did not converge in ${MAX_AUDIT_ROUNDS} rounds`)

  // ─── Implement ─────────────────────────────────────────────────────────
  enterPhase('Implement')
  const impl = must(await agent(
    `Implement {{VOCAB_ISSUE}} ${issue} on branch ${setup.branchName} in ${REPO}, building EXACTLY what ${setup.specPath} specifies. ${IN_WT} — including the tests each sub-phase's Verify section calls for. Follow every {{PATHS_RULES_DIR}}/ convention. Run \`{{PKG_BUILD}}\` + \`{{PKG_TYPECHECK}}\` and the affected test suites until green. Commit incrementally with descriptive messages and push. Skip board-status updates (gh token lacks project scope — they always fail). Do NOT open a PR. Return {changedLines}: total insertions+deletions reported by \`git diff --stat origin/{{VCS_DEFAULT_BASE}}...HEAD\` after your final push.`,
    { label: `implement:#${issue}`, phase: 'Implement', agentType: 'developer', schema: IMPLEMENT_SCHEMA },
  ), 'implement')
  const skipSonnetCode = light || impl.changedLines < CODE_SONNET_MIN_LINES

  // ─── Code Audit loop (ralph) — two sequential grinds ───────────────────
  // MODEL POLICY — deliberate, do NOT flip to Opus-first or tier back down:
  // two grinds run in sequence, each to its own convergence.
  //   Stage 1 — SONNET grind: fix → re-audit until zero findings. Sonnet
  //   never certifies — its convergence (or hitting its round cap) only
  //   hands off to stage 2. SKIPPED for small diffs (< CODE_SONNET_MIN_LINES
  //   changed lines, or args.light) — on a small diff the pre-grind costs
  //   more than the Opus rounds it exists to save (#3, owner 2026-07-21).
  //   Stage 2 — OPUS grind: fix → re-audit until a zero-finding OPUS pass —
  //   the SOLE exit for the whole audit.
  // Reviewer shape per round (#4, owner 2026-07-21), same for BOTH stages:
  // two-lens fan-out (auditor + line-reviewer in parallel) on the FIRST
  // round of the stage and on the CERTIFYING pass; intermediate
  // fix-verification rounds use ONE combined reviewer — halving fixed
  // per-round context cost where discovery matters least. A combined
  // reviewer's zero-finding round does NOT certify: it triggers the
  // two-lens certify pass in the same round, and only a zero-finding
  // two-lens pass ends a stage.
  // Each stage has its own MAX_AUDIT_ROUNDS budget so a stubborn sonnet
  // stage can't starve the Opus grind (it escalates on cap instead of
  // aborting — Opus is the certifier). The code FIXER runs on Opus
  // (owner preference 2026-07-21 — no fable inside the audit loops, same
  // rule as the spec reviser above); only the initial Implement pass
  // inherits the session model.
  enterPhase('Code Audit')
  let codeClean = false
  let unresolved = []
  let prevCodeRoundLabel = null
  for (const stage of ['sonnet', 'opus']) {
    if (stage === 'sonnet' && skipSonnetCode) {
      log(`Code audit: skipping the sonnet pre-grind (${light ? 'light run' : `diff is ${impl.changedLines} changed lines < ${CODE_SONNET_MIN_LINES}`}) — straight to the Opus grind`)
      continue
    }
    let stageClean = false
    for (let round = 1; round <= MAX_AUDIT_ROUNDS; round++) {
      const roundLabel = `${stage} round ${round}`
      // Later rounds pass the prior review's findings (held in `unresolved`)
      // so the reviewers verify the fix commits instead of re-analyzing
      // cold. Still a full-diff review — clean=true only on a zero-finding
      // pass. Every round MUST stay a full-diff sweep — never scope it to
      // changed files, or a clean pass isn't a real certification. The
      // label names the stage explicitly so the Opus grind's first round
      // doesn't misattribute sonnet-stage findings to its own prior round.
      const priorContext = unresolved.length
        ? `\nAn earlier review round (${prevCodeRoundLabel}) found the following, addressed in a fix commit since:\n${findingsBlock(unresolved)}\nVerify each was genuinely fixed (or rejected with justification in the commit message), then sweep the full diff fresh for anything new or regressed.`
        : ''
      const reviewPrompt = (who) =>
        `${who} review of \`git diff origin/{{VCS_DEFAULT_BASE}}...HEAD\` on branch ${setup.branchName} (issue #${issue}, spec ${setup.specPath}) in ${REPO}. ${IN_WT} Report every genuine defect with file:line; set clean=true ONLY on a zero-finding pass. This is ${roundLabel} of a fix→re-audit loop — the loop ends on a clean pass, not on a fix.${priorContext}`

      // Two-lens fan-out — used for round 1 (discovery) and the certifying
      // pass (see the reviewer-shape comment above the stage loop).
      const twoLens = async (suffix) => {
        const [audit, lines] = await parallel([
          () => agent(reviewPrompt('Architectural / spec-conformance'), { label: `audit-${stage}:r${round}${suffix}`, phase: 'Code Audit', agentType: 'auditor', schema: FINDINGS_SCHEMA, model: stage }),
          () => agent(reviewPrompt('Line-by-line (include LOW nits)'), { label: `lines-${stage}:r${round}${suffix}`, phase: 'Code Audit', agentType: 'line-reviewer', schema: FINDINGS_SCHEMA, model: stage }),
        ])
        if (!audit || !lines) throw new Error('code-audit two-lens reviewer failed')
        const merged = [...audit.findings, ...lines.findings]
        // A reviewer returning clean=false with ZERO findings is
        // contradictory — nothing actionable to fix, so treat as clean.
        if (merged.length === 0 && (!audit.clean || !lines.clean)) {
          log(`Code audit ${roundLabel}: clean=false but zero findings — treating as clean`)
        }
        return merged
      }

      let all
      if (round === 1) {
        all = await twoLens('')
      } else {
        const combined = await agent(
          reviewPrompt('Combined architectural / spec-conformance AND line-by-line (include LOW nits)'),
          { label: `audit-${stage}:r${round}`, phase: 'Code Audit', agentType: 'auditor', schema: FINDINGS_SCHEMA, model: stage },
        )
        if (!combined) throw new Error('code-audit combined reviewer failed')
        all = combined.findings
        if (all.length === 0) {
          // Combined reviewer found nothing — it never certifies; run the
          // two-lens certify pass, whose findings (if any) re-enter the loop.
          log(`Code audit ${roundLabel}: combined reviewer clean — running the two-lens certify pass`)
          all = await twoLens('-certify')
        }
      }
      if (all.length === 0) {
        stageClean = true
        break
      }

      unresolved = all
      prevCodeRoundLabel = roundLabel
      log(`Code audit ${roundLabel}: ${all.length} finding(s) — fixing`)
      pushHistory(`Code-audit ${roundLabel} (${all.length} finding(s)):\n${findingsBlock(all)}`)
      must(await agent(
        `Fix every finding below on branch ${setup.branchName} (issue #${issue}). ${IN_WT} For any you reject, add a one-line justification to the commit message. Re-run typecheck + affected tests until green, commit ("fix(#${issue}): audit ${roundLabel} findings"), push (if the push is rejected, \`git pull --rebase origin ${setup.branchName}\` first — e.g. an accepted Copilot Autofix commit).
Findings:\n${findingsBlock(all)}`,
        // Opus by owner preference (2026-07-21): no fable inside the audit
        // loops — audit-loop fixers run on Opus (matches spec-fix + copilot-fix).
        { label: `code-fix:${stage}-r${round}`, phase: 'Code Audit', agentType: 'developer', model: 'opus' },
      ), 'code-fix')
    }
    if (stage === 'sonnet') {
      log(stageClean
        ? 'Code audit: sonnet grind converged — starting the Opus grind'
        : `Code audit: sonnet grind hit the ${MAX_AUDIT_ROUNDS}-round cap — escalating to the Opus grind anyway (Opus certifies, not sonnet)`)
    } else if (stageClean) {
      codeClean = true
      log('Code audit converged: clean Opus pass')
    }
  }
  if (!codeClean) {
    // Repo rule: the loop ends on a clean audit, never on a fix — and only
    // an Opus pass certifies clean. The Opus stage always runs (a sonnet
    // cap-out escalates instead of aborting), so non-convergence here always
    // means the Opus grind exhausted its own round cap. Don't ship.
    log(`Code audit did NOT converge (the Opus grind did not certify clean within its ${MAX_AUDIT_ROUNDS}-round cap — raise maxAuditRounds) — stopping before Context/PR`)
    result = { issue, branch: setup.branchName, converged: false, unresolved, prUrl: null }
  } else {
    // ─── Context ─────────────────────────────────────────────────────────
    enterPhase('Context')
    must(await agent(
      `On branch ${setup.branchName}, refresh project context for the just-implemented issue #${issue} (spec ${setup.specPath}). ${IN_WT} Follow the repo's /update-context and /update-progress skills: update the relevant {{PATHS_CONTEXT_DIR}}/ files (CHANGELOG.md entry, BUILD_STATE.md, SCHEMA.md if migrations changed, DEFERRED_ITEMS.md if anything was deferred) and CLAUDE.md's Current Focus line. If CLAUDE.md, {{PATHS_RULES_DIR}}/, {{PATHS_SKILLS_DIR}}/, or {{PATHS_AGENTS_DIR}}/ changed, run \`{{PKG_SYNC_AGENTS}}\` and include the regenerated files. Commit ("docs(#${issue}): context updates") and push.`,
      // Sonnet pin (#5, owner 2026-07-21): mechanical doc refresh — don't
      // inherit the session model (fable when driven from a fable session).
      { label: `context:#${issue}`, phase: 'Context', agentType: 'context-updater', model: 'sonnet' },
    ), 'context')

    // ─── PR ──────────────────────────────────────────────────────────────
    enterPhase('PR')
    let prUrl = null
    if (openPr) {
      const prOut = await agent(
        `Open the PR for branch ${setup.branchName} → main in ${REPO} for issue #${issue}. ${IN_WT} Follow {{PATHS_AGENTS_DIR}}/pr-creator.md conventions: "Closes #${issue}" in the body, structured summary from ${setup.specPath} + the audit-loop convergence note, the Claude Code footer, AND a comment on issue #${issue} announcing the PR. Skip all board-status updates (gh token lacks project scope — board moves always fail).
Open it as a DRAFT (\`{{VCS_CREATE_PR}}`) — draft PRs skip CI/security runs (#1231) while the Copilot loop iterates; a later pipeline phase marks it ready. After creating it, dispatch the one-time CI smoke run against the branch (early signal for env-only failures the local test runs can't catch): \`gh workflow run ci.yml --ref ${setup.branchName}\` and \`gh workflow run security.yml --ref ${setup.branchName}\`. Treat dispatch rejection as NON-FATAL (log and continue — a branch cut before the workflow_dispatch trigger reached its copy of ci.yml can't be dispatched). Return ONLY the PR URL as your final text.`,
        // No model pin: pr-creator.md declares sonnet, and the step does real
        // synthesis (spec summary) + anomaly detection (stranded-branch check).
        { label: `pr:#${issue}`, phase: 'PR', agentType: 'pr-creator' },
      )
      prUrl = typeof prOut === 'string' ? (prOut.match(/https:\/\/github\.com\/\S+\/pull\/\d+/) || [null])[0] : null
      if (!prUrl) log('WARNING: pr-creator returned no PR URL — Copilot loop will be SKIPPED; check the PR manually')
    }
    // prFailed distinguishes "PR creation failed / URL not extracted" from a
    // deliberate pr:false run — both have prUrl:null in the result.
    result = { issue, branch: setup.branchName, spec: setup.specPath, converged: true, prUrl, prFailed: openPr && !prUrl }

    // ─── Copilot Loop ────────────────────────────────────────────────────
    // The repo ruleset auto-runs Copilot review on PR open AND on every
    // push. Each resolve round pushes a fix commit, which triggers the next
    // review — so we loop: wait → check for new threads → resolve → repeat,
    // until a wait finds zero unresolved threads. Extracted as a function
    // because the Learn phase below can push one more commit AFTER this
    // loop converges — that push re-triggers Copilot review like any other,
    // so Learn re-enters this same loop (bounded) instead of ending the run
    // with an unhandled review round.
    const runCopilotLoop = async (prNumber, maxRounds, labelPrefix) => {
      let converged = false
      let outstanding = []
      for (let round = 1; round <= maxRounds; round++) {
        const check = await agent(
          `You are the Copilot-review poller for PR #${prNumber} in ${REPO} (round ${labelPrefix}${round}). The PR just received a push; the repo ruleset makes Copilot review every push.
1. Wait ~${COPILOT_WAIT_SECONDS}s for the review to land. Your shell has a per-call timeout, so wait in chunks: run \`sleep 100\` ${Math.ceil(COPILOT_WAIT_SECONDS / 100)} times. If foreground sleep is unavailable in your environment, substitute a slow poll (e.g. \`{{VCS_PR_CHECKS}}` or repeated timestamped \`gh api\` calls) totaling roughly the same wait.
2. Then fetch UNRESOLVED review threads via GraphQL:
   \`{{VCS_LIST_REVIEW_THREADS}}`
   and count nodes with isResolved=false.
3. If unresolved is 0 but the latest copilot-pull-request-reviewer review predates the latest push (check \`gh api repos/${REPO}/pulls/${prNumber}/reviews\` vs the head commit's date), poll once a minute for up to 5 more minutes for the pending review, then re-fetch threads.
Return {unresolved, threads:[{path, summary}]} — summary is the first ~300 chars of each unresolved thread's first comment. Do NOT fix anything.`,
          // Poller on haiku (owner 2026-07-21, amending the 2026-07-20
          // all-Opus preference): the poller only sleeps, counts threads,
          // and clips summaries — mechanical work with no judgment. The
          // FIX agent below stays on Opus per the no-fable-in-fix-loops
          // rule; that is what the 2026-07-20 preference was protecting.
          { label: `copilot-check:${labelPrefix}r${round}`, phase: 'Copilot Loop', schema: THREADS_SCHEMA, effort: 'low', model: 'haiku' },
        )
        if (!check) {
          // Same rationale as the fix-agent branch below: the PR already
          // exists — a dead poller must surface as converged=false with the
          // last-known threads, not a throw that discards the PR result.
          log(`Copilot round ${labelPrefix}${round}: check agent failed — stopping the loop; verify threads manually`)
          break
        }
        if (check.unresolved === 0) {
          converged = true
          log(`Copilot loop converged: no new threads after round ${labelPrefix}${round}`)
          break
        }
        outstanding = check.threads
        log(`Copilot round ${labelPrefix}${round}: ${check.unresolved} unresolved thread(s) — resolving`)
        pushHistory(`Copilot round ${labelPrefix}${round} (${check.unresolved} thread(s)):\n${threadsBlock(check.threads)}`)
        // NOT must(): the PR already exists — a dead fix agent here should
        // surface as copilot.converged=false with the outstanding threads,
        // not a throw that discards the valid PR outcome.
        const fixed = (await agent(
          `Resolve the Copilot review feedback on PR #${prNumber} (branch ${setup.branchName}, issue #${issue}) in ${REPO}. ${IN_WT} Follow {{PATHS_SKILLS_DIR}}/resolve-copilot-feedback/SKILL.md EXACTLY: read every unresolved thread in full, fix or push back with written justification (never agree-then-ignore), run the pre-emptive sweep over touched files, ONE commit ("fix(#${issue}): apply Copilot review findings on PR #${prNumber} (round ${labelPrefix}${round})"), run typecheck + affected tests, push (rebase on the remote branch first if the push is rejected — accepted Copilot Autofix commits land remotely), then RESOLVE EVERY THREAD via the GraphQL resolveReviewThread mutation (verify zero unresolved afterward) and post the summary comment mapping findings to resolutions.
Threads at last check:\n${threadsBlock(check.threads)}`,
          { label: `copilot-fix:${labelPrefix}r${round}`, phase: 'Copilot Loop', agentType: 'developer', model: 'opus' },
        ))
        if (fixed === null || fixed === undefined) {
          log(`Copilot round ${labelPrefix}${round}: fix agent failed — stopping the loop; threads left for human review`)
          break
        }
      }
      return { converged, outstanding: converged ? [] : outstanding }
    }

    if (prUrl) {
      enterPhase('Copilot Loop')
      const prNumber = Number((prUrl.match(/\/pull\/(\d+)/) || [])[1])
      result.copilot = await runCopilotLoop(prNumber, MAX_COPILOT_ROUNDS, '')
      if (!result.copilot.converged) {
        log(`Copilot loop hit the ${MAX_COPILOT_ROUNDS}-round cap with threads still arriving — human review needed`)
      }

      // ─── Learn (terminal phase) ────────────────────────────────────────
      // The review cycle just ended — harvest its findings and encode the
      // recurrence-class lessons into the repo's rules/skills so the next
      // run stops repeating them. Non-fatal: a dead learn agent must not
      // discard the shipped-PR result.
      enterPhase('Learn')
      const learned = await agent(
        `Run the repo's /learn retrospective for PR #${prNumber} (issue #${issue}, branch ${setup.branchName}) in ${REPO}. ${IN_WT} Follow {{PATHS_SKILLS_DIR}}/learn/SKILL.md EXACTLY — but the harvest step is mostly done for you: this run accumulated every audit-round finding and every Copilot thread its poller observed, below. Use it as the primary harvest source; query GitHub only for what it lacks (e.g. thread resolutions/push-backs on the PR, accepted Autofix commits), not to re-fetch what's listed. Completeness check (mandatory): run ONE GraphQL enumeration of ALL review threads on the PR (resolved + unresolved) — any thread not already in the record was created and resolved between poller rounds and must still be harvested.

=== Harvest record (this run) ===
${(() => { const tail = reviewHistory.slice(-20); const omitted = reviewHistory.length - tail.length; return (omitted > 0 ? `(${omitted} earlier round entries omitted for length — recover from GitHub if needed)\n\n` : '') + (tail.length ? tail.join('\n\n') : '(zero findings in every audit round and Copilot round this run observed)') })()}
=== End harvest record ===

Distill the recurrence-class lessons (cap 5, skip one-offs), dedup against existing {{PATHS_RULES_DIR}}/, {{PATHS_SKILLS_DIR}}/, and {{PATHS_AGENTS_DIR}}/ content (sharpen placement instead of duplicating), encode each lesson in its ONE right home per the skill's routing table (new rule files need a file-patterns.json entry AND a rule-budgets.json entry — introduction size +15%, added to totalCap), run \`{{PKG_SYNC_AGENTS}}\`, then COMMIT ON ${setup.branchName} ("learn(#${issue}): encode review lessons from PR #${prNumber}") and PUSH so the PR is updated with the changes. Finally post a PR comment titled "📚 Learn:" listing each lesson → destination file (or stating that zero lessons survived distillation, in which case commit nothing). Return {committed, summary}: committed=true ONLY if you pushed a lesson commit; summary is one paragraph listing the files you changed (or 'no lessons encoded').`,
        // Opus pin (#5, owner 2026-07-21): distillation needs judgment but
        // not the session model (fable when driven from a fable session).
        { label: `learn:#${issue}`, phase: 'Learn', agentType: 'agent-manager', schema: LEARN_SCHEMA, model: 'opus' },
      )
      if (learned === null || learned === undefined) {
        log('Learn phase agent failed — lessons not encoded; run /learn manually')
        result.learn = { ran: false }
      } else {
        result.learn = { ran: true, committed: learned.committed, summary: String(learned.summary).slice(0, 500) }
        if (learned.committed) {
          // The Learn push re-triggers Copilot review AFTER the loop above
          // already converged. Re-enter the loop (small cap — lesson commits
          // are docs-only and rarely draw threads) so the run never reports
          // "PR ready for review" with an unhandled review round pending.
          const post = await runCopilotLoop(prNumber, Math.min(3, MAX_COPILOT_ROUNDS), 'learn-')
          result.copilot = post
          if (!post.converged) {
            log('Copilot re-entry after the Learn push did not converge — human review needed')
          }
        }
      }

      // ─── CI Gate (#1231) ───────────────────────────────────────────────
      // The draft PR skipped CI throughout the Copilot loop (drafts skip
      // every ci.yml/security.yml job). Mark it ready — ready_for_review
      // fires the one merge-ref CI + security run — then babysit: watch
      // checks; on failure, fix + push. The fix push re-triggers BOTH CI
      // (non-draft synchronize) and Copilot review (ruleset review_on_push),
      // so each round re-converges Copilot too. Runs AFTER Learn so the
      // ready-triggered run tests the true final state (Learn's docs commit
      // lands while still draft, costing zero CI runs).
      enterPhase('CI Gate')
      result.ci = { green: false, rounds: 0 }
      const readied = await agent(
        `Mark PR #${prNumber} in ${REPO} ready for review: \`{{VCS_MARK_READY}}`. Already-ready counts as success. Do nothing else. Return the word done.`,
        { label: `pr-ready:#${issue}`, phase: 'CI Gate', effort: 'low', model: 'haiku' },
      )
      if (readied === null || readied === undefined) {
        log('CI gate: pr-ready agent failed — PR left in draft; mark it ready and watch CI manually')
      } else {
        for (let round = 1; round <= MAX_CI_ROUNDS; round++) {
          result.ci.rounds = round
          const status = await agent(
            `You are the CI-gate poller for PR #${prNumber} in ${REPO} (round ${round}). The PR was just marked ready for review (or just received a fix push / job re-run), which triggered CI + security check runs on it.
1. Give the runs a moment to register (prefer \`sleep 100\`; if foreground sleep is unavailable, substitute a slow poll like repeated timestamped \`{{VCS_PR_CHECKS}}` calls totaling ~100s), then poll \`{{VCS_PR_CHECKS}}` every ~90s (chunked \`sleep 90\` calls) until NO check is pending, waiting up to ~40 minutes total (the backend-test matrix runs ~25 min).
2. green=true iff every completed check passed or was skipped. For each failing check, open the failing Actions run/job log (if you can’t locate a job id from \`gh pr checks\`, find the most recent run via \`gh run list --repo ${REPO} --branch ${setup.branchName} --limit 20\` and then inspect logs via \`gh run view <run-id> --repo ${REPO} --log\`) and clip ~300 chars of the ACTUAL error — not the generic "Process completed with exit code 1" line.
Do NOT fix anything. Return {green, failing:[{name, summary}]}.`,
            { label: `ci-check:r${round}`, phase: 'CI Gate', schema: CI_SCHEMA, effort: 'low', model: 'haiku' },
          )
          if (!status) {
            log(`CI gate round ${round}: poller failed — verify checks manually`)
            break
          }
          if (status.green) {
            result.ci.green = true
            log(`CI gate: all checks green after round ${round}`)
            break
          }
          log(`CI gate round ${round}: ${status.failing.length} failing check(s) — fixing`)
          const fixed = await agent(
            `Fix the failing CI checks on PR #${prNumber} (branch ${setup.branchName}, issue #${issue}) in ${REPO}. ${IN_WT} Diagnose each failure from its actual job log (\`gh run view --job <id> --log\`) — do NOT guess from the check name alone. Distinguish real defects from infra flakes (e.g. a vitest worker OOM where every test passed, a runner network blip): for a pure flake with nothing to fix, re-run just the failed jobs (\`{{VCS_RERUN_FAILED_CHECKS}}`) and commit NOTHING. If you do fix something: run typecheck + the affected tests locally until green, make ONE commit ("fix(#${issue}): CI gate round ${round}"), push (rebase on the remote branch first if the push is rejected). Return {committed}: true iff you pushed a commit.
Failing checks:\n${status.failing.map((f) => `- ${f.name}: ${f.summary}`).join('\n')}`,
            { label: `ci-fix:r${round}`, phase: 'CI Gate', agentType: 'developer', schema: CI_FIX_SCHEMA, model: 'opus' },
          )
          if (fixed === null || fixed === undefined) {
            log(`CI gate round ${round}: fix agent failed — checks left red for human review`)
            break
          }
          if (fixed.committed) {
            // The fix push re-triggered Copilot review — re-converge it before
            // the next CI poll so the run never ends with an unhandled round.
            const post = await runCopilotLoop(prNumber, Math.min(2, MAX_COPILOT_ROUNDS), `ci${round}-`)
            result.copilot = post
            if (!post.converged) {
              log(`Copilot re-entry after CI-gate round ${round} did not converge — human review needed`)
            }
          }
        }
        if (!result.ci.green && result.ci.rounds >= MAX_CI_ROUNDS) {
          log(`CI gate hit the ${MAX_CI_ROUNDS}-round cap with checks still red — human review needed`)
        }
      }
    }
  }
} finally {
  // Release the lock AND tear down the worktree on EVERY exit path (success,
  // non-convergence, throw). Board status was advanced (or deliberately not)
  // before this point, so releasing here follows the lock contract in
  // {{PATHS_RULES_DIR}}/workflow.md. The feature branch + every pushed commit
  // persist on origin, so removing the local worktree is always safe — a
  // non-converged run can be resumed by re-checking-out the branch.
  await agent(
    `Two cleanup actions from the repo root (do NOT cd into the worktree — you are removing it):
1. Release the ship pipeline lock: \`{{TRACKER_REMOVE_LABEL}}` (already-absent = success).
2. Remove the ship worktree: \`git worktree remove --force "${worktreeDir}" 2>/dev/null; git worktree prune\` (already-gone = success).
Do nothing else.`,
    { label: `unlock:#${issue}`, phase: lastPhase, effort: 'low', model: 'haiku' },
  ).catch(() => {})
  // #7: flush the final phase's spend and report the per-phase breakdown —
  // logged even on throw/non-convergence so every run yields the data.
  flushPhaseSpend()
  const spendLine = Object.entries(phaseSpend)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}k`)
    .join(' · ')
  log(`Output-token spend by phase: ${spendLine || '(none metered)'}`)
  if (result) result.tokensByPhase = phaseSpend
}

return result
