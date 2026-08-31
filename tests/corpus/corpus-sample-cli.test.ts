import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdjudicationDraft } from '../../tools/corpus-sample';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('adjudication draft writer', () => {
  it('emits pending source-free records tied to immutable finding evidence', () => {
    const directory = mkdtempSync(join(tmpdir(), 'scriptspect-sample-test-'));
    directories.push(directory);
    const input = join(directory, 'findings.jsonl');
    const output = join(directory, 'adjudication.jsonl');
    const records = ['PS001', 'PS010', 'PS050'].map((ruleId, index) => ({
      findingId: `${index}`.repeat(64),
      repository: 'example/project',
      commit: '0123456789abcdef0123456789abcdef01234567',
      url: `https://github.com/example/project/blob/0123456789abcdef0123456789abcdef01234567/package.json#L${index + 1}`,
      packagePath: 'package.json',
      scriptName: `script-${index}`,
      scriptSha256: `${index + 3}`.repeat(64),
      ruleId,
      severity: index === 0 ? 'error' : 'warn',
      confidence: index === 2 ? 'medium' : 'high',
      affectedTargets: ['cmd'],
      span: [0, 2],
      message: 'redacted diagnostic',
    }));
    writeFileSync(input, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

    createAdjudicationDraft(input, output, 3, 'candidate-sha');

    const result = readFileSync(output, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      schemaVersion: 1,
      outcome: 'pending',
      rationale: null,
      reviewer: null,
      reviewedAt: null,
      secondaryReview: {
        outcome: null,
        rationale: null,
        reviewer: null,
        reviewedAt: null,
      },
    });
    expect(result.every((record) => !('message' in record) && !('source' in record))).toBe(true);
  });
});
