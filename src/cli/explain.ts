/**
 * Offline `explain <ruleId>` renderer (spec §4.3): rule docs summary with
 * good/bad examples, targets, false-positive notes, fix safety, provenance.
 */
import type { RuleModule } from '../rules/types';
import { DOCS_RULE_URL_BASE } from '../reporters/stylish';

export function renderExplain(rule: RuleModule): string {
  const lines: string[] = [];
  lines.push(`${rule.id} · ${rule.title}`);
  lines.push(`${rule.severity} · ${rule.confidence} confidence · affects: ${rule.affectedTargets.join(', ')}`);
  lines.push('');
  lines.push(rule.summary);
  lines.push('');
  lines.push('Bad examples');
  for (const ex of rule.badExamples) lines.push(`  ✗ ${ex}`);
  lines.push('');
  lines.push('Good examples');
  for (const ex of rule.goodExamples) lines.push(`  ✓ ${ex}`);
  lines.push('');
  lines.push('False positives');
  lines.push(`  ${rule.falsePositiveNotes}`);
  lines.push('');
  lines.push(`Fix: ${rule.fixSafety}`);
  lines.push('');
  lines.push('Provenance');
  for (const p of rule.provenance) lines.push(`  - ${p.claim} (${p.source})`);
  lines.push('');
  lines.push(`Learn more: ${DOCS_RULE_URL_BASE}/${rule.id}.md`);
  return lines.join('\n');
}
