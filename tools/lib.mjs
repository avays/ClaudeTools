// Shared helpers for the ct toolchain: token vocabulary, the reverse-substitution
// table used by `ct extract`, forward rendering, and conditional-block handling.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const TOKEN_RE = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

/** Every token the schema defines, flattened to a Set for validation. */
export function schemaTokens() {
  const schema = JSON.parse(readFileSync(join(ROOT, 'claudetools.config.schema.json'), 'utf8'));
  const out = new Set();
  for (const [group, def] of Object.entries(schema.properties)) {
    if (group === '$schema' || group === 'packs' || group === 'upstream') continue;
    for (const key of Object.keys(def.properties ?? {})) out.add(key);
  }
  return out;
}

/**
 * Reverse-substitution table for `ct extract`: upstream concrete value -> token.
 *
 * ORDER MATTERS. Entries are applied top to bottom, so any string that is a
 * PREFIX or SUBSTRING of another must come after it — substituting
 * `.claude/rules` first would corrupt `.claude/rules/file-patterns.json`
 * handling downstream, and substituting the repo slug before the full URL
 * would leave `https://github.com/{{VCS_REPO_SLUG}}` un-tokenized as a URL.
 *
 * `literal` entries are plain string replacements. `pattern` entries are
 * regexes; a `note` marks a substitution as inherently lossy, which makes
 * extract report it for review instead of applying it silently.
 */
export const SUBSTITUTIONS = [
  // --- URLs before the slugs they contain ---
  { literal: 'https://github.com/orgs/Digital-Synchrony/projects/1', token: 'TRACKER_BOARD_URL' },
  { literal: 'https://github.com/Digital-Synchrony/ORM', token: 'VCS_REPO_URL' },
  { literal: 'Digital-Synchrony/ORM', token: 'VCS_REPO_SLUG' },

  // --- Build commands before the package manager they start with ---
  { literal: 'pnpm --filter @orm/shared build', token: 'PKG_BUILD' },
  { literal: 'pnpm --filter @orm/backend typecheck', token: 'PKG_TYPECHECK' },
  { literal: 'pnpm --filter @orm/backend test', token: 'PKG_TEST' },
  { literal: 'pnpm sync-agents', token: 'PKG_SYNC_AGENTS' },
  { literal: 'pnpm sync-copilot', token: 'PKG_SYNC_AGENTS' },
  { literal: 'pnpm install', token: 'PKG_INSTALL' },

  // --- Paths: longest first ---
  { literal: '.ai/context', token: 'PATHS_CONTEXT_DIR' },
  { literal: '.ai/specs', token: 'PATHS_SPECS_DIR' },
  { literal: '.claude/rules', token: 'PATHS_RULES_DIR' },
  { literal: '.claude/skills', token: 'PATHS_SKILLS_DIR' },
  { literal: '.claude/agents', token: 'PATHS_AGENTS_DIR' },
  { literal: 'packages/*/src', token: 'PATHS_SRC_GLOBS' },

  // --- Vocabulary ---
  { literal: 'the ORM Build board', token: 'TRACKER_BOARD_NAME' },
  { literal: 'ORM Build board', token: 'TRACKER_BOARD_NAME' },

  // --- Tracker/VCS commands: lossy, reported not auto-applied ---
  {
    pattern: /gh issue view (\S+) --repo \S+ --json [\w,]+/g,
    token: 'TRACKER_VIEW_ISSUE',
    note: 'gh issue view with a --json field list — the token has a fixed field list, so a call selecting different fields loses that selection.',
  },
  {
    pattern: /gh issue comment (\S+) --repo \S+ --body/g,
    token: 'TRACKER_COMMENT_ISSUE',
    note: 'gh issue comment — body argument quoting differs per call site.',
  },
  {
    pattern: /gh issue edit (\S+) --repo \S+ --add-label/g,
    token: 'TRACKER_ADD_LABEL',
    note: 'gh issue edit --add-label; some call sites also pass --remove-label in the same invocation.',
  },
  {
    pattern: /gh issue edit (\S+) --repo \S+ --remove-label/g,
    token: 'TRACKER_REMOVE_LABEL',
    note: 'gh issue edit --remove-label.',
  },
  {
    pattern: /gh pr create[^\n`]*/g,
    token: 'VCS_CREATE_PR',
    note: 'gh pr create — flags vary widely per call site (draft, base, fill, body-file).',
  },
  {
    pattern: /gh pr checks [^\n`]*/g,
    token: 'VCS_PR_CHECKS',
    note: 'gh pr checks — watch/interval flags vary.',
  },
  {
    pattern: /gh api graphql[^\n`]*resolveReviewThread[^\n`]*/g,
    token: 'VCS_RESOLVE_THREAD',
    note: 'GraphQL resolveReviewThread mutation — GitHub-only concept; other hosts have no equivalent.',
  },
];

