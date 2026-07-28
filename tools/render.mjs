// `ct render` — write a configured .claude/ toolchain into a target repo.
//
// Order matters and is load-bearing:
//   1. merge the tracker profile's defaults under the user's config
//   2. resolve conditional blocks (so a pack-gated cross-reference disappears
//      rather than rendering as a dangling path)
//   3. substitute tokens
//   4. write
//   5. GENERATE rule-budgets.json from the RENDERED bytes — never copy upstream
//      numbers, because substitution changes byte counts
//   6. generate file-patterns.json from the rule set that actually installed
//
// Steps 5 and 6 must follow the writes: both are derived from what landed on
// disk, not from what the templates contain.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, loadJson, loadConfig, flattenConfig, resolveConditionals, substitute } from './lib.mjs';

const args = process.argv.slice(2);
const getArg = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : dflt; };
const TARGET = getArg('--target', process.cwd());
const CONFIG = getArg('--config', join(TARGET, 'claudetools.config.json'));
const DRY = args.includes('--dry-run');
const FORCE = args.includes('--force');

const cfg = loadConfig(CONFIG);
const packs = cfg.packs ?? [];

// --- 1. tracker profile defaults ---------------------------------------------
const profilePath = join(ROOT, 'templates/trackers', cfg.tracker.TRACKER_KIND, 'profile.json');
if (!existsSync(profilePath)) {
  console.error(`Unknown tracker kind '${cfg.tracker.TRACKER_KIND}' — no profile at ${profilePath}`);
  process.exit(2);
}
const profile = loadJson(profilePath);
// User config wins over profile defaults; profile fills every token the user omitted.
cfg.tracker = { ...profile.tracker, ...cfg.tracker };

const tokens = flattenConfig(cfg);
// The profile's command strings themselves reference ${REPO}; resolve that one
// indirection now so templates never see a half-resolved command.
for (const [k, v] of tokens) {
  if (v.includes('${REPO}')) tokens.set(k, v.split('${REPO}').join(cfg.vcs.VCS_REPO_SLUG));
}

// --- collect source files -----------------------------------------------------
// A pack's patterns.json is CONSUMED by the file-patterns generator below, not
// rendered — emitting it would drop a stray fragment at the target's root.
const NOT_RENDERED = new Set(['patterns.json']);

function walk(dir, base = dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, base, acc);
    else if (!NOT_RENDERED.has(e)) acc.push({ abs: p, rel: relative(base, p) });
  }
  return acc;
}

const ciKind = cfg.ci?.CI_KIND ?? 'none';
const sources = [
  ...walk(join(ROOT, 'templates/core')).map((f) => ({ ...f, tier: 'core' })),
  ...packs.flatMap((p) =>
    walk(join(ROOT, 'templates/packs', p)).map((f) => ({ ...f, tier: `pack:${p}` })),
  ),
  // CI templates carry their own destination convention per provider, so they
  // are collected separately rather than going through DIR_MAP.
  ...(ciKind === 'none'
    ? []
    : walk(join(ROOT, 'templates/ci', ciKind)).map((f) => ({ ...f, tier: 'ci', ci: true }))),
];

if (packs.some((p) => !existsSync(join(ROOT, 'templates/packs', p)))) {
  const bad = packs.filter((p) => !existsSync(join(ROOT, 'templates/packs', p)));
  console.error(`Unknown pack(s): ${bad.join(', ')}`);
  console.error(`Available: ${readdirSync(join(ROOT, 'templates/packs')).join(', ')}`);
  process.exit(2);
}

// --- destination mapping ------------------------------------------------------
const P = (k, d) => cfg.paths?.[k] ?? d;
const DIR_MAP = [
  ['rules/',     P('PATHS_RULES_DIR', '.claude/rules')],
  ['skills/',    P('PATHS_SKILLS_DIR', '.claude/skills')],
  ['agents/',    P('PATHS_AGENTS_DIR', '.claude/agents')],
  ['workflows/', '.claude/workflows'],
  ['context/',   P('PATHS_CONTEXT_DIR', '.ai/context')],
  ['scripts/',   'scripts'],
];

const CI_DEST = { 'github-actions': '.github/workflows', 'gitlab-ci': '.' };

function destFor(rel, src) {
  if (src?.ci) return join(CI_DEST[ciKind] ?? '.', rel);
  for (const [prefix, dir] of DIR_MAP) {
    if (rel.startsWith(prefix)) return join(dir, rel.slice(prefix.length));
  }
  if (rel === 'settings.json') return '.claude/settings.json';
  // The root agent-instruction file is named by config (CLAUDE.md, AGENTS.md,
  // …) rather than fixed, so it cannot go in DIR_MAP.
  if (rel === 'root-doc.md') return cfg.project?.PROJECT_ROOT_DOC ?? 'CLAUDE.md';
  return rel;
}

// --- render -------------------------------------------------------------------
const written = [];
const skipped = [];
const missingTokens = new Set();
const BINARY = new Set(['.png', '.jpg', '.gif', '.ico']);

for (const src of sources) {
  const dest = destFor(src.rel, src);
  const destAbs = join(TARGET, dest);

  if (BINARY.has(extname(src.abs))) { skipped.push({ dest, why: 'binary' }); continue; }

  const raw = readFileSync(src.abs, 'utf8');
  const conditioned = resolveConditionals(raw, tokens, packs);
  const { text, missing } = substitute(conditioned, tokens);
  missing.forEach((m) => missingTokens.add(m));

  // A file that resolved to nothing but whitespace was entirely inside a
  // false conditional — don't write an empty artifact.
  if (text.trim() === '') { skipped.push({ dest, why: 'empty after conditionals' }); continue; }

  if (!DRY) {
    if (existsSync(destAbs) && !FORCE) {
      const cur = readFileSync(destAbs, 'utf8');
      if (cur !== text) { skipped.push({ dest, why: 'exists and differs — pass --force to overwrite, or run `ct diff` first' }); continue; }
    }
    mkdirSync(dirname(destAbs), { recursive: true });
    writeFileSync(destAbs, text);
    if (extname(dest) === '.sh') chmodSync(destAbs, 0o755);
  }
  written.push({ dest, bytes: text.length, tier: src.tier });
}

