// `ct check` — verify a rendered target (or, with --templates, the ClaudeTools
// repo itself). Every check here is one that has a real failure mode behind it;
// none is decorative.
import { readFileSync, existsSync, readdirSync, statSync, accessSync, constants } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { ROOT, loadJson, loadConfig, schemaTokens, TOKEN_RE } from './lib.mjs';

const args = process.argv.slice(2);
const getArg = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const TEMPLATES_MODE = args.includes('--templates');
const TARGET = getArg('--target', process.cwd());

let failures = 0;
let warnings = 0;
const fail = (msg) => { console.log(`FAIL  ${msg}`); failures++; };
const warn = (msg) => { console.log(`WARN  ${msg}`); warnings++; };
const ok = (msg) => console.log(`ok    ${msg}`);

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e === '.git' || e === 'node_modules') continue;
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

const TEXT = new Set(['.md', '.json', '.sh', '.mjs', '.js', '.yml', '.yaml', '.txt']);

// =============================================================================
// Templates mode — hygiene of the ClaudeTools repo itself
// =============================================================================
if (TEMPLATES_MODE) {
  console.log('ct check --templates\n');
  const schema = schemaTokens();
  const files = walk(join(ROOT, 'templates')).filter((f) => TEXT.has(extname(f)) && !f.includes('/.staged/'));

  const used = new Set();
  // Tokens appear in two syntaxes: plain {{TOKEN}} substitution, and inside
  // conditional heads ({{#if TRACKER_KIND=github}}). Counting only the first
  // reports a token that gates whole sections as dead.
  const COND_RE = /\{\{#(?:if|unless) ([A-Z][A-Z0-9_]*)(?:=[^}]*)?\}\}/g;
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(TOKEN_RE)) used.add(m[1]);
    for (const m of text.matchAll(COND_RE)) used.add(m[1]);
  }

  // A token used in a template but absent from the schema can never be
  // rendered — it would survive substitution and ship as literal `{{FOO}}`.
  const undefinedTokens = [...used].filter((t) => !schema.has(t));
  if (undefinedTokens.length) {
    for (const t of undefinedTokens.sort()) fail(`token {{${t}}} used in templates but not defined in claudetools.config.schema.json`);
  } else ok(`all ${used.size} tokens used in templates are schema-defined`);

  // Dead vocabulary: a schema token no template uses is config surface that
  // does nothing — it misleads whoever fills it in.
  //
  // Exception: a few tokens are consumed by the TOOLCHAIN rather than
  // substituted into a template — they select a profile directory, name a
  // destination, or pick a preset. They are legitimately absent from every
  // template and must not be reported as dead.
  const TOOLING_ONLY = new Set(['TRACKER_KIND', 'VCS_KIND', 'CI_KIND', 'PKG_MANAGER']);
  const dead = [...schema].filter((t) => !used.has(t) && !TOOLING_ONLY.has(t));
  if (dead.length) {
    for (const t of dead.sort()) warn(`schema token ${t} is never used by any template (dead vocabulary)`);
  } else ok('no dead vocabulary in the schema');

  // Manifest completeness against what actually exists under templates/.
  const manifest = loadJson(join(ROOT, 'templates/manifest.json'));
  const dests = new Set(
    Object.values(manifest.sources)
      .filter((e) => e.dest && e.dest !== 'GENERATED')
      .map((e) => e.dest),
  );
  const onDisk = files
    .map((f) => relative(join(ROOT, 'templates'), f))
    .filter((f) => f !== 'manifest.json' && !f.startsWith('trackers/') && !f.startsWith('ci/') && !f.endsWith('patterns.json'));
  const orphans = onDisk.filter((f) => !dests.has(f));
  if (orphans.length) {
    for (const f of orphans) warn(`templates/${f} has no manifest entry pointing at it`);
  } else ok(`all ${onDisk.length} template files trace to a manifest entry`);

  const staged = walk(join(ROOT, 'templates/.staged'));
  if (staged.length) warn(`${staged.length} file(s) still staged in templates/.staged/ — these need editorial work before they render`);

  console.log(`\n${failures} failure(s), ${warnings} warning(s)`);
  process.exit(failures ? 1 : 0);
}

// =============================================================================
// Target mode — verify a rendered repo
// =============================================================================
console.log(`ct check → ${TARGET}\n`);

