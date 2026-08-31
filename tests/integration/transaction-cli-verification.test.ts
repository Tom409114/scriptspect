import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const injected = vi.hoisted(() => ({ analyzeCalls: 0 }));

vi.mock('../../src/core/analyze', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/analyze')>();
  return {
    ...actual,
    analyze(...args: Parameters<typeof actual.analyze>) {
      injected.analyzeCalls += 1;
      if (injected.analyzeCalls === 2) throw new Error('injected post-fix analyzer failure');
      return actual.analyze(...args);
    },
  };
});

import type { CliIo } from '../../src/cli/index';
import { runCli } from '../../src/cli/index';

let root: string;
let errors: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scriptspect-transaction-cli-verify-'));
  errors = [];
  injected.analyzeCalls = 0;
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      scripts: { clean: 'rm -rf dist' },
      devDependencies: { rimraf: '^5.0.0' },
    }),
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('CLI transaction semantic verification', () => {
  it('rolls back installed bytes when post-fix analysis fails before finalization', async () => {
    const original = readFileSync(join(root, 'package.json'));
    const io: CliIo = { out: () => {}, err: (message) => errors.push(message) };

    expect(await runCli([root, '--fix'], io)).toBe(2);

    expect(readFileSync(join(root, 'package.json'))).toEqual(original);
    expect(errors.join('\n')).toContain('injected post-fix analyzer failure');
    expect(errors.join('\n')).not.toContain('fixed 1 script');
  });
});
