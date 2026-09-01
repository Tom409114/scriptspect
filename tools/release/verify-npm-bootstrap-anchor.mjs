import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function fail(message) {
  throw new Error(`npm bootstrap anchor: ${message}`);
}

function parseOptions(args, names) {
  const allowed = new Set(names.map((name) => `--${name}`));
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!allowed.has(name)) fail(`unknown option ${name ?? ''}`);
    if (value === undefined || value.trim() === '') fail(`${name} needs a value`);
    if (values.has(name)) fail(`duplicate option ${name}`);
    values.set(name, value);
  }
  for (const name of allowed) {
    if (!values.has(name)) fail(`missing option ${name}`);
  }
  return Object.fromEntries([...values].map(([name, value]) => [name.slice(2), value]));
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function object(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} must be a positive integer`);
  return value;
}

function equal(actual, expected, label) {
  if (actual !== expected) fail(`${label} does not match the trusted bootstrap run`);
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(`${label} fields are invalid`);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function verifyProvenance(args) {
  const options = parseOptions(args, [
    'artifacts',
    'run',
    'workflow',
    'repository',
    'artifact-name',
    'repository-name',
    'source-sha',
  ]);
  if (!/^[0-9a-f]{40}$/u.test(options['source-sha'])) fail('source SHA is invalid');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(options['repository-name'])) {
    fail('repository name is invalid');
  }

  const artifacts = object(readJson(options.artifacts, 'artifacts'), 'artifacts');
  const run = object(readJson(options.run, 'workflow run'), 'workflow run');
  const workflow = object(readJson(options.workflow, 'workflow'), 'workflow');
  const repository = object(readJson(options.repository, 'repository'), 'repository');
  const repositoryId = positiveInteger(repository.id, 'repository id');
  equal(repository.full_name, options['repository-name'], 'repository name');
  const workflowId = positiveInteger(workflow.id, 'workflow id');
  equal(workflow.path, '.github/workflows/npm-bootstrap.yml', 'workflow path');

  if (!Array.isArray(artifacts.artifacts)) fail('artifacts list is missing');
  const matches = artifacts.artifacts.filter(
    (entry) => entry?.expired === false && entry?.name === options['artifact-name'],
  );
  if (matches.length !== 1) fail('expected exactly one retained matching artifact');
  const artifact = object(matches[0], 'artifact');
  const artifactId = positiveInteger(artifact.id, 'artifact id');
  if (typeof artifact.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(artifact.digest)) {
    fail('artifact digest is invalid');
  }
  const artifactRun = object(artifact.workflow_run, 'artifact workflow run');
  const runId = positiveInteger(run.id, 'run id');
  equal(positiveInteger(artifactRun.id, 'artifact run id'), runId, 'artifact run id');
  equal(artifactRun.repository_id, repositoryId, 'artifact repository id');
  equal(artifactRun.head_repository_id, repositoryId, 'artifact head repository id');
  equal(artifactRun.head_branch, 'main', 'artifact head branch');
  equal(artifactRun.head_sha, options['source-sha'], 'artifact head SHA');

  equal(run.event, 'workflow_dispatch', 'workflow event');
  equal(run.head_branch, 'main', 'workflow run branch');
  equal(run.head_sha, options['source-sha'], 'workflow run head SHA');
  equal(run.path, '.github/workflows/npm-bootstrap.yml', 'workflow run path');
  equal(run.workflow_id, workflowId, 'workflow id');
  const runRepository = object(run.repository, 'run repository');
  const runHeadRepository = object(run.head_repository, 'run head repository');
  equal(runRepository.id, repositoryId, 'run repository id');
  equal(runRepository.full_name, options['repository-name'], 'run repository name');
  equal(runHeadRepository.id, repositoryId, 'run head repository id');
  equal(runHeadRepository.full_name, options['repository-name'], 'run head repository name');

  return {
    artifactId,
    artifactDigest: artifact.digest,
    runId,
    sourceCommit: options['source-sha'],
    workflowId,
  };
}

function verifyFiles(args) {
  const options = parseOptions(args, ['directory', 'source-sha', 'version']);
  if (!/^[0-9a-f]{40}$/u.test(options['source-sha'])) fail('source SHA is invalid');
  if (!/^0\.0\.0-bootstrap\.(?:0|[1-9][0-9]*)$/u.test(options.version)) {
    fail('version must be a distinct bootstrap prerelease');
  }
  const tarballBasename = `scriptspect-${options.version}.tgz`;
  const expectedFiles = [
    'SHA256SUMS',
    'bootstrap-anchor.json',
    'dist-tags-before.json',
    tarballBasename,
  ].sort();
  const entries = readdirSync(options.directory, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile())) fail('anchor contains a non-file entry');
  if (JSON.stringify(entries.map((entry) => entry.name).sort()) !== JSON.stringify(expectedFiles)) {
    fail('anchor must contain exactly one expected tarball and its three manifests');
  }

  const anchor = object(
    readJson(join(options.directory, 'bootstrap-anchor.json'), 'bootstrap anchor'),
    'bootstrap anchor',
  );
  exactKeys(
    anchor,
    ['schemaVersion', 'sourceCommit', 'version', 'tarball', 'distTagsBeforeDigest'],
    'bootstrap anchor',
  );
  equal(anchor.schemaVersion, 'scriptspect-bootstrap-anchor/v1', 'anchor schema version');
  equal(anchor.sourceCommit, options['source-sha'], 'anchor source commit');
  equal(anchor.version, options.version, 'anchor version');
  const tarball = object(anchor.tarball, 'anchor tarball');
  exactKeys(tarball, ['basename', 'sha256'], 'anchor tarball');
  equal(tarball.basename, tarballBasename, 'anchor tarball basename');
  if (typeof tarball.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(tarball.sha256)) {
    fail('anchor tarball SHA-256 is invalid');
  }
  if (
    typeof anchor.distTagsBeforeDigest !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(anchor.distTagsBeforeDigest)
  ) {
    fail('anchor dist-tags digest is invalid');
  }

  const tarballPath = join(options.directory, tarballBasename);
  const actualTarballSha = sha256(tarballPath);
  equal(tarball.sha256, actualTarballSha, 'anchor tarball SHA-256');
  const sums = readFileSync(join(options.directory, 'SHA256SUMS'), 'utf8');
  const sumMatch = /^([0-9a-f]{64}) {2}([^\r\n]+)\r?\n$/u.exec(sums);
  if (sumMatch === null) fail('SHA256SUMS must contain exactly one text-mode checksum');
  equal(sumMatch[1], actualTarballSha, 'SHA256SUMS digest');
  equal(sumMatch[2], tarballBasename, 'SHA256SUMS basename');

  const distTagsPath = join(options.directory, 'dist-tags-before.json');
  const distTags = readJson(distTagsPath, 'dist-tags before');
  if (typeof distTags !== 'object' || distTags === null || Array.isArray(distTags)) {
    fail('dist-tags before must be a normalized JSON object');
  }
  for (const [name, version] of Object.entries(distTags)) {
    if (name.trim() === '' || typeof version !== 'string' || version.trim() === '') {
      fail('dist-tags before contains an invalid entry');
    }
  }
  equal(anchor.distTagsBeforeDigest, sha256(distTagsPath), 'anchor dist-tags digest');

  return {
    sourceCommit: options['source-sha'],
    version: options.version,
    tarball: { basename: tarballBasename, sha256: actualTarballSha },
    distTagsBeforeDigest: anchor.distTagsBeforeDigest,
  };
}

const [command, ...args] = process.argv.slice(2);
let result;
if (command === 'provenance') result = verifyProvenance(args);
else if (command === 'files') result = verifyFiles(args);
else fail(`unknown command ${command ?? ''}`);
console.log(JSON.stringify(result));
