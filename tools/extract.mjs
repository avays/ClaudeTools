// `ct extract --from <upstream>` — refresh templates/ from an upstream checkout.
//
// READ-ONLY on the upstream: this never writes to, branches, or stashes in the
// source repo. It walks templates/manifest.json, applies the unambiguous
// reverse substitutions, and writes the result under templates/.
//
// Two deliberate safety properties:
//   1. Files classified `rewrite` are staged under templates/.staged/ instead of
//      overwriting their live template — reverse substitution is lossy and those
//      files need human editorial work before they are trustworthy.
//   2. An upstream file with no manifest entry is a FAILURE, not a skip, so new
//      upstream content must be classified deliberately.
//
// Output is a report. Nothing is committed.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { ROOT, loadJson, tokenize, findAmbiguous, findResidual } from './lib.mjs';

const args = process.argv.slice(2);
const fromIdx = args.indexOf('--from');
const UPSTREAM = fromIdx >= 0 ? args[fromIdx + 1] : null;
const APPLY = args.includes('--apply');

if (!UPSTREAM) {
  console.error('usage: ct extract --from <path-to-upstream-checkout> [--apply]');
  console.error('  without --apply, reports what would change and writes nothing');
  process.exit(2);
}
if (!existsSync(UPSTREAM)) {
  console.error(`upstream not found: ${UPSTREAM}`);
  process.exit(2);
}

const manifest = loadJson(join(ROOT, 'templates/manifest.json'));

// --- Discover every candidate upstream file, so unclassified ones surface ---
const SCAN_DIRS = ['.claude/rules', '.claude/skills', '.claude/agents', '.claude/workflows', 'scripts'];
const SKIP = /(^|\/)(worktrees|node_modules|\.git)(\/|$)|settings\.local\.json|scheduled_tasks\.lock/;

function walk(dir, acc = []) {
  const abs = join(UPSTREAM, dir);
  if (!existsSync(abs)) return acc;
  for (const entry of readdirSync(abs)) {
    const rel = join(dir, entry);
    if (SKIP.test(rel)) continue;
    const st = statSync(join(UPSTREAM, rel));
    if (st.isDirectory()) walk(rel, acc);
    else acc.push(rel);
  }
  return acc;
}

const candidates = SCAN_DIRS.flatMap((d) => walk(d));
const classified = new Set(Object.keys(manifest.sources));

const unclassified = candidates.filter((f) => !classified.has(f) && !f.endsWith('.frozen-headings.txt'));
const report = { ported: [], staged: [], excluded: [], authored: [], missingUpstream: [], unclassified, ambiguous: [], residual: [] };

for (const [src, entry] of Object.entries(manifest.sources)) {
  if (entry.portability === 'excluded') { report.excluded.push({ src, reason: entry.reason }); continue; }
  // Synthetic keys — "(authored) …" for files written here rather than
  // extracted, "(split) …" for the second half of a file split across tiers.
  // They exist so `ct check --templates` can trace every template to an entry;
  // they have no upstream counterpart and must not be reported as missing.
  if (src.startsWith('(')) { report.authored.push(src); continue; }

  const abs = join(UPSTREAM, src);
  if (!existsSync(abs)) { report.missingUpstream.push(src); continue; }

  const raw = readFileSync(abs, 'utf8');
  const { text, applied } = tokenize(raw);

  const amb = findAmbiguous(text);
  if (amb.length) {
    // Dedupe by token for a readable report; keep one representative match.
    const byToken = new Map();
    for (const a of amb) if (!byToken.has(a.token)) byToken.set(a.token, a);
    report.ambiguous.push({ src, hits: amb.length, tokens: [...byToken.values()] });
  }

  const res = findResidual(text);
  if (res.length) report.residual.push({ src, findings: res });

  // `rewrite` files stage rather than overwrite — see header note 1.
  const staging = entry.portability === 'rewrite';
  const dest = staging
    ? join(ROOT, 'templates/.staged', entry.dest)
    : join(ROOT, 'templates', entry.dest);

  if (APPLY) {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, text);
  }
  (staging ? report.staged : report.ported).push({
    src,
    dest: relative(ROOT, dest),
    bytes: text.length,
    tokens: [...applied.entries()].map(([t, n]) => `${t}×${n}`),
  });
}

// --- Report ---
const line = (s = '') => console.log(s);
line(`ct extract — upstream: ${UPSTREAM}`);
line(APPLY ? '(--apply: templates written)' : '(dry run: nothing written; pass --apply to write)');
line();
line(`ported verbatim/light : ${report.ported.length}`);
line(`staged for rewrite    : ${report.staged.length}  -> templates/.staged/`);
line(`excluded by manifest  : ${report.excluded.length}`);
line(`authored here (not extracted): ${report.authored.length}`);
line();

if (report.missingUpstream.length) {
  line('MISSING UPSTREAM (manifest lists a file the upstream no longer has):');
  for (const f of report.missingUpstream) line(`  - ${f}`);
  line();
}

if (unclassified.length) {
  line('UNCLASSIFIED UPSTREAM FILES — add a manifest entry for each before porting:');
  for (const f of unclassified) line(`  - ${f}`);
  line();
}

if (report.ambiguous.length) {
  line('AMBIGUOUS SUBSTITUTIONS — NOT applied; adjudicate by hand:');
  for (const a of report.ambiguous) {
    line(`  ${a.src}  (${a.hits} hit${a.hits === 1 ? '' : 's'})`);
    for (const t of a.tokens) {
      line(`    ${t.token}: ${t.match}`);
      line(`      why: ${t.note}`);
    }
  }
  line();
}

if (report.residual.length) {
  line('RESIDUAL UPSTREAM IDENTIFIERS — porting to-do per file:');
  for (const r of report.residual) {
    const summary = r.findings.map((f) => `${f.name}×${f.count}`).join(', ');
    line(`  ${r.src}: ${summary}`);
    for (const f of r.findings) line(`      ${f.name}: ${f.sample.join(', ')}`);
  }
  line();
}

const blocking = unclassified.length + report.missingUpstream.length;
if (blocking) {
  line(`FAIL: ${blocking} file(s) need manifest attention before this extract is trustworthy.`);
  process.exit(1);
}
line('OK: every upstream file is classified.');
