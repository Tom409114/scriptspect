import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliIo } from '../../src/cli/index';
import { runCli } from '../../src/cli/index';
import { commitNextWrite, prepareWriteTransaction } from '../../src/fixers/transaction';

let root: string;
let output: string[];
let errors: string[];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'scriptspect-transaction-cli-')));
  output = [];
  errors = [];
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture',
        scripts: { clean: 'rm -rf dist' },
        devDependencies: { rimraf: '^5.0.0' },
      },
      null,
      2,
    ),
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const io: CliIo = {
  out: (text) => output.push(text),
  err: (text) => errors.push(text),
};

describe('CLI recoverable fixes', () => {
  it('durably finalizes and cleans transaction state before reporting a successful fix', async () => {
    expect(await runCli([root, '--fix'], io)).toBe(0);

    const transactionDirectory = join(root, '.scriptspect', 'transactions');
    expect(existsSync(transactionDirectory)).toBe(true);
    const journals = readdirSync(transactionDirectory).filter((name) => name.endsWith('.json'));
    expect(journals).toHaveLength(0);
    expect(readdirSync(transactionDirectory)).toEqual([]);
    expect(errors.join('\n')).toContain('fixed 1 script(s)');
  });

  it('previews an unfinished rollback without writes and applies it only with --apply', async () => {
    const target = join(root, 'package.json');
    const original = readFileSync(target);
    const changed = Buffer.from(original.toString('utf8').replace('rm -rf dist', 'rimraf dist'));
    const prepared = prepareWriteTransaction(root, [
      {
        path: target,
        content: changed,
        expectedSha256: createHash('sha256').update(original).digest('hex'),
      },
    ]);
    commitNextWrite(prepared.journalPath);

    expect(await runCli(['recover', '--transaction', prepared.journalPath], io)).toBe(2);
    expect(output.join('\n')).toContain(`restore ${target}`);
    expect(readFileSync(target)).toEqual(changed);

    output = [];
    errors = [];
    expect(await runCli(['recover', '--transaction', prepared.journalPath, '--apply'], io)).toBe(2);
    expect(readFileSync(target)).toEqual(original);
    expect(errors.join('\n')).toContain('rollback-success');
  });

  it('requires an explicit transaction journal for recover', async () => {
    expect(await runCli(['recover'], io)).toBe(2);
    expect(errors.join('\n')).toContain('--transaction');
  });

  it('exposes orphan-lock inspection and acknowledgement through the CLI', async () => {
    const transactions = join(root, '.scriptspect', 'transactions');
    mkdirSync(transactions, { recursive: true });
    const lock = join(transactions, 'write.lock');
    writeFileSync(lock, '00000000-0000-4000-8000-000000000000\n');

    expect(await runCli(['recover', '--transaction', lock], io)).toBe(2);
    expect(output.join('\n')).toContain('explicit acknowledgement is required');
    expect(existsSync(lock)).toBe(true);

    output = [];
    errors = [];
    expect(
      await runCli(['recover', '--transaction', lock, '--apply', '--acknowledge-manual'], io),
    ).toBe(2);
    expect(errors.join('\n')).toContain('rollback-success');
    expect(existsSync(lock)).toBe(false);
  });
});