const cfgPath = join(TARGET, 'claudetools.config.json');
let cfg = null;
try { cfg = loadConfig(cfgPath); } catch { fail(`no claudetools.config.json in ${TARGET}`); }
const P = (k, d) => cfg?.paths?.[k] ?? d;

const rulesDir = join(TARGET, P('PATHS_RULES_DIR', '.claude/rules'));
const scanDirs = [
  P('PATHS_RULES_DIR', '.claude/rules'),
  P('PATHS_SKILLS_DIR', '.claude/skills'),
  P('PATHS_AGENTS_DIR', '.claude/agents'),
  '.claude/workflows',
  'scripts',
].map((d) => join(TARGET, d));

// --- 1. no unrendered tokens --------------------------------------------------
// The failure this catches: a template token with no config value survives
// substitution and ships as a literal {{FOO}} into an agent's instructions,
// where it reads as a real instruction the agent cannot satisfy.
const rendered = [...scanDirs.flatMap((d) => walk(d)), join(TARGET, cfg?.project?.PROJECT_ROOT_DOC ?? 'CLAUDE.md')]
  .filter((f) => existsSync(f) && TEXT.has(extname(f)));
const leaked = [];
// Two syntaxes leak, and they fail differently. A stray {{TOKEN}} reads to an
// agent as an instruction it cannot satisfy. A stray {{#if ...}} block means an
// ENTIRE section was neither included nor excluded — and in a JSON artifact it
// also makes the file unparseable, which is how this check earned its place.
const LEFTOVER_COND = /\{\{[#/](?:if|unless)[^}]*\}\}/g;
for (const f of rendered) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(TOKEN_RE)) leaked.push(`${relative(TARGET, f)}: {{${m[1]}}}`);
  for (const m of text.matchAll(LEFTOVER_COND)) leaked.push(`${relative(TARGET, f)}: unresolved conditional ${m[0]}`);
}
if (leaked.length) {
  for (const l of leaked.slice(0, 20)) fail(`unrendered — ${l}`);
  if (leaked.length > 20) fail(`... and ${leaked.length - 20} more`);
} else ok(`no unrendered tokens or conditionals across ${rendered.length} rendered file(s)`);

// --- 1b. rendered JSON must parse ---------------------------------------------
// settings.json is assembled from conditional lines; a mis-resolved block leaves
// syntactically invalid JSON that the harness rejects at load with no useful
// message. Cheap to verify here.
for (const f of rendered.filter((f) => extname(f) === '.json')) {
  try { JSON.parse(readFileSync(f, 'utf8')); }
  catch (err) { fail(`invalid JSON after render — ${relative(TARGET, f)}: ${err.message}`); }
}

// --- 2/3. rule governance wiring ---------------------------------------------
if (existsSync(rulesDir)) {
  const ruleNames = readdirSync(rulesDir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));

  const budgetPath = join(rulesDir, 'rule-budgets.json');
  if (!existsSync(budgetPath)) fail('rule-budgets.json missing — check-rule-budget.sh will exit 2 on every run');
  else {
    const b = loadJson(budgetPath);
    const missing = ruleNames.filter((n) => !Object.hasOwn(b.files, n));
    const stale = Object.keys(b.files).filter((n) => !ruleNames.includes(n));
    if (missing.length) fail(`rules with no budget entry: ${missing.join(', ')}`);
    if (stale.length) fail(`stale budget entries (no matching .md): ${stale.join(', ')}`);

    // The invariant check-rule-budget.sh enforces at CI time, verified here too
    // so a hand-edit is caught before it reaches CI.
    const sum = Object.values(b.files).reduce((a, c) => a + c, 0);
    if (sum !== b.totalCap) fail(`budget invariant broken: sum(files)=${sum} != totalCap=${b.totalCap} (delta ${sum - b.totalCap})`);

    // Over-budget on a fresh render means the generator is wrong, not the rules.
    const over = ruleNames.filter((n) => statSync(join(rulesDir, `${n}.md`)).size > (b.files[n] ?? 0));
    if (over.length) fail(`already over budget at render time: ${over.join(', ')}`);

    if (!missing.length && !stale.length && sum === b.totalCap && !over.length) {
      ok(`rule budgets: ${ruleNames.length} rules, totalCap ${b.totalCap} B, invariant holds`);
    }
  }

  const patPath = join(rulesDir, 'file-patterns.json');
  if (!existsSync(patPath)) fail('file-patterns.json missing — rules have no path scoping');
  else {
    const p = loadJson(patPath);
    const missing = ruleNames.filter((n) => !Object.hasOwn(p, n));
    const stale = Object.keys(p).filter((n) => !ruleNames.includes(n));
    if (missing.length) fail(`rules with no file-patterns entry (never loaded): ${missing.join(', ')}`);
    if (stale.length) warn(`stale file-patterns entries: ${stale.join(', ')}`);
    if (!missing.length && !stale.length) ok(`file-patterns: all ${ruleNames.length} rules scoped`);
  }

  const frozen = join(rulesDir, '.frozen-headings.txt');
  if (!existsSync(frozen)) warn('.frozen-headings.txt not generated — check-rule-preservation.sh will skip its heading check (run scripts/build-frozen-headings.sh)');
  else ok(`.frozen-headings.txt present (${readFileSync(frozen, 'utf8').split('\n').filter(Boolean).length} entries)`);
} else fail(`rules dir not found: ${rulesDir}`);

