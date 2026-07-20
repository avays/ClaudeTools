#!/usr/bin/env node
/**
 * sync-copilot-instructions.mjs
 *
 * Generates agent-compatible files from Claude source files:
 *
 *   CLAUDE.md                 → AGENTS.md
 *   .claude/rules/*.md       → .github/instructions/<name>.instructions.md
 *   .claude/skills/*         → .github/instructions/skill-<name>.instructions.md (applyTo: **)
 *   .claude/agents/*.md      → .github/agents/<name>.md
 *   .claude/skills/*         → .agents/skills/<name>/SKILL.md
 *   .claude/agents/*.md      → .codex/agents/<name>.toml
 *
 * Usage:
 *   node scripts/sync-copilot-instructions.mjs          # generate files
 *   node scripts/sync-copilot-instructions.mjs --check  # diff + exit 1 if stale
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const rulesDir    = path.join(repoRoot, '.claude', 'rules');
const skillsDir   = path.join(repoRoot, '.claude', 'skills');
const agentsDir   = path.join(repoRoot, '.claude', 'agents');
const patternsFile = path.join(rulesDir, 'file-patterns.json');
const claudeFile = path.join(repoRoot, 'CLAUDE.md');
const codexInstructionsFile = path.join(repoRoot, 'AGENTS.md');
const instructionsDir = path.join(repoRoot, '.github', 'instructions');
const ghAgentsDir     = path.join(repoRoot, '.github', 'agents');
const codexSkillsDir  = path.join(repoRoot, '.agents', 'skills');
const codexAgentsDir  = path.join(repoRoot, '.codex', 'agents');

const CHECK_MODE = process.argv.includes('--check');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip leading YAML frontmatter from markdown content.
 * A frontmatter block starts with '---' on line 1 and ends at the next '---' line.
 * Returns content with the frontmatter removed and leading whitespace trimmed.
 */
function stripFrontmatter(content) {
  const lines = content.split('\n');
  if (lines[0].trim() !== '---') {
    return content;
  }
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    return content;
  }
  return lines.slice(closeIdx + 1).join('\n').trimStart();
}

/**
 * Parse YAML-ish frontmatter from a file's content.
 * Returns { fields: Record<string, string>, body: string }.
 * Only handles simple key: value lines (no nesting, no arrays).
 */
function parseFrontmatter(content) {
  const lines = content.split('\n');
  if (lines[0].trim() !== '---') {
    return { fields: {}, body: content };
  }
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    return { fields: {}, body: content };
  }
  const fields = {};
  for (let i = 1; i < closeIdx; i++) {
    const match = lines[i].match(/^(\w[\w-]*):\s*(.*)$/);
    if (match) {
      fields[match[1]] = match[2].trim();
    }
  }
  const body = lines.slice(closeIdx + 1).join('\n').trimStart();
  return { fields, body };
}

function insertGeneratedNotice(content, sourceLabel, command) {
  const notice = `<!-- AUTO-GENERATED from ${sourceLabel}. Do not edit directly; edit the source and run \`${command}\`. -->`;
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') {
    return `${notice}\n\n${content}`;
  }

  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closeIdx = i;
      break;
    }
  }

  if (closeIdx === -1) {
    return `${notice}\n\n${content}`;
  }

  return [
    ...lines.slice(0, closeIdx + 1),
    '',
    notice,
    '',
    ...lines.slice(closeIdx + 1),
  ].join('\n');
}

function tomlString(value) {
  return JSON.stringify(value ?? '');
}

/**
 * Map Claude tool names to Copilot tool names.
 * Returns a deduplicated array (may be empty).
 */
const TOOL_MAP = {
  Bash:      'runCommands',
  Read:      'codebase',
  Glob:      'search',
  Grep:      'search',
  Write:     'editFiles',
  Edit:      'editFiles',
  WebFetch:  'fetch',
  WebSearch: 'fetch',
  // Agent, Task*, permissionMode etc. — omit or ignore
};

function mapTools(toolsStr) {
  if (!toolsStr) return [];
  const raw = toolsStr.split(',').map((t) => t.trim()).filter(Boolean);
  const mapped = [];
  for (const t of raw) {
    const copilotTool = TOOL_MAP[t];
    if (copilotTool && !mapped.includes(copilotTool)) {
      mapped.push(copilotTool);
    }
  }
  return mapped;
}

let hasDiff = false;

