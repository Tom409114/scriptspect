import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const injected = vi.hoisted(() => ({
  raceArmed: false,
  raceTarget: '',
  raceContent: '',
  hardlinkArmed: false,
  hardlinkCarrier: '',
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
      const path = injected.descriptorPaths.get(descriptor);
      actual.closeSync(descriptor);
      injected.descriptorPaths.delete(descriptor);
      if (
        injected.hardlinkArmed &&
        path?.includes('.rollback') === true &&
        !existsSync(injected.hardlinkCarrier)
      ) {
        injected.hardlinkArmed = false;
        actual.linkSync(path, injected.hardlinkCarrier);
      }
    },
    renameSync(oldPath: string, newPath: string) {
      if (
        injected.raceArmed &&
        (oldPath === injected.raceTarget || newPath === injected.raceTarget)
      ) {
        injected.raceArmed = false;
        actual.writeFileSync(injected.raceTarget, injected.raceContent);
      }
      actual.renameSync(oldPath, newPath);
    },
  };
});

import {
  commitNextWrite,
  executeWriteTransaction,
  findUnfinishedTransactions,
  prepareWriteTransaction,
  recoverTransaction,
  TransactionError,
} from '../../src/fixers/transaction';

let root: string;

function digest(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function request(path: string, content: string) {
  return { path, content, expectedSha256: digest(readFileSync(path)) };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scriptspect-transaction-race-'));
  injected.raceArmed = false;
  injected.raceTarget = '';
  injected.raceContent = '';
  injected.hardlinkArmed = false;
  injected.hardlinkCarrier = '';
  injected.descriptorPaths.clear();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('transaction race and recovery regressions', () => {
  it('does not overwrite a target replaced in the final compare-to-install window', () => {
    const target = join(root, 'package.json');
    writeFileSync(target, 'before');
    injected.raceTarget = target;
    injected.raceContent = 'external-change';
    injected.raceArmed = true;

    expect(() => executeWriteTransaction(root, [request(target, 'after')])).toThrow(
      TransactionError,
    );
    expect(readFileSync(target, 'utf8')).toBe('external-change');
  });

  it('rejects an original target with multiple hard links before creating transaction state', () => {
    const target = join(root, 'package.json');
    const sibling = join(root, 'same-inode.json');
    writeFileSync(target, 'before');
    linkSync(target, sibling);

    expect(() => executeWriteTransaction(root, [request(target, 'after')])).toThrow(/hard link/i);
    expect(readFileSync(target, 'utf8')).toBe('before');
    expect(readFileSync(sibling, 'utf8')).toBe('before');
    expect(existsSync(join(root, '.scriptspect'))).toBe(false);
  });

  it('refuses a hard-linked rollback stage instead of installing a retained alias', () => {
    const target = join(root, 'package.json');
    writeFileSync(target, 'before');
    const prepared = prepareWriteTransaction(root, [request(target, 'after')]);
    commitNextWrite(prepared.journalPath);
    injected.hardlinkCarrier = join(root, 'rollback-carrier');
    injected.hardlinkArmed = true;

    const recovered = recoverTransaction(prepared.journalPath, { apply: true });

    expect(recovered.state).toBe('manual-recovery-required');
    expect(readFileSync(target, 'utf8')).toBe('after');
    expect(readFileSync(injected.hardlinkCarrier, 'utf8')).toBe('before');
  });

  it('does not overwrite a target replaced in the rollback compare-to-detach window', () => {
    const target = join(root, 'package.json');
    writeFileSync(target, 'before');
    const prepared = prepareWriteTransaction(root, [request(target, 'after')]);
    commitNextWrite(prepared.journalPath);
    injected.raceTarget = target;
    injected.raceContent = 'external-during-rollback';
    injected.raceArmed = true;

    const recovered = recoverTransaction(prepared.journalPath, { apply: true });

    expect(recovered.state).toBe('manual-recovery-required');
    expect(readFileSync(target, 'utf8')).toBe('external-during-rollback');
    expect(existsSync(recovered.backupPaths[0] as string)).toBe(true);
  });

  it('returns deterministic manual instructions when a target parent disappears', () => {
    const parent = join(root, 'packages', 'app');
    mkdirSync(parent, { recursive: true });
    const target = join(parent, 'package.json');
    writeFileSync(target, 'before');
    const prepared = prepareWriteTransaction(root, [request(target, 'after')]);
    renameSync(join(root, 'packages'), join(root, 'packages-moved'));

    const preview = recoverTransaction(prepared.journalPath);

    expect(preview.state).toBe('manual-recovery-required');
    expect(preview.actions.join('\n')).toMatch(/restore .* manually|manual inspection/);
  });

  it('recovers a crash after moving the original but before recording the hold identity', () => {
    const target = join(root, 'package.json');
    writeFileSync(target, 'before');
    const prepared = prepareWriteTransaction(root, [request(target, 'after')]);
    const entry = JSON.parse(readFileSync(prepared.journalPath, 'utf8')).entries[0] as {
      holdPath: string;
    };
    renameSync(target, entry.holdPath);

    expect(recoverTransaction(prepared.journalPath).actions.join('\n')).toContain('original hold');
    const recovered = recoverTransaction(prepared.journalPath, { apply: true });
    expect(recovered.state).toBe('rollback-success');
    expect(readFileSync(target, 'utf8')).toBe('before');
  });

  it('recovers a crash after linking the stage but before recording the commit', () => {
    const target = join(root, 'package.json');
    writeFileSync(target, 'before');
    const prepared = prepareWriteTransaction(root, [request(target, 'after')]);
    const entry = JSON.parse(readFileSync(prepared.journalPath, 'utf8')).entries[0] as {
      holdPath: string;
      stagePath: string;
    };
    renameSync(target, entry.holdPath);
    linkSync(entry.stagePath, target);

    const preview = recoverTransaction(prepared.journalPath);
    expect(preview.state).not.toBe('manual-recovery-required');
    expect(preview.actions.join('\n')).toContain('original hold');
    const recovered = recoverTransaction(prepared.journalPath, { apply: true });
    expect(recovered.state).toBe('rollback-success');
    expect(readFileSync(target, 'utf8')).toBe('before');
  });

  it('inspects and explicitly acknowledges an orphan lock without deleting it automatically', () => {
    const transactions = join(root, '.scriptspect', 'transactions');
    mkdirSync(transactions, { recursive: true });
    const lock = join(transactions, 'write.lock');
    writeFileSync(lock, '00000000-0000-4000-8000-000000000000\n');

    const preview = recoverTransaction(lock);
    expect(preview.state).toBe('manual-recovery-required');
    expect(preview.actions.join('\n')).toMatch(/orphan|unreadable/i);
    expect(existsSync(lock)).toBe(true);

    const withoutAcknowledgement = recoverTransaction(lock, { apply: true });
    expect(withoutAcknowledgement.state).toBe('manual-recovery-required');
    expect(existsSync(lock)).toBe(true);

    const acknowledged = recoverTransaction(lock, {
      apply: true,
      acknowledgeManual: true,
    });
    expect(acknowledged.state).toBe('rollback-success');
    expect(existsSync(lock)).toBe(false);
  });

  it('allows explicit acknowledgement of a corrupt owned journal but preserves unknown auxiliaries', () => {
    const target = join(root, 'package.json');
    writeFileSync(target, 'before');
    const prepared = prepareWriteTransaction(root, [request(target, 'after')]);
    const raw = JSON.parse(readFileSync(prepared.journalPath, 'utf8')) as {
      entries: Array<{ backupPath: string; stagePath: string }>;
    };
    const backupPath = raw.entries[0]?.backupPath as string;
    const stagePath = raw.entries[0]?.stagePath as string;
    writeFileSync(prepared.journalPath, '{broken');

    expect(findUnfinishedTransactions(root)).toEqual([prepared.journalPath]);
    const preview = recoverTransaction(prepared.journalPath);
    expect(preview.state).toBe('manual-recovery-required');
    expect(existsSync(backupPath)).toBe(true);
    expect(existsSync(stagePath)).toBe(true);

    const acknowledged = recoverTransaction(prepared.journalPath, {
      apply: true,
      acknowledgeManual: true,
    });
    expect(acknowledged.state).toBe('rollback-success');
    expect(existsSync(prepared.journalPath)).toBe(false);
    expect(existsSync(backupPath)).toBe(true);
    expect(existsSync(stagePath)).toBe(true);
    expect(findUnfinishedTransactions(root)).toEqual([]);
  });

  it('removes normal successful transaction records and auxiliary files', () => {
    const target = join(root, 'package.json');
    writeFileSync(target, 'before');

    const result = executeWriteTransaction(root, [request(target, 'after')]);

    expect(result.state).toBe('success');
    expect(existsSync(result.journalPath)).toBe(false);
    expect(readdirSync(join(root, '.scriptspect', 'transactions'))).toEqual([]);
  });
});