// --- 4. scripts are executable ------------------------------------------------
const shs = walk(join(TARGET, 'scripts')).filter((f) => f.endsWith('.sh'));
const notExec = shs.filter((f) => { try { accessSync(f, constants.X_OK); return false; } catch { return true; } });
if (notExec.length) for (const f of notExec) fail(`not executable: ${relative(TARGET, f)}`);
else if (shs.length) ok(`all ${shs.length} shell script(s) executable`);

// --- 5. tracker coherence -----------------------------------------------------
// Rendering board-status instructions into a repo whose tracker has no board
// tells an agent to run a command that does not exist.
// Host-vocabulary leakage: prose naming a host this repo does not use. A JIRA
// shop reading "create a GitHub issue" either follows a instruction it cannot
// carry out, or learns to distrust the rules file. Code fences are excluded —
// the orchestration files intentionally keep GitHub's exact commands under a
// documented "host-specific" banner.
if (cfg) {
  const HOSTS = { github: /\bGitHub\b|\bgh (issue|pr|api|run) /, gitlab: /\bGitLab\b|\bglab /, jira: /\bJIRA\b|\bjira / };
  const mine = new Set([cfg.tracker.TRACKER_KIND, cfg.vcs.VCS_KIND]);
  const stripFences = (s) => s.replace(/```[\s\S]*?```/g, '').replace(/^\s*[#>].*$/gm, '');
  // A file may legitimately show one host's exact commands as worked examples —
  // the orchestration layer does, deliberately. It opts out by declaring so,
  // which keeps the acknowledgement visible to a reader instead of buried in an
  // allowlist here. Accidental leakage still warns.
  const ACK = /<!--\s*host-specific:/;
  const leaks = [];
  for (const f of rendered.filter((f) => extname(f) === '.md')) {
    const raw = readFileSync(f, 'utf8');
    if (ACK.test(raw)) continue;
    const prose = stripFences(raw);
    for (const [host, re] of Object.entries(HOSTS)) {
      if (mine.has(host)) continue;
      const m = prose.match(re);
      if (m) leaks.push(`${relative(TARGET, f)}: mentions ${host} ("${m[0].trim()}") but this repo uses ${[...mine].join('/')}`);
    }
  }
  if (leaks.length) {
    for (const l of leaks.slice(0, 10)) warn(`host leakage — ${l}`);
    if (leaks.length > 10) warn(`... and ${leaks.length - 10} more host-vocabulary leaks`);
  } else ok('no foreign host vocabulary in rendered prose');
}

if (cfg && cfg.tracker.TRACKER_SET_STATUS === '' ) {
  const boardProse = rendered.filter((f) => /board status|move the board|board-status/i.test(readFileSync(f, 'utf8')));
  if (boardProse.length) warn(`tracker has no board (TRACKER_SET_STATUS empty) but ${boardProse.length} rendered file(s) still discuss board status — review: ${boardProse.slice(0, 3).map((f) => relative(TARGET, f)).join(', ')}`);
  else ok('no board prose rendered for a boardless tracker');
}

console.log(`\n${failures} failure(s), ${warnings} warning(s)`);
process.exit(failures ? 1 : 0);
