// `ct diff` — show what `ct render` would change in the target, WITHOUT writing.
//
// Exists because a consumer repo accumulates local edits to rendered files. A
// blind re-render either clobbers them (with --force) or silently skips them
// (without). This makes the conflict visible before either happens.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { ROOT, loadJson, loadConfig, flattenConfig, resolveConditionals, substitute } from './lib.mjs';

const args = process.argv.slice(2);
const getArg = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const TARGET = getArg('--target', process.cwd());
const SHOW = args.includes('--full');

const cfg = loadConfig(join(TARGET, 'claudetools.config.json'));
const packs = cfg.packs ?? [];
const profile = loadJson(join(ROOT, 'templates/trackers', cfg.tracker.TRACKER_KIND, 'profile.json'));
cfg.tracker = { ...profile.tracker, ...cfg.tracker };
const tokens = flattenConfig(cfg);
for (const [k, v] of tokens) {
  if (v.includes('${REPO}')) tokens.set(k, v.split('${REPO}').join(cfg.vcs.VCS_REPO_SLUG));
}

function walk(dir, base = dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, base, acc);
    else if (!NOT_RENDERED_D.has(e)) acc.push({ abs: p, rel: relative(base, p) });
  }
  return acc;
}

const P = (k, d) => cfg.paths?.[k] ?? d;
const DIR_MAP = [
  ['rules/', P('PATHS_RULES_DIR', '.claude/rules')],
  ['skills/', P('PATHS_SKILLS_DIR', '.claude/skills')],
  ['agents/', P('PATHS_AGENTS_DIR', '.claude/agents')],
  ['workflows/', '.claude/workflows'],
  ['context/', P('PATHS_CONTEXT_DIR', '.ai/context')],
  ['scripts/', 'scripts'],
];
const destFor = (rel) => {
  for (const [pre, dir] of DIR_MAP) if (rel.startsWith(pre)) return join(dir, rel.slice(pre.length));
  return rel === 'settings.json' ? '.claude/settings.json' : rel;
};

const NOT_RENDERED_D = new Set(["patterns.json"]);
const sources = [
  ...walk(join(ROOT, 'templates/core')),
  ...packs.flatMap((p) => walk(join(ROOT, 'templates/packs', p))),
];

const added = [], changed = [], same = [];
for (const src of sources) {
  const dest = destFor(src.rel, src);
  const destAbs = join(TARGET, dest);
  const raw = readFileSync(src.abs, 'utf8');
  const { text } = substitute(resolveConditionals(raw, tokens, packs), tokens);
  if (text.trim() === '') continue;
  if (!existsSync(destAbs)) { added.push(dest); continue; }
  const cur = readFileSync(destAbs, 'utf8');
  if (cur === text) same.push(dest);
  else {
    // Line-level counts give a sense of scale without shelling out to diff.
    const a = cur.split('\n'), b = text.split('\n');
    changed.push({ dest, curLines: a.length, newLines: b.length, delta: b.length - a.length, cur, next: text });
  }
}

console.log(`ct diff → ${TARGET}`);
console.log(`  unchanged: ${same.length}   new: ${added.length}   would change: ${changed.length}\n`);

if (added.length) {
  console.log('NEW (render would create):');
  for (const f of added) console.log(`  + ${f}`);
  console.log();
}
if (changed.length) {
  console.log('CHANGED (render would overwrite — local edits here would be LOST with --force):');
  for (const c of changed) {
    const sign = c.delta > 0 ? `+${c.delta}` : `${c.delta}`;
    console.log(`  ~ ${c.dest}  (${c.curLines} → ${c.newLines} lines, ${sign})`);
    if (SHOW) {
      const a = c.cur.split('\n'), b = c.next.split('\n');
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) {
          if (a[i] !== undefined) console.log(`      - ${a[i]}`);
          if (b[i] !== undefined) console.log(`      + ${b[i]}`);
        }
      }
    }
  }
  console.log();
  console.log('Local customisation belongs in files ClaudeTools does not own.');
  console.log('Pass --full to see line-level differences.');
}
process.exit(0);