function writeOrCheck(filePath, generated, label) {
  if (CHECK_MODE) {
    if (!fs.existsSync(filePath)) {
      console.error(`MISSING: ${label}`);
      hasDiff = true;
      return;
    }
    const existing = fs.readFileSync(filePath, 'utf8');
    if (existing !== generated) {
      console.error(`STALE: ${label}`);
      const existingLines = existing.split('\n');
      const generatedLines = generated.split('\n');
      const maxLines = Math.max(existingLines.length, generatedLines.length);
      for (let i = 0; i < maxLines; i++) {
        const a = existingLines[i] ?? '(missing)';
        const b = generatedLines[i] ?? '(missing)';
        if (a !== b) {
          console.error(`  line ${i + 1}:`);
          console.error(`  - ${a}`);
          console.error(`  + ${b}`);
          if (i > 3) {
            console.error(`  ... (${maxLines - i - 1} more differing lines)`);
            break;
          }
        }
      }
      hasDiff = true;
    }
  } else {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, generated, 'utf8');
    console.log(`  wrote: ${label}`);
  }
}

function walkFiles(dir, baseDir = dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath, baseDir));
    } else if (entry.isFile()) {
      files.push(path.relative(baseDir, fullPath));
    }
  }

  return files;
}

function detectOrphans(dir, expectedSet, suffix, dirLabel) {
  const existing = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith(suffix))
    : [];
  const orphans = existing.filter((f) => !expectedSet.has(f));
  if (orphans.length > 0) {
    if (CHECK_MODE) {
      console.error(
        `ORPHANED: The following files have no corresponding source and must be deleted:\n  ${orphans.map((f) => `${dirLabel}/${f}`).join('\n  ')}`
      );
      hasDiff = true;
    } else {
      for (const orphan of orphans) {
        fs.rmSync(path.join(dir, orphan));
        console.log(`  deleted (orphan): ${dirLabel}/${orphan}`);
      }
    }
  }
}

function detectOrphanFilesRecursive(dir, expectedSet, dirLabel) {
  const existing = walkFiles(dir);
  const orphans = existing.filter((f) => !expectedSet.has(f));

  if (orphans.length > 0) {
    if (CHECK_MODE) {
      console.error(
        `ORPHANED: The following files have no corresponding source and must be deleted:\n  ${orphans.map((f) => `${dirLabel}/${f}`).join('\n  ')}`
      );
      hasDiff = true;
    } else {
      for (const orphan of orphans) {
        fs.rmSync(path.join(dir, orphan));
        console.log(`  deleted (orphan): ${dirLabel}/${orphan}`);
      }
      pruneEmptyDirs(dir);
    }
  }
}

function pruneEmptyDirs(dir) {
  if (!fs.existsSync(dir)) {
    return;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const child = path.join(dir, entry.name);
    pruneEmptyDirs(child);
    if (fs.existsSync(child) && fs.readdirSync(child).length === 0) {
      fs.rmdirSync(child);
    }
  }
}

// ---------------------------------------------------------------------------
// syncCodexInstructions — CLAUDE.md → AGENTS.md
// ---------------------------------------------------------------------------

function syncCodexInstructions() {
  const sourceContent = fs.readFileSync(claudeFile, 'utf8');
  const generated =
    `<!-- AUTO-GENERATED from CLAUDE.md. Do not edit directly; edit CLAUDE.md and run \`pnpm sync-agents\`. -->\n\n` +
    `# Codex Agent Instructions\n\n` +
    `Claude remains the source of truth for this repository's agent context. This file is generated so Codex can load the same project guidance through its AGENTS.md discovery path.\n\n` +
    sourceContent;

  writeOrCheck(codexInstructionsFile, generated, 'AGENTS.md');
}

// ---------------------------------------------------------------------------
// syncRules — .claude/rules/*.md → .github/instructions/<name>.instructions.md
// ---------------------------------------------------------------------------

function syncRules(patterns) {
  const ruleFiles = fs.readdirSync(rulesDir)
    .filter((f) => f.endsWith('.md'))
    .sort();

  const missing = ruleFiles
    .map((f) => path.basename(f, '.md'))
    .filter((name) => !(name in patterns));

  if (missing.length > 0) {
    console.error(
      `ERROR: The following rule files have no entry in file-patterns.json:\n  ${missing.join('\n  ')}\n` +
      `Add a mapping for each before running this script.`
    );
    process.exit(1);
  }

  const expectedFiles = new Set(
    ruleFiles.map((f) => `${path.basename(f, '.md')}.instructions.md`)
  );

  for (const ruleFile of ruleFiles) {
    const name = path.basename(ruleFile, '.md');
    const applyTo = patterns[name];
    const rawContent = fs.readFileSync(path.join(rulesDir, ruleFile), 'utf8');
    const sourceContent = stripFrontmatter(rawContent);

    const generated =
      `---\napplyTo: "${applyTo}"\n---\n\n` +
      `<!-- AUTO-GENERATED from .claude/rules/${ruleFile}. Do not edit directly; edit the source and run \`pnpm sync-agents\`. -->\n\n` +
      sourceContent;

    const outFile = path.join(instructionsDir, `${name}.instructions.md`);
    writeOrCheck(outFile, generated, `.github/instructions/${name}.instructions.md`);
  }

  return expectedFiles;
}

