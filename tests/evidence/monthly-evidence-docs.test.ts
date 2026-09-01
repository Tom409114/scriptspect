import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('documents the draft collector without presenting unreviewed evidence as a claim', () => {
  const policy = readFileSync(join(process.cwd(), 'docs', 'evidence', 'README.md'), 'utf8');
  expect(policy).toContain('.github/workflows/monthly-evidence.yml');
  expect(policy).toContain('docs/evidence/monthly-draft.schema.json');
  expect(policy).toContain('workflow_dispatch');
  expect(policy).toContain('monthly');
  expect(policy).toContain('artifact');
  expect(policy).toContain('never commits');
  expect(policy).toContain('response SHA-256');
  expect(policy).toMatch(/raw\s+response bodies/u);
  expect(policy).toContain('`null`');
  expect(policy).toContain('not zero');
  expect(policy).toContain('workflow job fails');
  expect(policy).toContain('paired 404');
  expect(policy).toMatch(/do not make the\s+monthly workflow red/u);
  expect(policy).toContain('eight-minute global deadline');
  expect(policy).toContain('public GitHub release count');
  expect(policy).toMatch(/duplicate immutable\s+(?:issue|release)/u);
  expect(policy).toContain('structurally invalid');
  expect(policy).toContain('unreviewed');
  expect(policy).toContain('external/time-dependent');
});
