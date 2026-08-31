import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const injected = vi.hoisted(() => ({
  armed: false,
  descriptorPaths: new Map<number, string>(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync(path: Parameters<typeof actual.openSync>[0], flags: string | number, mode?: number) {
      const descriptor = actual.openSync(path, flags as never, mode);
      if (typeof path === 'string') injected.descriptorPaths.set(descriptor, path);
      return descriptor;
    },
    closeSync(descriptor: number) {
      actual.closeSync(descriptor);
      injected.descriptorPaths.delete(descriptor);
    },
    fsyncSync(descriptor: number) {
      const path = injected.descriptorPaths.get(descriptor);
      if (injected.armed && path?.endsWith('.stage') === true) {
        injected.armed = false;
        const error = new Error('injected stage fsync failure') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      actual.fsyncSync(descriptor);
    },
  };
});

import {
  prepareWriteTransaction,
  recoverTransaction,
  TransactionError,
} from '../../src/fixers/transaction';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scriptspect-transaction-fault-'));
  injected.armed = false;
  injected.descriptorPaths.clear();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('transaction preparation fault recovery', () => {
  it('keeps a partially-created auxiliary inspectable instead of writing an unreadable journal', () => {
    const target = join(root, 'package.json');
    writeFileSync(target, 'before');
    injected.armed = true;
    let failure: TransactionError | undefined;

    try {
      prepareWriteTransaction(root, [
        {
          path: target,
          content: 'after',
          expectedSha256: createHash('sha256').update(readFileSync(target)).digest('hex'),
        },
      ]);
    } catch (error) {
      if (error instanceof TransactionError) failure = error;
      else throw error;
    }

    expect(failure?.outcome.state).toBe('manual-recovery-required');
    const preview = recoverTransaction(failure?.outcome.journalPath as string);
    expect(preview.state).toBe('manual-recovery-required');
    expect(preview.actions.join('\n')).toMatch(/manual inspection|identity is missing/i);
    expect(readFileSync(target, 'utf8')).toBe('before');
  });
});