// ---------------------------------------------------------------------------
// syncSkills — .claude/skills/* → .github/instructions/skill-<name>.instructions.md
// ---------------------------------------------------------------------------

function syncSkills() {
  const entries = fs.readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  const expectedFiles = new Set();

  for (const entry of entries) {
    let name, sourcePath, sourceLabel;

    if (entry.isFile() && entry.name.endsWith('.md')) {
      // Single-file skill: github-issue.md → skill-github-issue
      name = path.basename(entry.name, '.md');
      sourcePath = path.join(skillsDir, entry.name);
      sourceLabel = `.claude/skills/${entry.name}`;
    } else if (entry.isDirectory()) {
      // Folder skill: look for SKILL.md inside
      const skillMd = path.join(skillsDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) {
        console.warn(`  WARNING: skill dir .claude/skills/${entry.name}/ has no SKILL.md — skipping`);
        continue;
      }
      name = entry.name;
      sourcePath = skillMd;
      sourceLabel = `.claude/skills/${entry.name}/SKILL.md`;
    } else {
      continue;
    }

    const outputName = `skill-${name}.instructions.md`;
    expectedFiles.add(outputName);

    const rawContent = fs.readFileSync(sourcePath, 'utf8');
    const sourceContent = stripFrontmatter(rawContent);

    const generated =
      `---\napplyTo: "**"\n---\n\n` +
      `<!-- AUTO-GENERATED from ${sourceLabel}. Do not edit directly; edit the source and run \`pnpm sync-agents\`. -->\n\n` +
      sourceContent;

    const outFile = path.join(instructionsDir, outputName);
    writeOrCheck(outFile, generated, `.github/instructions/${outputName}`);
  }

  return expectedFiles;
}

// ---------------------------------------------------------------------------
// syncAgents — .claude/agents/*.md → .github/agents/<name>.md
// ---------------------------------------------------------------------------

function syncAgents() {
  if (!fs.existsSync(agentsDir)) {
    return new Set();
  }

  const agentFiles = fs.readdirSync(agentsDir)
    .filter((f) => f.endsWith('.md'))
    .sort();

  const expectedFiles = new Set();

  for (const agentFile of agentFiles) {
    const agentName = path.basename(agentFile, '.md');
    const rawContent = fs.readFileSync(path.join(agentsDir, agentFile), 'utf8');
    const { fields, body } = parseFrontmatter(rawContent);

    const description = fields['description'] || '';
    const tools = mapTools(fields['tools']);

    const outputName = `${agentName}.md`;
    expectedFiles.add(outputName);

    let frontmatter = '---\n';
    if (description) {
      frontmatter += `description: ${description}\n`;
    }
    if (tools.length > 0) {
      frontmatter += `tools: [${tools.map((t) => `'${t}'`).join(', ')}]\n`;
    }
    frontmatter += '---';

    const generated =
      `${frontmatter}\n\n` +
      `<!-- AUTO-GENERATED from .claude/agents/${agentFile}. Do not edit directly; edit the source and run \`pnpm sync-agents\`. -->\n\n` +
      body;

    const outFile = path.join(ghAgentsDir, outputName);
    writeOrCheck(outFile, generated, `.github/agents/${outputName}`);
  }

  return expectedFiles;
}

// ---------------------------------------------------------------------------
// syncCodexSkills — .claude/skills/* → .agents/skills/<name>/SKILL.md
// ---------------------------------------------------------------------------

function syncCodexSkills() {
  const entries = fs.readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  const expectedFiles = new Set();

  for (const entry of entries) {
    let name, sourceRoot, sourcePath, sourceLabel;

    if (entry.isFile() && entry.name.endsWith('.md')) {
      name = path.basename(entry.name, '.md');
      sourceRoot = null;
      sourcePath = path.join(skillsDir, entry.name);
      sourceLabel = `.claude/skills/${entry.name}`;
    } else if (entry.isDirectory()) {
      const skillMd = path.join(skillsDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) {
        console.warn(`  WARNING: skill dir .claude/skills/${entry.name}/ has no SKILL.md — skipping`);
        continue;
      }
      name = entry.name;
      sourceRoot = path.join(skillsDir, entry.name);
      sourcePath = skillMd;
      sourceLabel = `.claude/skills/${entry.name}/SKILL.md`;
    } else {
      continue;
    }

    const outputRoot = path.join(codexSkillsDir, name);
    const outputSkillRel = `${name}/SKILL.md`;
    expectedFiles.add(outputSkillRel);

    const rawContent = fs.readFileSync(sourcePath, 'utf8');
    const generatedSkill = insertGeneratedNotice(rawContent, sourceLabel, 'pnpm sync-agents');
    writeOrCheck(path.join(outputRoot, 'SKILL.md'), generatedSkill, `.agents/skills/${outputSkillRel}`);

    if (!sourceRoot) {
      continue;
    }

    for (const relPath of walkFiles(sourceRoot)) {
      if (relPath === 'SKILL.md') {
        continue;
      }
      const sourceFile = path.join(sourceRoot, relPath);
      const outputRel = `${name}/${relPath}`;
      expectedFiles.add(outputRel);
      writeOrCheck(
        path.join(codexSkillsDir, outputRel),
        fs.readFileSync(sourceFile, 'utf8'),
        `.agents/skills/${outputRel}`
      );
    }
  }

  return expectedFiles;
}

