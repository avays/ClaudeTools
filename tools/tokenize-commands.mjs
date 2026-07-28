// `node tools/tokenize-commands.mjs <file...>` — second-pass tokenizer for the
// command forms `ct extract` deliberately refuses to auto-apply.
//
// extract.mjs only applies substitutions that are safe by construction. Host CLI
// invocations are not: their flags vary per call site, so replacing them loses
// information (which --json fields, which label, whether --draft was passed).
// This tool applies them anyway, under human supervision, on files already
// staged for rewrite — and prints every substitution so the loss is visible.
//
// Run it on templates/.staged/**, review the diff, then promote.
import { readFileSync, writeFileSync } from 'node:fs';

const RULES = [
  // --- issue reads/writes -----------------------------------------------------
  { re: /`gh issue view [^`]*`/g, token: 'TRACKER_VIEW_ISSUE',
    loses: '--json field selection' },
  { re: /`gh issue list [^`]*`/g, token: 'TRACKER_LIST_ISSUES',
    loses: 'filter/limit flags' },
  { re: /`gh issue comment [^`]*`/g, token: 'TRACKER_COMMENT_ISSUE',
    loses: 'the body argument' },
  { re: /`gh issue close [^`]*`/g, token: 'TRACKER_CLOSE_ISSUE', loses: 'nothing material' },
  { re: /`gh issue create [^`]*`/g, token: 'TRACKER_CREATE_ISSUE', loses: 'title/body arguments' },
  { re: /`gh issue edit [^`]*--add-label[^`]*`/g, token: 'TRACKER_ADD_LABEL',
    loses: 'which label' },
  { re: /`gh issue edit [^`]*--remove-label[^`]*`/g, token: 'TRACKER_REMOVE_LABEL',
    loses: 'which label' },

  // --- PR lifecycle -----------------------------------------------------------
  { re: /`gh pr create [^`]*`/g, token: 'VCS_CREATE_PR', loses: 'draft/base/body flags' },
  { re: /`gh pr checks [^`]*`/g, token: 'VCS_PR_CHECKS', loses: 'watch/interval flags' },
  { re: /`gh pr ready [^`]*`/g, token: 'VCS_MARK_READY', loses: 'nothing material' },
  { re: /`gh pr view [^`]*`/g, token: 'VCS_VIEW_PR', loses: '--json field selection' },

  // --- review threads ---------------------------------------------------------
  { re: /`gh api graphql[^`]*resolveReviewThread[^`]*`/g, token: 'VCS_RESOLVE_THREAD',
    loses: 'the thread id argument' },
  { re: /`gh api graphql[^`]*reviewThreads[^`]*`/g, token: 'VCS_LIST_REVIEW_THREADS',
    loses: 'the query shape' },

  // --- CI ---------------------------------------------------------------------
  { re: /`gh run rerun [^`]*`/g, token: 'VCS_RERUN_FAILED_CHECKS', loses: 'run id' },
];

// Paths and package refs that survived extract because they are prose examples
// rather than exact literals.
const PATH_RULES = [
  { re: /packages\/backend\/src/g, to: '{{PATHS_SRC_GLOBS}}', note: 'upstream backend src path' },
  { re: /packages\/frontend\/src/g, to: '{{PATHS_SRC_GLOBS}}', note: 'upstream frontend src path' },
  { re: /packages\/shared\/src/g, to: '{{PATHS_SRC_GLOBS}}', note: 'upstream shared src path' },
  { re: /packages\/ui\/src/g, to: '{{PATHS_SRC_GLOBS}}', note: 'upstream ui src path' },
];

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node tools/tokenize-commands.mjs <file...>');
  process.exit(2);
}

let totalSubs = 0;
for (const file of files) {
  let text = readFileSync(file, 'utf8');
  const log = [];

  for (const r of RULES) {
    const re = new RegExp(r.re.source, r.re.flags);
    const hits = text.match(re);
    if (!hits) continue;
    text = text.replace(re, `\`{{${r.token}}}\``);
    log.push(`  {{${r.token}}} ×${hits.length}  — loses: ${r.loses}`);
    totalSubs += hits.length;
  }

  for (const r of PATH_RULES) {
    const re = new RegExp(r.re.source, r.re.flags);
    const hits = text.match(re);
    if (!hits) continue;
    text = text.replace(re, r.to);
    log.push(`  ${r.to} ×${hits.length}  — was: ${r.note}`);
    totalSubs += hits.length;
  }

  if (log.length) {
    console.log(file);
    log.forEach((l) => console.log(l));
    writeFileSync(file, text);
  }
}
console.log(`\n${totalSubs} substitution(s). Review the diff before promoting out of .staged/.`);
