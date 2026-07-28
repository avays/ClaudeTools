// `ct init` — write a claudetools.config.json for a target repo.
//
// Interactive by default; every prompt also has a --flag so CI and the
// validation harness can drive it non-interactively.
import { writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ROOT, loadJson } from './lib.mjs';

const args = process.argv.slice(2);
const getArg = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const TARGET = getArg('--target', process.cwd());
const NONINTERACTIVE = args.includes('--yes');
const OUT = join(TARGET, 'claudetools.config.json');

if (existsSync(OUT) && !args.includes('--force')) {
  console.error(`${OUT} already exists — pass --force to overwrite.`);
  process.exit(2);
}

const availablePacks = readdirSync(join(ROOT, 'templates/packs'));

// Sensible per-manager command sets, so the common case needs no typing.
const PKG_PRESETS = {
  pnpm: { PKG_INSTALL: 'pnpm install', PKG_BUILD: 'pnpm build', PKG_TYPECHECK: 'pnpm typecheck', PKG_TEST: 'pnpm test', PKG_LINT: 'pnpm lint' },
  npm:  { PKG_INSTALL: 'npm install',  PKG_BUILD: 'npm run build', PKG_TYPECHECK: 'npm run typecheck', PKG_TEST: 'npm test', PKG_LINT: 'npm run lint' },
  yarn: { PKG_INSTALL: 'yarn install', PKG_BUILD: 'yarn build', PKG_TYPECHECK: 'yarn typecheck', PKG_TEST: 'yarn test', PKG_LINT: 'yarn lint' },
  bun:  { PKG_INSTALL: 'bun install',  PKG_BUILD: 'bun run build', PKG_TYPECHECK: 'bun run typecheck', PKG_TEST: 'bun test', PKG_LINT: 'bun run lint' },
  none: { PKG_INSTALL: '', PKG_BUILD: '', PKG_TYPECHECK: '', PKG_TEST: '', PKG_LINT: '' },
};

const VOCAB_PRESETS = {
  github: { VOCAB_ISSUE: 'issue', VOCAB_ISSUES: 'issues', VOCAB_ISSUE_CAP: 'Issue', VOCAB_BOARD: 'project board' },
  jira:   { VOCAB_ISSUE: 'ticket', VOCAB_ISSUES: 'tickets', VOCAB_ISSUE_CAP: 'Ticket', VOCAB_BOARD: 'JIRA board' },
  none:   { VOCAB_ISSUE: 'issue', VOCAB_ISSUES: 'issues', VOCAB_ISSUE_CAP: 'Issue', VOCAB_BOARD: 'backlog' },
};

// A dangling "PR: " line with no URL is worse than omitting the convention,
// so a host with no known URL shape renders the omit-branch instead.
const REPO_URLS = {
  github: (slug) => `https://github.com/${slug}`,
  gitlab: (slug) => `https://gitlab.com/${slug}`,
  bitbucket: (slug) => `https://bitbucket.org/${slug}`,
};

const PR_URL_FORMATS = {
  github: (slug) => `https://github.com/${slug}/pull/\${PR}`,
  gitlab: (slug) => `https://gitlab.com/${slug}/-/merge_requests/\${PR}`,
};

const VCS_PRESETS = {
  github: {
    VCS_CREATE_PR: 'gh pr create --repo ${REPO} --base ${BASE} --title ${TITLE} --body ${BODY}',
    VCS_CREATE_DRAFT_PR: 'gh pr create --draft --repo ${REPO} --base ${BASE} --title ${TITLE} --body ${BODY}',
    VCS_VIEW_PR: 'gh pr view ${PR} --repo ${REPO}',
    VCS_PR_CHECKS: 'gh pr checks ${PR} --repo ${REPO}',
    VCS_MARK_READY: 'gh pr ready ${PR} --repo ${REPO}',
    VCS_LIST_REVIEW_THREADS: 'gh api graphql -f query=\'query { repository(owner: "${OWNER}", name: "${NAME}") { pullRequest(number: ${PR}) { reviewThreads(first: 100) { nodes { id isResolved comments(first: 1) { nodes { path body } } } } } } }\'',
    VCS_RESOLVE_THREAD: 'gh api graphql -f query=\'mutation { resolveReviewThread(input: {threadId: "${THREAD}"}) { thread { isResolved } } }\'',
    VCS_RERUN_FAILED_CHECKS: 'gh run rerun ${RUN} --failed',
  },
  gitlab: {
    VCS_CREATE_PR: 'glab mr create --target-branch ${BASE} --title ${TITLE} --description ${BODY}',
    VCS_CREATE_DRAFT_PR: 'glab mr create --draft --target-branch ${BASE} --title ${TITLE} --description ${BODY}',
    VCS_VIEW_PR: 'glab mr view ${PR}',
    VCS_PR_CHECKS: 'glab ci status',
    VCS_MARK_READY: 'glab mr update ${PR} --ready',
    VCS_LIST_REVIEW_THREADS: 'glab api projects/:id/merge_requests/${PR}/discussions',
    VCS_RESOLVE_THREAD: '',
    VCS_RERUN_FAILED_CHECKS: 'glab ci retry',
  },
  bitbucket: {
    VCS_CREATE_PR: '', VCS_CREATE_DRAFT_PR: '', VCS_VIEW_PR: '', VCS_PR_CHECKS: '',
    VCS_MARK_READY: '', VCS_LIST_REVIEW_THREADS: '', VCS_RESOLVE_THREAD: '', VCS_RERUN_FAILED_CHECKS: '',
  },
  none: {
    VCS_CREATE_PR: '', VCS_CREATE_DRAFT_PR: '', VCS_VIEW_PR: '', VCS_PR_CHECKS: '',
    VCS_MARK_READY: '', VCS_LIST_REVIEW_THREADS: '', VCS_RESOLVE_THREAD: '', VCS_RERUN_FAILED_CHECKS: '',
  },
};