// --- 5. GENERATE rule-budgets.json from rendered bytes -------------------------
// Upstream's numbers are meaningless here: substituting {{VCS_REPO_SLUG}} (19 B)
// with a real slug (21 B) shifts every file's size. Caps are derived from what
// actually landed, +15% headroom, and totalCap is their exact sum so the two
// constraints in check-rule-budget.sh can never disagree.
const HEADROOM = 1.15;
const rulesDir = join(TARGET, P('PATHS_RULES_DIR', '.claude/rules'));
let budgets = null;
if (!DRY && existsSync(rulesDir)) {
  const files = {};
  for (const f of readdirSync(rulesDir).filter((f) => f.endsWith('.md'))) {
    files[f.replace(/\.md$/, '')] = Math.ceil(statSync(join(rulesDir, f)).size * HEADROOM);
  }
  const totalCap = Object.values(files).reduce((a, b) => a + b, 0);
  budgets = {
    _comment: `Per-file byte caps for ${P('PATHS_RULES_DIR', '.claude/rules')}/*.md. Generated by \`ct render\` from rendered sizes +${Math.round((HEADROOM - 1) * 100)}%. totalCap = sum of per-file caps so the two constraints cannot disagree. Enforced by scripts/check-rule-budget.sh. New rule files: add an entry at introduction size +${Math.round((HEADROOM - 1) * 100)}%, and add the same amount to totalCap.`,
    files,
    totalCap,
  };
  writeFileSync(join(rulesDir, 'rule-budgets.json'), JSON.stringify(budgets, null, 2) + '\n');
}

// --- 6. GENERATE file-patterns.json from the installed rule set ----------------
// Upstream's glob values point at upstream paths. Each pack ships a
// patterns.json fragment; core rules default to always-on ("**").
if (!DRY && existsSync(rulesDir)) {
  const patterns = {};
  for (const f of readdirSync(rulesDir).filter((f) => f.endsWith('.md'))) {
    patterns[f.replace(/\.md$/, '')] = '**';
  }
  for (const p of packs) {
    const frag = join(ROOT, 'templates/packs', p, 'patterns.json');
    if (!existsSync(frag)) continue;
    // Fragment VALUES carry tokens too ({{PATHS_SRC_GLOBS}}/**/*.ts) — substitute
    // them, or the glob ships literal and the rule is scoped to a path that
    // does not exist, which silently means "never loaded".
    const { text } = substitute(readFileSync(frag, 'utf8'), tokens);
    Object.assign(patterns, JSON.parse(text));
  }
  writeFileSync(join(rulesDir, 'file-patterns.json'), JSON.stringify(patterns, null, 2) + '\n');
}

// --- 7. frozen headings (requires a git repo in the target) --------------------
let frozenNote = '';
if (!DRY) {
  const builder = join(TARGET, 'scripts/build-frozen-headings.sh');
  const isGit = existsSync(join(TARGET, '.git'));
  if (!isGit) {
    frozenNote = 'SKIPPED — target is not a git repo. Run scripts/build-frozen-headings.sh after `git init` + first commit.';
  } else if (!existsSync(builder)) {
    frozenNote = 'SKIPPED — builder not rendered.';
  } else {
    try {
      execFileSync('bash', [builder], { cwd: TARGET, stdio: 'pipe' });
      const out = join(rulesDir, '.frozen-headings.txt');
      frozenNote = existsSync(out)
        ? `generated ${readFileSync(out, 'utf8').split('\n').filter(Boolean).length} entries`
        : 'builder ran but produced no output';
    } catch (err) {
      // Non-fatal: the builder needs tracked files, which a fresh target lacks
      // until its first commit. Everything else has already rendered.
      frozenNote = `SKIPPED — builder failed (${String(err.message).split('\n')[0]}). Re-run scripts/build-frozen-headings.sh after committing.`;
    }
  }
}

// --- report -------------------------------------------------------------------
console.log(`ct render → ${TARGET}${DRY ? '  (dry run)' : ''}`);
console.log(`  tracker: ${cfg.tracker.TRACKER_KIND}   vcs: ${cfg.vcs.VCS_KIND}   packs: ${packs.length ? packs.join(', ') : '(none)'}`);
console.log(`  written: ${written.length} file(s)`);
if (budgets) console.log(`  rule budgets: ${Object.keys(budgets.files).length} rules, totalCap ${budgets.totalCap} B (generated from rendered sizes)`);
if (frozenNote) console.log(`  frozen headings: ${frozenNote}`);

if (skipped.length) {
  console.log(`  skipped: ${skipped.length}`);
  for (const s of skipped) console.log(`    - ${s.dest}: ${s.why}`);
}
if (missingTokens.size) {
  console.log('\nUNRESOLVED TOKENS — these appear in templates but not in your config:');
  for (const t of [...missingTokens].sort()) console.log(`  {{${t}}}`);
  console.log('Add them to claudetools.config.json (or the tracker profile) and re-render.');
  process.exit(1);
}
console.log('\nOK. Run `ct check` to verify the result.');
