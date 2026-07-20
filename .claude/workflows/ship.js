export const meta = {
  name: 'ship',
  description: 'Issue → spec → spec-audit loop → implement+tests → ralph code-audit loop → context update → PR → Copilot-feedback loop → learn',
  whenToUse: 'Drive a GitHub issue end-to-end to a merge-ready PR (with Copilot review rounds auto-resolved) as one deterministic pipeline. args: { issue: <number>, pr?: boolean (default true), maxAuditRounds?: number (default 5), maxCopilotRounds?: number (default 10), copilotWaitSeconds?: number (default 600), dryRun?: boolean }',
  phases: [
    { title: 'Setup', detail: 'fetch issue, acquire agent:in-progress lock, create feature branch', model: 'haiku' },
    { title: 'Spec', detail: 'spec-writer drafts .ai/specs/<slug>.md per /create-spec', model: 'fable' },
    { title: 'Spec Audit', detail: 'tiered auditor loop (sonnet grind → opus confirming gate) until a clean opus pass' },
    { title: 'Implement', detail: 'developer builds + tests to satisfy the spec' },
    { title: 'Code Audit', detail: 'ralph loop, tiered: sonnet grind (combined) → opus two-lens confirming gate → fix → re-audit; exits only on a clean opus gate', model: 'opus' },
    { title: 'Context', detail: 'update-context + update-progress via context-updater' },
    { title: 'PR', detail: 'pr-creator opens the PR; board advanced; lock released' },
    { title: 'Copilot Loop', detail: 'after each push: wait ~10 min for Copilot review, resolve feedback, repeat until a round finds no new threads' },
    { title: 'Learn', detail: 'harvest the review cycle, encode recurrence-class lessons into rules/skills, push to the PR' },
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
if (input.dryRun) {
  // Cheap resolution/syntax check — no agents spawned, no side effects.
  return { dryRun: true, issue, openPr, MAX_AUDIT_ROUNDS, MAX_COPILOT_ROUNDS, COPILOT_WAIT_SECONDS }
}

const REPO = 'Digital-Synchrony/ORM'

// ─── schemas ─────────────────────────────────────────────────────────────
const SETUP_SCHEMA = {
  type: 'object',
  properties: {
    issueTitle: { type: 'string' },
    branchName: { type: 'string', description: 'feature/<short-name> — created and checked out' },
    specPath: { type: 'string', description: '.ai/specs/<short-name>.md (planned path, not yet written)' },
    lockAcquired: { type: 'boolean' },
    blocked: { type: 'string', description: 'Non-empty iff the issue cannot proceed (already locked, closed, missing)' },
  },
  required: ['issueTitle', 'branchName', 'specPath', 'lockAcquired'],
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
let lastPhase = 'Setup'
const enterPhase = (title) => { lastPhase = title; phase(title) }

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
  `You are the setup step of the board pipeline for GitHub issue #${issue} in ${REPO}. Working dir: the repo root.
1. Run EVERY abort check BEFORE acquiring the lock (a blocked result must not strand the label): \`gh issue view ${issue} --repo ${REPO} --json title,body,state,labels\` — if the issue is closed, missing, or already carries ANY agent:* label, set blocked and lockAcquired=false, and do nothing else. Likewise if \`git status --porcelain\` shows uncommitted changes, set blocked ("working tree dirty") — this workflow runs in the shared working tree.
2. Only after all checks pass, acquire the lock: \`gh issue edit ${issue} --repo ${REPO} --add-label "agent:in-progress"\` (create-if-missing is fine). The lock must be in place BEFORE any branch/board changes.
3. \`git fetch origin && git checkout main && git pull --ff-only\`, then create + check out \`feature/<short-name>\` derived from the issue title (kebab-case, ≤4 words). If the branch already exists locally or on origin, check it out and rebase on origin/main instead.
4. Move the issue's ORM board status toward the pipeline start if it is in a Backlog/Refinement state (see .ai/context/PROJECT_BOARD.md; best-effort, non-fatal).
Return the structured result. Do NOT write any spec or code.`,
  { label: `setup:#${issue}`, phase: 'Setup', schema: SETUP_SCHEMA, effort: 'low', model: 'haiku' },
)
if (!setup || setup.blocked) {
  // Belt-and-suspenders: the setup prompt orders abort checks before the
  // lock, but if a partial run still acquired it, release before aborting —
  // this return sits outside the try/finally that owns the normal release.
  if (setup && setup.lockAcquired) {
    await agent(
      `Release the board pipeline lock: \`gh issue edit ${issue} --repo ${REPO} --remove-label "agent:in-progress"\`. Do nothing else.`,
      { label: `unlock:#${issue}`, phase: 'Setup', effort: 'low', model: 'haiku' },
    ).catch(() => {})
  }
  return { issue, aborted: setup ? setup.blocked : 'setup agent failed', prUrl: null }
}
log(`#${issue} "${setup.issueTitle}" → ${setup.branchName}`)

// Everything after the lock is wrapped so the lock is always released.
let result
try {
  // ─── Spec ──────────────────────────────────────────────────────────────
  enterPhase('Spec')
  must(await agent(
    `Write the implementation spec for GitHub issue #${issue} ("${setup.issueTitle}") in ${REPO}.
You are on branch ${setup.branchName} in the repo root. Follow the repo's /create-spec skill EXACTLY — read .claude/skills/create-spec/SKILL.md and its pre-flight + architectural-posture checklists, read the issue body and the relevant .ai/context/ files, then write ${setup.specPath}. Commit it ("spec(#${issue}): ...") and push the branch (set upstream). Update the board status to "Spec Created" per .ai/context/PROJECT_BOARD.md (best-effort). Do NOT write any implementation code.`,
    // Model pin: spec-writer.md declares sonnet; the spec is the highest-
    // leverage artifact in the pipeline (every later phase builds on it),
    // so draft it on the top tier.
    { label: `spec:#${issue}`, phase: 'Spec', agentType: 'spec-writer', model: 'fable' },
  ), 'spec')

  // ─── Spec Audit loop (tiered escalation) ───────────────────────────────
  // MODEL POLICY — deliberate, do NOT flip to Opus-first / tier-down:
  // the round that returns clean ENDS the loop and certifies the spec is
  // ready to build, so the STRONGEST reviewer must be the one that certifies.
  // We grind on sonnet to clear the obvious layer, then GATE on Opus. A clean
  // sonnet grind is NOT terminal — it only escalates; a clean Opus gate is the
  // sole exit. Once the gate reopens findings, we STAY on Opus (sonnet already
  // proved insufficient for this spec). Single reviewer here (the spec has no
  // line-by-line lens) — only the model tier changes between grind and gate.
  // (Writer/fix agents stay on fable — that's draft quality, orthogonal.)
  enterPhase('Spec Audit')
  let specClean = false
  let prevSpecFindings = null
  let specGating = false // false = sonnet grind; true = sticky Opus confirming gate
  for (let round = 1; round <= MAX_AUDIT_ROUNDS; round++) {
    // Rounds 2+ carry the prior round's findings so the reviewer verifies
    // the fixes instead of re-deriving the whole analysis cold. Still a
    // full review — clean=true only on a zero-finding pass over everything.
    const priorContext = prevSpecFindings
      ? `\nRound ${round - 1} found the following, addressed in a revision commit since:\n${findingsBlock(prevSpecFindings)}\nVerify each was genuinely resolved (not just reworded) or pushed back with a written justification inline in the spec — a justified push-back counts as addressed. Then sweep the full spec fresh for anything new.`
      : ''
    const review = await agent(
      `Audit the spec ${setup.specPath} (branch ${setup.branchName}) for GitHub issue #${issue} in ${REPO}.
Judge it as the auditor agent: completeness vs the issue's requirements, conformance to .claude/skills/create-spec/SKILL.md pre-flight checklist + .claude/rules/architecture-principles.md, realistic file lists, verification steps per sub-phase, migration numbering, and missed incomplete-chain sites (.claude/rules/workflow.md "Completeness traps"). Report ONLY genuine defects — set clean=true when nothing unaddressed remains.${priorContext}`,
      { label: `spec-audit-${specGating ? 'gate' : 'grind'}:r${round}`, phase: 'Spec Audit', agentType: 'auditor', schema: FINDINGS_SCHEMA, model: specGating ? 'opus' : 'sonnet' },
    )
    if (!review) throw new Error('spec-audit agent failed')
    if (review.findings.length === 0) {
      if (!specGating) {
        // Sonnet-clean is NOT terminal — escalate to the Opus gate to certify.
        log(`Spec audit round ${round}: sonnet grind clean — escalating to Opus confirming gate`)
        specGating = true
        continue
      }
      // A gate returning clean=false with ZERO findings is contradictory —
      // nothing actionable to fix, so treat it as clean (logged).
      if (!review.clean) {
        log(`Spec audit round ${round}: gate clean=false but zero findings — treating as clean`)
      }
      specClean = true
      log(`Spec audit converged: clean Opus gate on round ${round}`)
      break
    }
    log(`Spec audit round ${round}: ${review.findings.length} finding(s) — revising (${specGating ? 'gate/opus' : 'grind/sonnet'})`)
    prevSpecFindings = review.findings
    pushHistory(`Spec-audit round ${round} (${review.findings.length} finding(s)):\n${findingsBlock(review.findings)}`)
    must(await agent(
      `Revise the spec ${setup.specPath} on branch ${setup.branchName} to resolve every finding below (or note push-backs inline in the spec with one-line justifications). Commit ("spec(#${issue}): audit round ${round} revisions") and push.
Findings:\n${findingsBlock(review.findings)}`,
      // Same pin as the initial draft — a shallow revision pass just buys
      // another Opus audit round, which costs more than the tier bump.
      { label: `spec-fix:r${round}`, phase: 'Spec Audit', agentType: 'spec-writer', model: 'fable' },
    ), 'spec-fix')
  }
  // Deliberate asymmetry with the code-audit loop below: spec non-convergence
  // THROWS (nothing shippable exists yet — fail the run loudly), while code
  // non-convergence RETURNS a structured result (real commits exist on the
  // branch; the caller needs the branch + unresolved findings to act on).
  if (!specClean) throw new Error(`Spec audit did not converge in ${MAX_AUDIT_ROUNDS} rounds`)

  // ─── Implement ─────────────────────────────────────────────────────────
  enterPhase('Implement')
  must(await agent(
    `Implement GitHub issue #${issue} on branch ${setup.branchName} in ${REPO}, building EXACTLY what ${setup.specPath} specifies — including the tests each sub-phase's Verify section calls for. Follow every .claude/rules/ convention. Run \`pnpm --filter @orm/shared build\` + \`pnpm --filter @orm/backend typecheck\` and the affected test suites until green. Commit incrementally with descriptive messages and push. Update the board status to "Code Complete" (best-effort). Do NOT open a PR.`,
    { label: `implement:#${issue}`, phase: 'Implement', agentType: 'developer' },
  ), 'implement')

  // ─── Code Audit loop (ralph) — tiered escalation ───────────────────────
  // MODEL POLICY — deliberate, do NOT flip to Opus-first / tier-down:
  // the round that returns clean ENDS the loop and certifies "ship it", so it
  // must be the STRONGEST reviewer. We grind cheaply on sonnet (ONE combined
  // reviewer) to clear the obvious layer, then GATE on the two-lens Opus
  // fan-out (auditor + line-reviewer). A clean sonnet grind is NOT terminal —
  // it only escalates to the gate; a clean Opus gate is the sole exit. Once
  // the gate reopens findings we STAY gating (sonnet already proved
  // insufficient for this diff). Net: sonnet rates for the throwaway grind
  // rounds, Opus only where it certifies or where the cheap layer failed —
  // and the terminal verdict is always Opus. (Both discovery lenses live on
  // the gate, where discovery actually counts.)
  enterPhase('Code Audit')
  let codeClean = false
  let unresolved = []
  let gating = false // false = sonnet grind; true = sticky Opus confirming gate
  for (let round = 1; round <= MAX_AUDIT_ROUNDS; round++) {
    // Rounds 2+ pass last round's findings (held in `unresolved`) so the
    // reviewers verify the fix commits instead of re-analyzing cold. Still
    // a full-diff review — clean=true only on a zero-finding pass. The gate
    // MUST stay a full-diff sweep — never scope it to changed files, or it
    // isn't a real certification.
    const priorContext = round > 1 && unresolved.length
      ? `\nRound ${round - 1} found the following, addressed in a fix commit since:\n${findingsBlock(unresolved)}\nVerify each was genuinely fixed (or rejected with justification in the commit message), then sweep the full diff fresh for anything new or regressed.`
      : ''
    const reviewPrompt = (who) =>
      `${who} review of \`git diff origin/main...HEAD\` on branch ${setup.branchName} (issue #${issue}, spec ${setup.specPath}) in ${REPO}. Report every genuine defect with file:line; set clean=true ONLY on a zero-finding pass. This is round ${round} of a fix→re-audit loop — the loop ends on a clean pass, not on a fix.${priorContext}`

    let all
    if (!gating) {
      // Grind: one combined sonnet reviewer (architectural + line-by-line).
      const review = await agent(
        reviewPrompt('Combined architectural / spec-conformance AND line-by-line (include LOW nits)'),
        { label: `audit-grind:r${round}`, phase: 'Code Audit', agentType: 'auditor', schema: FINDINGS_SCHEMA, model: 'sonnet' },
      )
      if (!review) throw new Error('code-audit grind reviewer failed')
      all = review.findings
      if (all.length === 0) {
        // Sonnet-clean is NOT terminal — escalate to the Opus gate to certify.
        log(`Code audit round ${round}: sonnet grind clean — escalating to Opus confirming gate`)
        gating = true
        continue
      }
    } else {
      // Gate: two-lens Opus fan-out. A clean gate is the ONLY terminal state.
      const [audit, lines] = await parallel([
        () => agent(reviewPrompt('Architectural / spec-conformance'), { label: `audit-gate:r${round}`, phase: 'Code Audit', agentType: 'auditor', schema: FINDINGS_SCHEMA, model: 'opus' }),
        () => agent(reviewPrompt('Line-by-line (include LOW nits)'), { label: `lines-gate:r${round}`, phase: 'Code Audit', agentType: 'line-reviewer', schema: FINDINGS_SCHEMA, model: 'opus' }),
      ])
      if (!audit || !lines) throw new Error('code-audit gate reviewer failed')
      all = [...audit.findings, ...lines.findings]
      if ((!audit.clean || !lines.clean) && all.length === 0) {
        log(`Code audit round ${round}: gate clean=false but zero findings — treating as clean`)
      }
      if (all.length === 0) {
        codeClean = true
        log(`Code audit converged: clean Opus gate on round ${round}`)
        break
      }
      // Opus reopened findings — stay gating for the rest of the loop.
    }

    unresolved = all
    log(`Code audit round ${round}: ${all.length} finding(s) — fixing (${gating ? 'gate/opus' : 'grind/sonnet'})`)
    pushHistory(`Code-audit round ${round} (${all.length} finding(s)):\n${findingsBlock(all)}`)
    must(await agent(
      `Fix every finding below on branch ${setup.branchName} (issue #${issue}). For any you reject, add a one-line justification to the commit message. Re-run typecheck + affected tests until green, commit ("fix(#${issue}): audit round ${round} findings"), push (if the push is rejected, \`git pull --rebase origin ${setup.branchName}\` first — e.g. an accepted Copilot Autofix commit).
Findings:\n${findingsBlock(all)}`,
      { label: `code-fix:r${round}`, phase: 'Code Audit', agentType: 'developer' },
    ), 'code-fix')
  }
  if (!codeClean) {
    // Repo rule: the loop ends on a clean audit, never on a fix — and only an
    // Opus gate certifies clean, so a sonnet-clean that never reached the gate
    // is NOT convergence. Don't ship.
    const hint = gating
      ? ' (escalated to the Opus confirming gate but it did not certify clean within the round cap — raise maxAuditRounds)'
      : ''
    log(`Code audit did NOT converge in ${MAX_AUDIT_ROUNDS} rounds${hint} — stopping before Context/PR`)
    result = { issue, branch: setup.branchName, converged: false, unresolved, prUrl: null }
  } else {
    // ─── Context ─────────────────────────────────────────────────────────
    enterPhase('Context')
    must(await agent(
      `On branch ${setup.branchName}, refresh project context for the just-implemented issue #${issue} (spec ${setup.specPath}). Follow the repo's /update-context and /update-progress skills: update the relevant .ai/context/ files (CHANGELOG.md entry, BUILD_STATE.md, SCHEMA.md if migrations changed, DEFERRED_ITEMS.md if anything was deferred) and CLAUDE.md's Current Focus line. If CLAUDE.md, .claude/rules/, .claude/skills/, or .claude/agents/ changed, run \`pnpm sync-agents\` and include the regenerated files. Commit ("docs(#${issue}): context updates") and push.`,
      { label: `context:#${issue}`, phase: 'Context', agentType: 'context-updater' },
    ), 'context')

    // ─── PR ──────────────────────────────────────────────────────────────
    enterPhase('PR')
    let prUrl = null
    if (openPr) {
      const prOut = await agent(
        `Open the PR for branch ${setup.branchName} → main in ${REPO} for issue #${issue}, following .claude/agents/pr-creator.md conventions: "Closes #${issue}" in the body, structured summary from ${setup.specPath} + the audit-loop convergence note, the Claude Code footer, AND a comment on issue #${issue} announcing the PR. Leave the board status at Context Complete — per .ai/context/PROJECT_BOARD.md there is no post-PR status; Done is set only at merge by post-merge cleanup. Return ONLY the PR URL as your final text.`,
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
1. Wait ~${COPILOT_WAIT_SECONDS}s for the review to land. Your shell has a per-call timeout, so wait in chunks: run \`sleep 100\` ${Math.ceil(COPILOT_WAIT_SECONDS / 100)} times. If foreground sleep is unavailable in your environment, substitute a slow poll (e.g. \`gh pr checks ${prNumber} --watch --interval 60\` or repeated timestamped \`gh api\` calls) totaling roughly the same wait.
2. Then fetch UNRESOLVED review threads via GraphQL:
   \`gh api graphql -f query='query { repository(owner: "Digital-Synchrony", name: "ORM") { pullRequest(number: ${prNumber}) { reviewThreads(first: 100) { nodes { isResolved comments(first: 1) { nodes { path body } } } } } } }'\`
   and count nodes with isResolved=false.
3. If unresolved is 0 but the latest copilot-pull-request-reviewer review predates the latest push (check \`gh api repos/${REPO}/pulls/${prNumber}/reviews\` vs the head commit's date), poll once a minute for up to 5 more minutes for the pending review, then re-fetch threads.
Return {unresolved, threads:[{path, summary}]} — summary is the first ~300 chars of each unresolved thread's first comment. Do NOT fix anything.`,
          // No model pin: step 3's review-timestamp-vs-head-commit comparison
          // guards against silent spurious convergence — worth the default model.
          { label: `copilot-check:${labelPrefix}r${round}`, phase: 'Copilot Loop', schema: THREADS_SCHEMA, effort: 'low' },
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
          `Resolve the Copilot review feedback on PR #${prNumber} (branch ${setup.branchName}, issue #${issue}) in ${REPO}. Follow .claude/skills/resolve-copilot-feedback/SKILL.md EXACTLY: read every unresolved thread in full, fix or push back with written justification (never agree-then-ignore), run the pre-emptive sweep over touched files, ONE commit ("fix(#${issue}): apply Copilot review findings on PR #${prNumber} (round ${labelPrefix}${round})"), run typecheck + affected tests, push (rebase on the remote branch first if the push is rejected — accepted Copilot Autofix commits land remotely), then RESOLVE EVERY THREAD via the GraphQL resolveReviewThread mutation (verify zero unresolved afterward) and post the summary comment mapping findings to resolutions.
Threads at last check:\n${threadsBlock(check.threads)}`,
          { label: `copilot-fix:${labelPrefix}r${round}`, phase: 'Copilot Loop', agentType: 'developer' },
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
        `Run the repo's /learn retrospective for PR #${prNumber} (issue #${issue}, branch ${setup.branchName}) in ${REPO}. Follow .claude/skills/learn/SKILL.md EXACTLY — but the harvest step is mostly done for you: this run accumulated every audit-round finding and every Copilot thread its poller observed, below. Use it as the primary harvest source; query GitHub only for what it lacks (e.g. thread resolutions/push-backs on the PR, accepted Autofix commits), not to re-fetch what's listed. Completeness check (mandatory): run ONE GraphQL enumeration of ALL review threads on the PR (resolved + unresolved) — any thread not already in the record was created and resolved between poller rounds and must still be harvested.

=== Harvest record (this run) ===
${(() => { const tail = reviewHistory.slice(-20); const omitted = reviewHistory.length - tail.length; return (omitted > 0 ? `(${omitted} earlier round entries omitted for length — recover from GitHub if needed)\n\n` : '') + (tail.length ? tail.join('\n\n') : '(zero findings in every audit round and Copilot round this run observed)') })()}
=== End harvest record ===

Distill the recurrence-class lessons (cap 5, skip one-offs), dedup against existing .claude/rules/, .claude/skills/, and .claude/agents/ content (sharpen placement instead of duplicating), encode each lesson in its ONE right home per the skill's routing table (new rule files need a file-patterns.json entry), run \`pnpm sync-agents\`, then COMMIT ON ${setup.branchName} ("learn(#${issue}): encode review lessons from PR #${prNumber}") and PUSH so the PR is updated with the changes. Finally post a PR comment titled "📚 Learn:" listing each lesson → destination file (or stating that zero lessons survived distillation, in which case commit nothing). Return {committed, summary}: committed=true ONLY if you pushed a lesson commit; summary is one paragraph listing the files you changed (or 'no lessons encoded').`,
        { label: `learn:#${issue}`, phase: 'Learn', agentType: 'agent-manager', schema: LEARN_SCHEMA },
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
    }
  }
} finally {
  // Release the lock on EVERY exit path (success, non-convergence, throw).
  // Board status was advanced (or deliberately not) before this point, so
  // releasing here follows the lock contract in .claude/rules/workflow.md.
  await agent(
    `Release the board pipeline lock: \`gh issue edit ${issue} --repo ${REPO} --remove-label "agent:in-progress"\`. Do nothing else. If the label is already absent, that is success.`,
    { label: `unlock:#${issue}`, phase: lastPhase, effort: 'low', model: 'haiku' },
  ).catch(() => {})
}

return result
