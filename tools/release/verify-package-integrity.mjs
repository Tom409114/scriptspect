import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  CANONICAL_TREE_ALGORITHM,
  CANONICAL_TREE_ALGORITHM_DIGEST,
  CANONICAL_TREE_SOURCE_BUNDLE,
  canonicalizeTarball,
} from './canonical-tree.mjs';
import {
  emitJson,
  isMain,
  ReleaseToolError,
  readJson,
  requireCommitSha,
  requireExactKeys,
  requireNpmSri,
  requireSha256,
  requireString,
  runCli,
} from './shared.mjs';

const integrityModes = new Set(['exact-bytes', 'canonical-tree-v1']);

function requireIntegrityContract(value) {
  const contract = requireExactKeys(
    value,
    'npm integrity contract',
    [
      'schemaVersion',
      'package',
      'bootstrapVersion',
      'sourceCommit',
      'integrityMode',
      'registryIntegrity',
      'comparatorAlgorithm',
      'comparatorAlgorithmDigest',
      'latestUnchanged',
      'workflowRunUrl',
      'reviewedAt',
    ],
    ['nextRequiredActions'],
  );
  if (contract.schemaVersion !== 1) {
    throw new ReleaseToolError('npm integrity contract schemaVersion must be 1');
  }
  if (contract.package !== 'scriptspect') {
    throw new ReleaseToolError('npm integrity contract package must be scriptspect');
  }
  const integrityMode = requireString(contract.integrityMode, 'npm integrity contract mode');
  if (!integrityModes.has(integrityMode)) {
    throw new ReleaseToolError(`unsupported integrity mode ${integrityMode}`);
  }
  if (contract.comparatorAlgorithm !== CANONICAL_TREE_ALGORITHM) {
    throw new ReleaseToolError(
      `npm integrity contract comparator algorithm must be ${CANONICAL_TREE_ALGORITHM}`,
    );
  }
  const comparatorAlgorithmDigest = requireSha256(
    contract.comparatorAlgorithmDigest,
    'npm integrity contract comparator algorithm digest',
  );
  if (comparatorAlgorithmDigest !== CANONICAL_TREE_ALGORITHM_DIGEST) {
    throw new ReleaseToolError(
      'npm integrity contract comparator algorithm digest does not match the executable comparator',
    );
  }
  if (contract.latestUnchanged !== true) {
    throw new ReleaseToolError('npm integrity contract latestUnchanged must be true');
  }
  if (contract.nextRequiredActions !== undefined) {
    if (!Array.isArray(contract.nextRequiredActions)) {
      throw new ReleaseToolError('npm integrity contract nextRequiredActions must be an array');
    }
    for (const action of contract.nextRequiredActions) {
      requireString(action, 'npm integrity contract required action');
    }
  }
  return {
    integrityMode,
    comparatorAlgorithmDigest,
    bootstrapVersion: requireString(
      contract.bootstrapVersion,
      'npm integrity contract bootstrapVersion',
      /^0\.0\.0-bootstrap\.[0-9]+$/u,
    ),
    sourceCommit: requireCommitSha(contract.sourceCommit, 'npm integrity contract sourceCommit'),
    registryIntegrity: requireNpmSri(
      contract.registryIntegrity,
      'npm integrity contract registryIntegrity',
    ),
    workflowRunUrl: requireString(
      contract.workflowRunUrl,
      'npm integrity contract workflowRunUrl',
      /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9][0-9]*$/u,
    ),
    reviewedAt: requireString(
      contract.reviewedAt,
      'npm integrity contract reviewedAt',
      /^[0-9]{4}-[0-9]{2}-[0-9]{2}T/u,
    ),
  };
}

function readTarball(path, label) {
  try {
    return readFileSync(path);
  } catch {
    throw new ReleaseToolError(`${label} could not be read`);
  }
}

