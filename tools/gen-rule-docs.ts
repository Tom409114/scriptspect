/**
 * Generate docs/rules/*.md from rule metadata (single source of truth).
 * Runs in CI (`pnpm docs:rules`); a rule doc can never drift from metadata.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULES } from '../src/rules';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'docs', 'rules');
mkdirSync(outDir, { recursive: true });

function ruleDoc(rule: (typeof RULES)[number]): string {
  const lines: string[] = [];
  lines.push(`# ${rule.id} — ${rule.title}`);
  lines.push('');
  lines.push(
    `**Severity** \`${rule.severity}\` · **Confidence** \`${rule.confidence}\` · **Affected targets** ${rule.affectedTargets.map((t) => `\`${t}\``).join(', ')}`,
  );
  lines.push('');
  lines.push(rule.summary);
  lines.push('');
  lines.push('## Why it breaks');
  lines.push('');
  for (const p of rule.provenance) {
    lines.push(`- ${p.claim} ([source](${p.source}))`);
  }
  lines.push('');
  lines.push('## Bad examples');
  lines.push('');
  for (const ex of rule.badExamples) lines.push(`- \`${ex}\``);
  lines.push('');
  lines.push('## Good examples');
  lines.push('');
  for (const ex of rule.goodExamples) lines.push(`- \`${ex}\``);
  lines.push('');
  lines.push('## False positives');
  lines.push('');
  lines.push(rule.falsePositiveNotes);
  lines.push('');
  lines.push(`## Fix (${rule.fixSafety})`);
  lines.push('');
  lines.push(
    rule.fixSafety === 'safe'
      ? 'Safe: applied automatically by `--fix` (no new dependencies, locally equivalent).'
      : rule.fixSafety === 'conditional'
        ? 'Conditional: applied only when the required dependency is already installed; otherwise surfaced as a plan. `--fix` never installs dependencies.'
        : 'Manual: explained only — never applied automatically.',
  );
  lines.push('');
  return lines.join('\n');
}

let count = 0;
for (const rule of RULES) {
  writeFileSync(join(outDir, `${rule.id}.md`), ruleDoc(rule), 'utf8');
  count += 1;
}

const index = [
  '# Rules',
  '',
  'Every rule is a stable public API. Each page is generated from rule metadata — never edited by hand.',
  '',
  '| Rule | Title | Severity | Confidence | Affected |',
  '| --- | --- | --- | --- | --- |',
  ...RULES.map(
    (r) =>
      `| [${r.id}](${r.id}.md) | ${r.title} | ${r.severity} | ${r.confidence} | ${r.affectedTargets.join(', ')} |`,
  ),
  '',
].join('\n');
writeFileSync(join(outDir, 'README.md'), index, 'utf8');

console.log(`generated ${count} rule docs + index`);