async function main() {
  let answers;

  if (NONINTERACTIVE) {
    answers = {
      name: getArg('--name', 'My Project'),
      description: getArg('--description', ''),
      branch: getArg('--branch', 'main'),
      tracker: getArg('--tracker', 'github'),
      vcs: getArg('--vcs', 'github'),
      slug: getArg('--slug', 'owner/repo'),
      pkgManager: getArg('--pkg', 'npm'),
      packs: (getArg('--packs', '') || '').split(',').filter(Boolean),
      srcGlobs: getArg('--src', 'src'),
      ci: getArg('--ci', 'none'),
      reviewer: getArg('--reviewer', 'the automated reviewer'),
    };
  } else {
    const rl = createInterface({ input: stdin, output: stdout });
    const ask = async (q, dflt) => {
      const a = (await rl.question(`${q}${dflt ? ` [${dflt}]` : ''}: `)).trim();
      return a || dflt;
    };
    console.log('ClaudeTools init — answers become claudetools.config.json.\n');
    answers = {
      name: await ask('Project name', 'My Project'),
      description: await ask('One-line description', ''),
      branch: await ask('Main branch', 'main'),
      tracker: await ask('Issue tracker (github|jira|none)', 'github'),
      vcs: await ask('Code host (github|gitlab|bitbucket|none)', 'github'),
      slug: await ask('Repo slug (owner/name)', 'owner/repo'),
      pkgManager: await ask('Package manager (pnpm|npm|yarn|bun|none)', 'npm'),
      srcGlobs: await ask('First-party source globs (space-separated, git-ls-files style)', 'src'),
      packs: (await ask(`Packs to install, comma-separated (${availablePacks.join(', ')})`, '')).split(',').map((s) => s.trim()).filter(Boolean),
      ci: await ask('CI wiring (github-actions|gitlab-ci|none)', 'none'),
      reviewer: await ask('Name of your bot reviewer, if any', 'the automated reviewer'),
    };
    rl.close();
  }

  const badPacks = answers.packs.filter((p) => !availablePacks.includes(p));
  if (badPacks.length) {
    console.error(`Unknown pack(s): ${badPacks.join(', ')}\nAvailable: ${availablePacks.join(', ')}`);
    process.exit(2);
  }

  const profile = loadJson(join(ROOT, 'templates/trackers', answers.tracker, 'profile.json'));
  const [owner, name] = answers.slug.split('/');
  const vcsPreset = Object.fromEntries(
    Object.entries(VCS_PRESETS[answers.vcs] ?? VCS_PRESETS.none).map(([k, v]) => [
      k,
      v.split('${REPO}').join(answers.slug).split('${OWNER}').join(owner ?? '').split('${NAME}').join(name ?? ''),
    ]),
  );

  const cfg = {
    $schema: './claudetools.config.schema.json',
    project: {
      PROJECT_NAME: answers.name,
      PROJECT_DESCRIPTION: answers.description,
      PROJECT_MAIN_BRANCH: answers.branch,
      PROJECT_ROOT_DOC: 'CLAUDE.md',
    },
    // Profile defaults are inlined rather than left implicit so the file is a
    // complete, greppable record of what the pipeline will actually run.
    tracker: { ...profile.tracker },
    vcs: {
      VCS_KIND: answers.vcs,
      VCS_REPO_SLUG: answers.slug,
      VCS_REPO_URL: REPO_URLS[answers.vcs] ? REPO_URLS[answers.vcs](answers.slug) : '',
      VCS_DEFAULT_BASE: answers.branch,
      ...vcsPreset,
      VCS_PR_URL_FORMAT: PR_URL_FORMATS[answers.vcs] ? PR_URL_FORMATS[answers.vcs](answers.slug) : '',
    },
    vocab: {
      ...VOCAB_PRESETS[answers.tracker] ?? VOCAB_PRESETS.none,
      VOCAB_PR: answers.vcs === 'gitlab' ? 'MR' : 'PR',
      VOCAB_PRS: answers.vcs === 'gitlab' ? 'MRs' : 'PRs',
      VOCAB_REVIEWER: answers.reviewer,
    },
    pkg: { PKG_MANAGER: answers.pkgManager, ...(PKG_PRESETS[answers.pkgManager] ?? PKG_PRESETS.none), PKG_SYNC_AGENTS: '' },
    paths: {
      PATHS_RULES_DIR: '.claude/rules',
      PATHS_SKILLS_DIR: '.claude/skills',
      PATHS_AGENTS_DIR: '.claude/agents',
      PATHS_SPECS_DIR: '.ai/specs',
      PATHS_CONTEXT_DIR: '.ai/context',
      PATHS_SRC_GLOBS: answers.srcGlobs,
    },
    packs: answers.packs,
    ci: { CI_KIND: answers.ci },
  };

  // Substitute the repo slug into the tracker profile's command strings now, so
  // the written config contains runnable commands rather than half-templates.
  for (const [k, v] of Object.entries(cfg.tracker)) {
    if (typeof v === 'string' && v.includes('${REPO}')) cfg.tracker[k] = v.split('${REPO}').join(answers.slug);
  }

  writeFileSync(OUT, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`\nWrote ${OUT}`);
  if (answers.tracker === 'jira') {
    console.log('\nNOTE (jira): the agent lock is NOT atomic the way GitHub labels are.');
    console.log('Read templates/trackers/jira/profile.json "notes" before running a parallel agent fleet.');
  }
  console.log('\nNext: ct render --target <repo>');
}

main();