/** Apply the unambiguous (literal) substitutions. Returns { text, applied }. */
export function tokenize(text) {
  let out = text;
  const applied = new Map();
  for (const rule of SUBSTITUTIONS) {
    if (!rule.literal) continue;
    if (!out.includes(rule.literal)) continue;
    const count = out.split(rule.literal).length - 1;
    out = out.split(rule.literal).join(`{{${rule.token}}}`);
    applied.set(rule.token, (applied.get(rule.token) ?? 0) + count);
  }
  return { text: out, applied };
}

/**
 * Find lossy substitutions that WOULD apply, without applying them. These are
 * reported for human adjudication — reverse-tokenizing a command whose flags
 * vary per call site cannot be done safely by pattern alone.
 */
export function findAmbiguous(text) {
  const found = [];
  for (const rule of SUBSTITUTIONS) {
    if (!rule.pattern) continue;
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      found.push({ token: rule.token, match: m[0].slice(0, 120), note: rule.note, index: m.index });
    }
  }
  return found;
}

/** Residual upstream identifiers that no rule covers — a porting to-do list. */
export const RESIDUAL_PATTERNS = [
  { name: '@orm/ package refs', re: /@orm\/[a-z-]+/g },
  { name: 'packages/ paths', re: /packages\/[a-z-]+\//g },
  { name: 'pnpm --filter', re: /pnpm --filter [^\s`]+/g },
  { name: 'bare gh calls', re: /\bgh (issue|pr|api|run|workflow|project) [^\n`]{0,60}/g },
  { name: 'Railway service names', re: /\bapp-(api|worker|frontend|registry)\b/g },
];

export function findResidual(text) {
  const out = [];
  for (const { name, re } of RESIDUAL_PATTERNS) {
    const rx = new RegExp(re.source, re.flags);
    const hits = text.match(rx);
    if (hits) out.push({ name, count: hits.length, sample: [...new Set(hits)].slice(0, 4) });
  }
  return out;
}

/** Flatten a config object into a single token -> value map. */
export function flattenConfig(cfg) {
  const map = new Map();
  for (const [group, val] of Object.entries(cfg)) {
    if (group === 'packs' || group === 'upstream' || group === '$schema') continue;
    if (val && typeof val === 'object') {
      for (const [k, v] of Object.entries(val)) map.set(k, String(v ?? ''));
    }
  }
  return map;
}

/**
 * Resolve conditional blocks before token substitution.
 *
 *   {{#if PACK:react-vite}} ... {{/if}}      -> kept only when that pack is installed
 *   {{#if TOKEN}} ... {{/if}}                -> kept only when the token is non-empty
 *   {{#if TRACKER_KIND=github}} ... {{/if}}  -> kept only when the token equals a value
 *   {{#unless ...}} ... {{/unless}}          -> the inverse of any of the above
 *
 * Three distinct needs:
 *   - PACK: a core skill cross-referencing a rule that only exists when a pack
 *     is installed must vanish entirely, not render as a dangling path.
 *   - non-empty: a capability the host may not have (draft PRs, thread
 *     resolution) must not produce instructions to run an empty command.
 *   - equality: the orchestration layer (board-runner, pr-creator, ralph) is
 *     genuinely host-specific. GitHub keeps its exact, battle-tested command
 *     blocks; every other tracker gets the token-driven generic form. Faking a
 *     single portable version of these would ship commands nobody has run.
 */
export function resolveConditionals(text, tokens, packs) {
  const truthy = (name) => {
    if (name.startsWith('PACK:')) return packs.includes(name.slice(5));
    const eq = name.indexOf('=');
    if (eq > 0) return (tokens.get(name.slice(0, eq)) ?? '') === name.slice(eq + 1);
    const v = tokens.get(name);
    return v !== undefined && v !== '';
  };
  // The name class MUST include `=` so equality conditionals
  // ({{#if TRACKER_KIND=github}}) match. Omitting it does not error — the block
  // simply never matches and ships as literal markup into the rendered file.
  const block = /\{\{#(if|unless) ([A-Za-z0-9_:.=/-]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;
  let prev;
  do {
    prev = text;
    text = text.replace(block, (_m, kind, name, body) => {
      const keep = kind === 'if' ? truthy(name) : !truthy(name);
      return keep ? body : '';
    });
  } while (text !== prev); // nested blocks resolve outer-in over repeated passes
  return text;
}

/** Substitute {{TOKEN}} -> value. Returns { text, missing }. */
export function substitute(text, tokens) {
  const missing = new Set();
  const out = text.replace(TOKEN_RE, (m, name) => {
    if (!tokens.has(name)) { missing.add(name); return m; }
    return tokens.get(name);
  });
  return { text: out, missing: [...missing] };
}

export function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadConfig(path) {
  if (!existsSync(path)) {
    throw new Error(`No config at ${path}. Run \`ct init\` first.`);
  }
  return loadJson(path);
}
