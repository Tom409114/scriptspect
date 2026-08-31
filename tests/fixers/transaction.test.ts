import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  commitNextWrite,
  commitWriteTransaction,
  executeWriteTransaction,
  findUnfinishedTransactions,
  prepareWriteTransaction,
  recoverTransaction,
  TransactionError,
} from '../../src/fixers/transaction';

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'scriptspect-transaction-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function digest(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function request(path: string, next: string) {
  const original = readFileSync(path);
  return { path, content: Buffer.from(next), expectedSha256: digest(original) };
}

function createTarget(name: string, content: string): string {
  const path = join(root, name);
  writeFileSync(path, content);
  return path;
}

describe('recoverable write transactions', () => {
  it('prepares every file before replacing any and commits them as one durable transaction', () => {
    const first = createTarget('first.json', 'first-before');
    const second = createTarget('second.json', 'second-before');

    const prepared = prepareWriteTransaction(root, [
      request(first, 'first-after'),
      request(second, 'second-after'),
    ]);

    expect(readFileSync(first, 'utf8')).toBe('first-before');
    expect(readFileSync(second, 'utf8')).toBe('second-before');
    expect(JSON.parse(readFileSync(prepared.journalPath, 'utf8'))).toMatchObject({
      owner: 'scriptspect',
      formatVersion: 1,
      state: 'prepared',
      entries: [
        {
          state: 'prepared',
          original: {
            dev: expect.stringMatching(/^\d+$/),
            ino: expect.stringMatching(/^\d+$/),
            size: String(Buffer.byteLength('first-before')),
            mtimeNs: expect.stringMatching(/^\d+$/),
          },
        },
        { state: 'prepared' },
      ],
    });

    const outcome = commitWriteTransaction(prepared.journalPath);

    expect(outcome.state).toBe('success');
    expect(readFileSync(first, 'utf8')).toBe('first-after');
    expect(readFileSync(second, 'utf8')).toBe('second-after');
    expect(outcome.backupPaths.every((path) => !existsSync(path))).toBe(true);
  });

  it('rejects an escaped target before creating a journal or changing any file', () => {
    const inside = createTarget('inside.json', 'inside-before');
    const outsideRoot = realpathSync(mkdtempSync(join(tmpdir(), 'scriptspect-outside-')));
    const outside = join(outsideRoot, 'outside.json');
    writeFileSync(outside, 'outside-before');
    try {
      expect(() =>
        prepareWriteTransaction(root, [
          request(inside, 'inside-after'),
          request(outside, 'outside-after'),
        ]),
      ).toThrow(/outside the analysis root/);
      expect(readFileSync(inside, 'utf8')).toBe('inside-before');
      expect(readFileSync(outside, 'utf8')).toBe('outside-before');
      expect(findUnfinishedTransactions(root)).toEqual([]);
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('preflights all expected source digests before creating staged state', () => {
    const first = createTarget('first.json', 'first-before');
    const second = createTarget('second.json', 'second-before');
    const staleSecond = request(second, 'second-after');
    staleSecond.expectedSha256 = digest('different-source');

    expect(() =>
      prepareWriteTransaction(root, [request(first, 'first-after'), staleSecond]),
    ).toThrow(/changed since the fix was planned/);
    expect(readFileSync(first, 'utf8')).toBe('first-before');
    expect(readFileSync(second, 'utf8')).toBe('second-before');
    expect(findUnfinishedTransactions(root)).toEqual([]);
  });

  it('rechecks every source immediately before commit and rolls back earlier replacements', () => {
    const first = createTarget('first.json', 'first-before');
    const second = createTarget('second.json', 'second-before');
    const prepared = prepareWriteTransaction(root, [
      request(first, 'first-after'),
      request(second, 'second-after'),
    ]);
    writeFileSync(second, 'changed-by-another-process');

    let failure: TransactionError | undefined;
    try {
      commitWriteTransaction(prepared.journalPath);
    } catch (error) {
      if (error instanceof TransactionError) failure = error;
      else throw error;
    }

    expect(failure?.outcome.state).toBe('manual-recovery-required');
    expect(readFileSync(first, 'utf8')).toBe('first-before');
    expect(readFileSync(second, 'utf8')).toBe('changed-by-another-process');
    expect(JSON.parse(readFileSync(prepared.journalPath, 'utf8')).state).toBe(
      'manual-recovery-required',
    );
  });

  it('retains recovery evidence when a prepared target disappears before commit', () => {
    const target = createTarget('package.json', 'before');
    const prepared = prepareWriteTransaction(root, [request(target, 'after')]);
    const entry = JSON.parse(readFileSync(prepared.journalPath, 'utf8')).entries[0] as {
      backupPath: string;
      stagePath: string;
    };
    unlinkSync(target);

    let failure: TransactionError | undefined;
    try {
      commitWriteTransaction(prepared.journalPath);
    } catch (error) {
      if (error instanceof TransactionError) failure = error;
      else throw error;
    }

    expect(failure?.outcome.state).toBe('manual-recovery-required');
    expect(existsSync(target)).toBe(false);
    expect(existsSync(entry.backupPath)).toBe(true);
    expect(existsSync(entry.stagePath)).toBe(true);
  });

  it('retains recovery evidence when a prepared target changes before commit', () => {
    const target = createTarget('package.json', 'before');
    const prepared = prepareWriteTransaction(root, [request(target, 'after')]);
    const entry = JSON.parse(readFileSync(prepared.journalPath, 'utf8')).entries[0] as {
      backupPath: string;
      stagePath: string;
    };
    writeFileSync(target, 'external-change');

    let failure: TransactionError | undefined;
    try {
      commitWriteTransaction(prepared.journalPath);
    } catch (error) {
      if (error instanceof TransactionError) failure = error;
      else throw error;
    }

    expect(failure?.outcome.state).toBe('manual-recovery-required');
    expect(readFileSync(target, 'utf8')).toBe('external-change');
    expect(existsSync(entry.backupPath)).toBe(true);
    expect(existsSync(entry.stagePath)).toBe(true);
  });

  it('rejects a same-content hardlink substituted for the owned stage', () => {
    const target = createTarget('package.json', 'before');
    const carrier = createTarget('carrier', 'after');
    const prepared = prepareWriteTransaction(root, [request(target, 'after')]);
    const entry = JSON.parse(readFileSync(prepared.journalPath, 'utf8')).entries[0] as {
      stagePath: string;
    };
    unlinkSync(entry.stagePath);
    linkSync(carrier, entry.stagePath);

    expect(() => commitWriteTransaction(prepared.journalPath)).toThrow(TransactionError);
    expect(readFileSync(target, 'utf8')).toBe('before');
    expect(existsSync(entry.stagePath)).toBe(true);

    writeFileSync(carrier, 'changed-carrier');
    expect(readFileSync(target, 'utf8')).toBe('before');
  });

  it('never deletes a foreign file created at a consumed stage name', () => {
    const target = createTarget('package.json', 'before');
    const prepared = prepareWriteTransaction(root, [request(target, 'after')]);
    const entry = JSON.parse(readFileSync(prepared.journalPath, 'utf8')).entries[0] as {
      stagePath: string;
    };
    commitNextWrite(prepared.journalPath);
    writeFileSync(entry.stagePath, 'foreign-file');

    expect(commitWriteTransaction(prepared.journalPath).state).toBe('success');
    expect(readFileSync(entry.stagePath, 'utf8')).toBe('foreign-file');
    expect(JSON.parse(readFileSync(prepared.journalPath, 'utf8')).error).toMatch(
      /refusing to remove unowned transaction file/,
    );
  });

  it('previews recovery without writes, then restores a durably committed target with --apply semantics', () => {
    const target = createTarget('package.json', 'before');
    const prepared = prepareWriteTransaction(root, [request(target, 'after')]);
    expect(commitNextWrite(prepared.journalPath).state).toBe('committing');
    expect(readFileSync(target, 'utf8')).toBe('after');

    const preview = recoverTransaction(prepared.journalPath);
    expect(preview.state).toBe('committing');
    expect(preview.actions).toEqual([`restore ${target} from ${preview.backupPaths[0] as string}`]);
    expect(readFileSync(target, 'utf8')).toBe('after');

    const recovered = recoverTransaction(prepared.journalPath, { apply: true });
    expect(recovered.state).toBe('rollback-success');
    expect(readFileSync(target, 'utf8')).toBe('before');
  });

  it('never overwrites a committed target changed after the durable transition', () => {
    const target = createTarget('package.json', 'before');
    const prepared = prepareWriteTransaction(root, [request(target, 'after')]);
    commitNextWrite(prepared.journalPath);
    writeFileSync(target, 'changed-after-commit');

    const preview = recoverTransaction(prepared.journalPath);
    expect(preview.state).toBe('manual-recovery-required');
    expect(preview.actions[0]).toContain('preserve changed target');

    const recovered = recoverTransaction(prepared.journalPath, { apply: true });
    expect(recovered.state).toBe('manual-recovery-required');
    expect(readFileSync(target, 'utf8')).toBe('changed-after-commit');
    expect(existsSync(recovered.backupPaths[0] as string)).toBe(true);
    expect(findUnfinishedTransactions(root)).toEqual([prepared.journalPath]);
  });

  it('rolls back safe entries even when another entry requires manual recovery', () => {
    const first = createTarget('first.json', 'first-before');
    const second = createTarget('second.json', 'second-before');
    const prepared = prepareWriteTransaction(root, [
      request(first, 'first-after'),
      request(second, 'second-after'),
    ]);
    commitNextWrite(prepared.journalPath);
    commitNextWrite(prepared.journalPath);
    writeFileSync(first, 'external-change');

    const recovered = recoverTransaction(prepared.journalPath, { apply: true });

    expect(recovered.state).toBe('manual-recovery-required');
    expect(readFileSync(first, 'utf8')).toBe('external-change');
    expect(readFileSync(second, 'utf8')).toBe('second-before');
    expect(recovered.actions).toContain(
      `restore ${second} from ${recovered.backupPaths[1] as string}`,
    );

    const acknowledged = recoverTransaction(prepared.journalPath, {
      apply: true,
      acknowledgeManual: true,
    });
    expect(acknowledged.state).toBe('manual-recovery-required');
    expect(readFileSync(second, 'utf8')).toBe('second-before');
    expect(JSON.parse(readFileSync(prepared.journalPath, 'utf8'))).toMatchObject({
      state: 'manual-recovery-required',
      archivedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      manualAcknowledgedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it('requires explicit acknowledgement for a journal missing its durable identity', () => {
    const target = createTarget('package.json', 'before');
    const prepared = prepareWriteTransaction(root, [request(target, 'after')]);
    const journal = JSON.parse(readFileSync(prepared.journalPath, 'utf8')) as {
      state: string;
      entries: Array<{ state: string; committed?: unknown }>;
    };
    journal.state = 'committing';
    const entry = journal.entries[0] as { state: string; committed?: unknown };
    entry.state = 'committed';
    delete entry.committed;
    writeFileSync(prepared.journalPath, `${JSON.stringify(journal, null, 2)}\n`);

    const preview = recoverTransaction(prepared.journalPath);
    expect(preview.state).toBe('manual-recovery-required');
    expect(preview.actions.join('\n')).toContain('explicit acknowledgement is required');
    expect(recoverTransaction(prepared.journalPath, { apply: true }).state).toBe(
      'manual-recovery-required',
    );
    expect(readFileSync(target, 'utf8')).toBe('before');
  });

  it('rejects a same-content hardlink substituted for the owned backup', () => {
    const target = createTarget('package.json', 'before');
    const carrier = createTarget('backup-carrier', 'before');
    const prepared = prepareWriteTransaction(root, [request(target, 'after')]);
    const entry = JSON.parse(readFileSync(prepared.journalPath, 'utf8')).entries[0] as {
      backupPath: string;
    };
    unlinkSync(entry.backupPath);
    linkSync(carrier, entry.backupPath);
    commitNextWrite(prepared.journalPath);

    const recovered = recoverTransaction(prepared.journalPath, { apply: true });

    expect(recovered.state).toBe('manual-recovery-required');
    expect(readFileSync(target, 'utf8')).toBe('after');
    expect(existsSync(entry.backupPath)).toBe(true);
  });

  it('retains the backup when a replacement happened before its commit record and was then changed', () => {
    const target = createTarget('package.json', 'before');
    const prepared = prepareWriteTransaction(root, [request(target, 'after')]);
    const journal = JSON.parse(readFileSync(prepared.journalPath, 'utf8')) as {
      entries: Array<{ backupPath: string; stagePath: string }>;
    };
    const entry = journal.entries[0] as { backupPath: string; stagePath: string };
    renameSync(entry.stagePath, target);
    writeFileSync(target, 'changed-after-undurable-commit');

    let failure: TransactionError | undefined;
    try {
      commitWriteTransaction(prepared.journalPath);
    } catch (error) {
      if (error instanceof TransactionError) failure = error;
      else throw error;
    }

    expect(failure?.outcome.state).toBe('manual-recovery-required');
    expect(readFileSync(target, 'utf8')).toBe('changed-after-undurable-commit');
    expect(existsSync(entry.backupPath)).toBe(true);
  });

  it('keeps a corrupt backup for manual recovery until an explicit acknowledgement is recorded', () => {
    const target = createTarget('package.json', 'before');
    const prepared = prepareWriteTransaction(root, [request(target, 'after')]);
    const initial = JSON.parse(readFileSync(prepared.journalPath, 'utf8')) as {
      entries: Array<{ backupPath: string }>;
    };
    const backup = initial.entries[0]?.backupPath as string;
    writeFileSync(backup, 'corrupt');

    expect(recoverTransaction(prepared.journalPath).state).toBe('manual-recovery-required');
    expect(readFileSync(target, 'utf8')).toBe('before');
    expect(findUnfinishedTransactions(root)).toEqual([prepared.journalPath]);

    const acknowledgement = recoverTransaction(prepared.journalPath, {
      apply: true,
      acknowledgeManual: true,
    });
    expect(acknowledgement.state).toBe('manual-recovery-required');
    const archived = JSON.parse(readFileSync(prepared.journalPath, 'utf8')) as {
      archivedAt?: string;
      manualAcknowledgedAt?: string;
      state: string;
    };
    expect(archived.state).toBe('manual-recovery-required');
    expect(archived.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(archived.manualAcknowledgedAt).toBe(archived.archivedAt);
    expect(findUnfinishedTransactions(root)).toEqual([]);
  });

  it('refuses another fix while an unfinished journal exists', () => {
    const target = createTarget('package.json', 'before');
    const prepared = prepareWriteTransaction(root, [request(target, 'after')]);

    expect(() => executeWriteTransaction(root, [request(target, 'different-after')])).toThrow(
      new RegExp(prepared.journalPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );

    expect(readFileSync(target, 'utf8')).toBe('before');
  });

  it.runIf(process.platform !== 'win32')('preserves the original file mode', () => {
    const target = createTarget('package.json', 'before');
    chmodSync(target, 0o640);

    executeWriteTransaction(root, [request(target, 'after')]);

    expect(statSync(target).mode & 0o777).toBe(0o640);
  });

  it('uses same-directory backups for a committed file', () => {
    const target = createTarget('package.json', 'before');
    const prepared = prepareWriteTransaction(root, [request(target, 'after')]);
    const journal = JSON.parse(readFileSync(prepared.journalPath, 'utf8')) as {
      entries: Array<{ backupPath: string; stagePath: string }>;
    };

    expect(dirname(journal.entries[0]?.backupPath ?? '')).toBe(dirname(target));
    expect(dirname(journal.entries[0]?.stagePath ?? '')).toBe(dirname(target));
  });

  it('removes an already successful journal after its backups are cleaned', () => {
    const target = createTarget('package.json', 'before');
    const completed = executeWriteTransaction(root, [request(target, 'after')]);

    expect(existsSync(completed.journalPath)).toBe(false);
    expect(findUnfinishedTransactions(root)).toEqual([]);
  });

  it('rejects a copied journal outside the owned transaction directory', () => {
    const target = createTarget('package.json', 'before');
    const prepared = prepareWriteTransaction(root, [request(target, 'after')]);
    const copied = join(root, 'copied-journal.json');
    writeFileSync(copied, readFileSync(prepared.journalPath));

    expect(() => recoverTransaction(copied)).toThrow(/owned transaction directory/);
    expect(readFileSync(target, 'utf8')).toBe('before');
  });
});