function npmSri(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

export function verifyPackageIntegrity(input) {
  const request = requireExactKeys(input, 'published package integrity request', [
    'contract',
    'candidatePath',
    'registryPath',
    'candidateNpmSRI',
    'registryNpmSRI',
  ]);
  const contract = requireIntegrityContract(request.contract);
  const candidatePath = requireString(request.candidatePath, 'candidate tarball path');
  const registryPath = requireString(request.registryPath, 'registry tarball path');
  const expectedCandidateSri = requireNpmSri(
    request.candidateNpmSRI,
    'candidate SRI from retained manifest',
  );
  const expectedRegistrySri = requireNpmSri(
    request.registryNpmSRI,
    'registry SRI from npm metadata',
  );
  const candidateBytes = readTarball(candidatePath, 'candidate tarball');
  const registryBytes = readTarball(registryPath, 'registry tarball');
  const candidateNpmSRI = npmSri(candidateBytes);
  const registryNpmSRI = npmSri(registryBytes);
  if (candidateNpmSRI !== expectedCandidateSri) {
    throw new ReleaseToolError('candidate SRI does not match candidate tarball bytes');
  }
  if (registryNpmSRI !== expectedRegistrySri) {
    throw new ReleaseToolError('registry SRI does not match registry tarball bytes');
  }

  const candidateTree = canonicalizeTarball(candidatePath);
  const registryTree = canonicalizeTarball(registryPath);
  for (const [label, tree] of [
    ['candidate', candidateTree],
    ['registry', registryTree],
  ]) {
    if (
      tree.algorithm !== CANONICAL_TREE_ALGORITHM ||
      tree.algorithmDigest !== contract.comparatorAlgorithmDigest
    ) {
      throw new ReleaseToolError(
        `${label} canonical tree does not use the reviewed comparator algorithm digest`,
      );
    }
  }

  const byteEqual = candidateBytes.equals(registryBytes);
  const treeEqual = candidateTree.treeDigest === registryTree.treeDigest;
  if (
    contract.integrityMode === 'exact-bytes' &&
    (!byteEqual || candidateNpmSRI !== registryNpmSRI)
  ) {
    throw new ReleaseToolError(
      'exact-bytes integrity mode requires byte equality and candidate/registry SRI equality',
    );
  }
  if (contract.integrityMode === 'canonical-tree-v1' && !treeEqual) {
    throw new ReleaseToolError(
      'canonical-tree-v1 integrity mode requires canonical tree digest equality',
    );
  }

  return {
    schemaVersion: 'scriptspect-published-integrity/v1',
    integrityMode: contract.integrityMode,
    candidateNpmSRI,
    registryNpmSRI,
    byteEqual,
    treeEqual,
    comparatorAlgorithm: CANONICAL_TREE_ALGORITHM,
    comparatorAlgorithmDigest: contract.comparatorAlgorithmDigest,
    comparatorSourceBundle: CANONICAL_TREE_SOURCE_BUNDLE,
    candidateTree,
    registryTree,
  };
}

function parseFlags(arguments_) {
  const flags = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new ReleaseToolError('integrity verifier flags must be --name value pairs');
    }
    const name = key.slice(2);
    if (Object.hasOwn(flags, name)) {
      throw new ReleaseToolError(`duplicate --${name} flag`);
    }
    flags[name] = value;
  }
  return flags;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const allowed = new Set(['contract', 'candidate', 'registry', 'candidate-sri', 'registry-sri']);
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) throw new ReleaseToolError(`unknown --${key} flag`);
  }
  for (const key of allowed) {
    if (!flags[key]) throw new ReleaseToolError(`missing --${key} flag`);
  }
  emitJson(
    verifyPackageIntegrity({
      contract: readJson(flags.contract, 'npm integrity contract'),
      candidatePath: flags.candidate,
      registryPath: flags.registry,
      candidateNpmSRI: flags['candidate-sri'],
      registryNpmSRI: flags['registry-sri'],
    }),
  );
}

if (isMain(import.meta.url)) runCli(main);
