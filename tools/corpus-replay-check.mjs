import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute } from 'node:path';

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

function fail(message) {
  throw new Error(`corpus replay preflight failed: ${message}`);
}

function git(arguments_) {
  try {
    return execFileSync('git', arguments_, {
      encoding: null,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    fail(`git ${arguments_[0] ?? 'command'} did not complete successfully`);
  }
}

function nulRecords(output, description) {
  const records = [];
  let recordStart = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    records.push(output.subarray(recordStart, index));
    recordStart = index + 1;
  }
  if (recordStart !== output.length) fail(`${description} was not NUL terminated`);
  return records;
}

function validateIndexTags(flag, description) {
  for (const record of nulRecords(git(['ls-files', '-z', flag, '--']), description)) {
    if (record.length < 3 || record[0] !== 0x48 || record[1] !== 0x20) {
      fail(`${description} contains a nonordinary tracked index tag`);
    }
  }
}

function validateEvidenceBasenames(values) {
  if (values.length === 0) fail('at least one evidence basename is required');
  for (const value of values) {
    if (
      value === '' ||
      value === '.' ||
      value === '..' ||
      value.includes('\0') ||
      isAbsolute(value) ||
      dirname(value) !== '.' ||
      basename(value) !== value
    ) {
      fail('evidence inputs must be root-level basenames');
    }
  }
}

function worktreeBytes(mode, path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail('a tracked worktree path could not be inspected');
  }

  if (mode === '120000') {
    if (!stat.isSymbolicLink()) fail('a tracked symlink is not a worktree symlink');
    try {
      return readlinkSync(path, { encoding: 'buffer' });
    } catch {
      fail('a tracked symlink target could not be read');
    }
  }

  if (mode !== '100644' && mode !== '100755') fail('unsupported tracked blob mode');
  if (!stat.isFile()) fail('a tracked blob is not a regular worktree file');
  if (process.platform !== 'win32') {
    const executable = (stat.mode & 0o111) !== 0;
    if (executable !== (mode === '100755')) fail('tracked executable mode differs from HEAD');
  }
  try {
    return readFileSync(path);
  } catch {
    fail('a tracked worktree file could not be read');
  }
}

function validateRawHeadTree() {
  const tree = git(['ls-tree', '-r', '-z', '--full-tree', 'HEAD']);
  for (const record of nulRecords(tree, 'HEAD tree')) {
    const tab = record.indexOf(0x09);
    if (tab <= 0 || tab === record.length - 1) fail('HEAD tree record is malformed');
    const metadata = record.subarray(0, tab).toString('ascii').split(' ');
    if (metadata.length !== 3) fail('HEAD tree metadata is malformed');
    const [mode, type, oid] = metadata;
    if (mode === '160000' || type !== 'blob') fail('gitlinks and non-blob entries are unsupported');
    if (oid === undefined || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(oid)) {
      fail('HEAD tree object ID is malformed');
    }
    const path = record.subarray(tab + 1);
    const bytes = worktreeBytes(mode, path);
    const algorithm = oid.length === 40 ? 'sha1' : 'sha256';
    const actual = createHash(algorithm)
      .update(Buffer.from(`blob ${bytes.length}\0`, 'ascii'))
      .update(bytes)
      .digest('hex');
    if (actual !== oid) fail('tracked worktree bytes differ from HEAD');
  }
}

function main() {
  const [sourceCommit, ...evidenceBasenames] = process.argv.slice(1);
  if (sourceCommit === undefined || !/^[a-f0-9]{40}$/u.test(sourceCommit)) {
    fail('source commit must be an exact 40-character lowercase SHA');
  }
  validateEvidenceBasenames(evidenceBasenames);

  const head = git(['rev-parse', '--verify', 'HEAD']).toString('ascii').trim();
  if (head !== sourceCommit) fail('HEAD does not match the recorded source commit');

  validateIndexTags('-v', 'assume-unchanged/skip-worktree check');
  validateIndexTags('-f', 'fsmonitor-valid check');
  validateRawHeadTree();
  git(['diff', '--quiet', '--ignore-submodules=none', '--']);
  git(['diff', '--cached', '--quiet', '--ignore-submodules=none', '--']);

  const statusPathspec = [
    '.',
    ...new Set(evidenceBasenames.map((value) => `:(top,literal,exclude)${value}`)),
  ];
  const unexpectedStatus = git([
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--ignore-submodules=none',
    '--',
    ...statusPathspec,
  ]);
  if (unexpectedStatus.length !== 0) {
    fail('checkout contains tracked changes or non-evidence untracked files');
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : 'unknown preflight failure';
  console.error(message);
  process.exitCode = 1;
}
