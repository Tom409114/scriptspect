import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute } from 'node:path';

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const GIT_SAFE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];
const GIT_REDIRECT_ENVIRONMENT = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_SYSTEM',
  'GIT_DIR',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_INDEX_FILE',
  'GIT_NAMESPACE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_QUARANTINE_PATH',
  'GIT_REPLACE_REF_BASE',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
]);

function fail(message) {
  throw new Error(`corpus replay preflight failed: ${message}`);
}

function gitEnvironment(worktree) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    const normalized = key.toUpperCase();
    if (
      GIT_REDIRECT_ENVIRONMENT.has(normalized) ||
      /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(normalized)
    ) {
      delete environment[key];
    }
  }
  environment.GIT_NO_REPLACE_OBJECTS = '1';
  environment.GIT_WORK_TREE = worktree;
  return environment;
}

function git(arguments_) {
  try {
    return execFileSync('git', [...GIT_SAFE_CONFIG, ...arguments_], {
      encoding: null,
      env: gitEnvironment(process.cwd()),
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

function validateEvidenceArguments(values) {
  if (values.length === 0 || values.length % 2 !== 0) {
    fail('evidence basenames and SHA-256 digests must be paired');
  }
  const evidence = [];
  const seen = new Set();
  for (let index = 0; index < values.length; index += 2) {
    const value = values[index];
    const digest = values[index + 1];
    if (
      value === undefined ||
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
    if (seen.has(value)) fail('evidence basenames must be unique');
    if (digest === undefined || !/^[a-f0-9]{64}$/u.test(digest)) {
      fail('evidence SHA-256 digest was invalid');
    }
    seen.add(value);
    evidence.push({ name: value, sha256: digest });
  }
  return evidence;
}

function validateEvidenceFiles(evidence) {
  for (const expected of evidence) {
    let stat;
    try {
      stat = lstatSync(expected.name);
    } catch {
      fail('an evidence input could not be inspected');
    }
    if (!stat.isFile()) fail('evidence inputs must be regular files');
    let bytes;
    try {
      bytes = readFileSync(expected.name);
    } catch {
      fail('an evidence input could not be read');
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected.sha256) fail('evidence input bytes differ from the recorded run');
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
  const entries = new Map();
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
    const pathKey = path.toString('hex');
    if (entries.has(pathKey)) fail('HEAD tree contains a duplicate path');
    const bytes = worktreeBytes(mode, path);
    const algorithm = oid.length === 40 ? 'sha1' : 'sha256';
    const actual = createHash(algorithm)
      .update(Buffer.from(`blob ${bytes.length}\0`, 'ascii'))
      .update(bytes)
      .digest('hex');
    if (actual !== oid) fail('tracked worktree bytes differ from HEAD');
    entries.set(pathKey, { mode, oid });
  }
  return entries;
}

function validateIndexAgainstHead(headEntries) {
  const indexEntries = new Map();
  const index = git(['ls-files', '--stage', '-z', '--full-name', '--']);
  for (const record of nulRecords(index, 'index')) {
    const tab = record.indexOf(0x09);
    if (tab <= 0 || tab === record.length - 1) fail('index record is malformed');
    const metadata = record.subarray(0, tab).toString('ascii').split(' ');
    if (metadata.length !== 3) fail('index metadata is malformed');
    const [mode, oid, stage] = metadata;
    if (
      stage !== '0' ||
      (mode !== '100644' && mode !== '100755' && mode !== '120000') ||
      oid === undefined ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(oid)
    ) {
      fail('index entry is unsupported or malformed');
    }
    const pathKey = record.subarray(tab + 1).toString('hex');
    if (indexEntries.has(pathKey)) fail('index contains a duplicate path');
    indexEntries.set(pathKey, { mode, oid });
  }
  if (indexEntries.size !== headEntries.size) fail('index tree differs from HEAD');
  for (const [pathKey, expected] of headEntries) {
    const actual = indexEntries.get(pathKey);
    if (actual?.mode !== expected.mode || actual.oid !== expected.oid) {
      fail('index tree differs from HEAD');
    }
  }
}

function validateUntrackedEvidence(evidence) {
  const expectedPaths = new Set(evidence.map((value) => Buffer.from(value.name).toString('hex')));
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z', '--full-name', '--']);
  for (const path of nulRecords(untracked, 'untracked file list')) {
    if (!expectedPaths.delete(path.toString('hex'))) {
      fail('checkout contains a non-evidence untracked file');
    }
  }
  if (expectedPaths.size !== 0) {
    fail('evidence inputs must be nonignored untracked root files');
  }
}

function main() {
  const [sourceCommit, ...evidenceArguments] = process.argv.slice(1);
  if (sourceCommit === undefined || !/^[a-f0-9]{40}$/u.test(sourceCommit)) {
    fail('source commit must be an exact 40-character lowercase SHA');
  }
  const evidence = validateEvidenceArguments(evidenceArguments);
  validateEvidenceFiles(evidence);

  const head = git(['rev-parse', '--verify', 'HEAD']).toString('ascii').trim();
  if (head !== sourceCommit) fail('HEAD does not match the recorded source commit');

  const headEntries = validateRawHeadTree();
  validateIndexAgainstHead(headEntries);
  validateUntrackedEvidence(evidence);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : 'unknown preflight failure';
  console.error(message);
  process.exitCode = 1;
}