// ---------------------------------------------------------------------------
// syncCodexAgents — .claude/agents/*.md → .codex/agents/<name>.toml
// ---------------------------------------------------------------------------

function syncCodexAgents() {
  if (!fs.existsSync(agentsDir)) {
    return new Set();
  }

  const agentFiles = fs.readdirSync(agentsDir)
    .filter((f) => f.endsWith('.md'))
    .sort();

  const expectedFiles = new Set();

  for (const agentFile of agentFiles) {
    const fallbackName = path.basename(agentFile, '.md');
    const rawContent = fs.readFileSync(path.join(agentsDir, agentFile), 'utf8');
    const { fields, body } = parseFrontmatter(rawContent);

    const agentName = fields.name || fallbackName;
    const description = fields.description || '';
    if (!description) {
      console.error(`ERROR: .claude/agents/${agentFile} is missing required description frontmatter.`);
      process.exit(1);
    }

    const outputName = `${fallbackName}.toml`;
    expectedFiles.add(outputName);

    const generated =
      `# AUTO-GENERATED from .claude/agents/${agentFile}. Do not edit directly; edit the source and run \`pnpm sync-agents\`.\n` +
      `# Claude-specific frontmatter such as tools, model, and permissionMode is intentionally not copied.\n\n` +
      `name = ${tomlString(agentName)}\n` +
      `description = ${tomlString(description)}\n` +
      `developer_instructions = ${tomlString(body)}\n`;

    const outFile = path.join(codexAgentsDir, outputName);
    writeOrCheck(outFile, generated, `.codex/agents/${outputName}`);
  }

  return expectedFiles;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Load pattern mappings for rules
if (!fs.existsSync(patternsFile)) {
  console.error(`ERROR: Missing config file: ${patternsFile}`);
  process.exit(1);
}
const patterns = JSON.parse(fs.readFileSync(patternsFile, 'utf8'));

// Ensure output directories exist
if (!CHECK_MODE) {
  fs.mkdirSync(instructionsDir, { recursive: true });
  fs.mkdirSync(ghAgentsDir, { recursive: true });
  fs.mkdirSync(codexSkillsDir, { recursive: true });
  fs.mkdirSync(codexAgentsDir, { recursive: true });
}

// Run sync functions and collect expected output names
syncCodexInstructions();
const expectedRules  = syncRules(patterns);
const expectedSkills = syncSkills();
const expectedAgents = syncAgents();
const expectedCodexSkills = syncCodexSkills();
const expectedCodexAgents = syncCodexAgents();

// Orphan detection: .github/instructions/ = rules ∪ skills
const expectedInstructions = new Set([...expectedRules, ...expectedSkills]);
detectOrphans(instructionsDir, expectedInstructions, '.instructions.md', '.github/instructions');

// Orphan detection: .github/agents/ = agents
detectOrphans(ghAgentsDir, expectedAgents, '.md', '.github/agents');

// Orphan detection: .agents/skills/ = Codex skills
detectOrphanFilesRecursive(codexSkillsDir, expectedCodexSkills, '.agents/skills');

// Orphan detection: .codex/agents/ = Codex custom agents
detectOrphans(codexAgentsDir, expectedCodexAgents, '.toml', '.codex/agents');

// Final result
if (CHECK_MODE) {
  if (hasDiff) {
    console.error('\nAgent files are out of sync. Run `pnpm sync-agents` and commit the result.');
    process.exit(1);
  } else {
    console.log('Agent instructions, skills, and custom agents are in sync.');
    process.exit(0);
  }
} else {
  const ruleCount  = expectedRules.size;
  const skillCount = expectedSkills.size;
  const agentCount = expectedAgents.size;
  const codexSkillCount = new Set([...expectedCodexSkills].map((f) => f.split('/')[0])).size;
  const codexAgentCount = expectedCodexAgents.size;
  console.log(`\nDone. ${ruleCount} rule(s) + ${skillCount} skill(s) → .github/instructions/ | ${agentCount} agent(s) → .github/agents/ | AGENTS.md + ${codexSkillCount} Codex skill(s) + ${codexAgentCount} Codex agent(s)`);
}
