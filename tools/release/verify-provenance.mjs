import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  deepEqual,
  emitJson,
  isMain,
  ReleaseToolError,
  readJson,
  requireCommitSha,
  requireExactKeys,
  requireObject,
  requireString,
  runCli,
} from './shared.mjs';

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new ReleaseToolError(`${label} must be an array`);
  return value;
}

function requireExpected(value) {
  const input = requireExactKeys(value, 'expected provenance', [
    'package',
    'version',
    'predicateType',
    'subjectDigest',
    'repository',
    'workflowPath',
    'ref',
    'commitSha',
    'builderId',
  ]);
  const subjectDigest = requireExactKeys(input.subjectDigest, 'expected provenance subjectDigest', [
    'algorithm',
    'value',
  ]);
  if (subjectDigest.algorithm !== 'sha512') {
    throw new ReleaseToolError('expected provenance subjectDigest algorithm must be sha512');
  }
  return {
    package: requireString(
      input.package,
      'expected provenance package',
      /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u,
    ),
    version: requireString(input.version, 'expected provenance version'),
    predicateType: requireString(input.predicateType, 'expected provenance predicateType'),
    subjectDigest: {
      algorithm: 'sha512',
      value: requireString(
        subjectDigest.value,
        'expected provenance subjectDigest value',
        /^[0-9a-f]{128}$/u,
      ),
    },
    repository: requireString(
      input.repository,
      'expected provenance repository',
      /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
    ),
    workflowPath: requireString(
      input.workflowPath,
      'expected provenance workflowPath',
      /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/u,
    ),
    ref: requireString(input.ref, 'expected provenance ref', /^refs\/(?:heads|tags)\/.+/u),
    commitSha: requireCommitSha(input.commitSha, 'expected provenance commitSha'),
    builderId: requireString(input.builderId, 'expected provenance builderId'),
  };
}

function canonicalBase64(value, label) {
  const encoded = requireString(
    value,
    label,
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
  );
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.toString('base64') !== encoded) {
    throw new ReleaseToolError(`${label} is not canonical base64`);
  }
  return decoded;
}

function packageReference(entry, expected) {
  if (typeof entry === 'string') return entry === `${expected.package}@${expected.version}`;
  if (!entry || typeof entry !== 'object') return false;
  return (
    (entry.name === expected.package && entry.version === expected.version) ||
    entry.package === `${expected.package}@${expected.version}`
  );
}

function packagePurl(name, version) {
  const encodedName = name.startsWith('@') ? name.replaceAll('/', '%2F') : name;
  return `pkg:npm/${encodedName}@${version}`;
}

function matchesStatement(statement, expected) {
  if (!statement || typeof statement !== 'object') return false;
  if (
    statement._type !== 'https://in-toto.io/Statement/v1' ||
    statement.predicateType !== expected.predicateType
  ) {
    return false;
  }
  const subjects = Array.isArray(statement.subject) ? statement.subject : [];
  const subjectMatches = subjects.filter(
    (subject) =>
      subject?.name === packagePurl(expected.package, expected.version) &&
      subject?.digest?.[expected.subjectDigest.algorithm] === expected.subjectDigest.value,
  );
  if (subjectMatches.length !== 1) return false;
  const definition = statement.predicate?.buildDefinition;
  const workflow = definition?.externalParameters?.workflow;
  if (
    workflow?.repository !== expected.repository ||
    workflow?.path !== expected.workflowPath ||
    workflow?.ref !== expected.ref
  ) {
    return false;
  }
  if (statement.predicate?.runDetails?.builder?.id !== expected.builderId) return false;
  const dependencyUri = `git+${expected.repository}@${expected.ref}`;
  const dependencies = Array.isArray(definition?.resolvedDependencies)
    ? definition.resolvedDependencies
    : [];
  const dependencyMatches = dependencies.filter(
    (dependency) =>
      dependency?.uri === dependencyUri && dependency?.digest?.gitCommit === expected.commitSha,
  );
  return dependencyMatches.length === 1;
}

export function verifyProvenanceAudit(auditValue, expectedValue) {
  const expected = requireExpected(expectedValue);
  const audit = requireObject(auditValue, 'npm provenance audit');
  const invalid = requireArray(audit.invalid, 'npm provenance audit invalid');
  const missing = requireArray(audit.missing, 'npm provenance audit missing');
  if (
    invalid.some((entry) => packageReference(entry, expected)) ||
    missing.some((entry) => packageReference(entry, expected))
  ) {
    throw new ReleaseToolError(
      'exact package/version is invalid or missing in npm provenance audit',
    );
  }
  const verified = requireArray(audit.verified, 'npm provenance audit verified');
  const packages = verified.filter(
    (entry) => entry?.name === expected.package && entry?.version === expected.version,
  );
  if (packages.length !== 1) {
    throw new ReleaseToolError(
      `npm provenance audit must contain exactly one verified package/version; found ${packages.length}`,
    );
  }
  const verifiedPackage = packages[0];
  const directBundles =
    verifiedPackage.attestationBundles === undefined
      ? undefined
      : requireArray(verifiedPackage.attestationBundles, 'verified package attestationBundles');
  let nestedBundles;
  if (verifiedPackage.attestations !== undefined) {
    const attestations = requireObject(
      verifiedPackage.attestations,
      'verified package attestations',
    );
    if (attestations.bundles !== undefined) {
      nestedBundles = requireArray(
        attestations.bundles,
        'verified package nested attestation bundles',
      );
    }
  }
  if (directBundles && nestedBundles && !deepEqual(directBundles, nestedBundles)) {
    throw new ReleaseToolError('conflicting attestation bundle sources');
  }
  const bundleSource = directBundles ?? nestedBundles;
  if (!bundleSource) {
    throw new ReleaseToolError('verified package has no attestation bundles');
  }
  const bundles = bundleSource.filter((entry) => entry?.predicateType === expected.predicateType);
  const matches = [];
  for (const entry of bundles) {
    const envelope = entry?.bundle?.dsseEnvelope;
    if (envelope?.payloadType !== 'application/vnd.in-toto+json') continue;
    let bytes;
    let statement;
    try {
      bytes = canonicalBase64(envelope.payload, 'provenance DSSE payload');
      statement = JSON.parse(bytes.toString('utf8'));
    } catch {
      continue;
    }
    if (matchesStatement(statement, expected)) matches.push({ bytes, statement });
  }
  if (matches.length !== 1) {
    throw new ReleaseToolError(
      `no single verified provenance statement satisfies every expected anchor; found ${matches.length}`,
    );
  }
  return {
    package: expected.package,
    version: expected.version,
    predicateType: expected.predicateType,
    statementDigest: createHash('sha256').update(matches[0].bytes).digest('hex'),
  };
}

function parseFlags(arguments_) {
  const result = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new ReleaseToolError('provenance flags must be --name value pairs');
    }
    const name = key.slice(2);
    if (Object.hasOwn(result, name)) throw new ReleaseToolError(`duplicate --${name} flag`);
    result[name] = value;
  }
  return result;
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length === 2 && !arguments_[0].startsWith('--')) {
    emitJson(
      verifyProvenanceAudit(
        readJson(arguments_[0], 'npm provenance audit'),
        readJson(arguments_[1], 'expected provenance'),
      ),
    );
    return;
  }
  const flags = parseFlags(arguments_);
  const allowed = new Set([
    'audit',
    'package',
    'version',
    'tarball',
    'repository',
    'workflow',
    'ref',
    'sha',
    'predicate-type',
    'builder-id',
  ]);
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) throw new ReleaseToolError(`unknown --${key} flag`);
  }
  for (const key of [
    'audit',
    'package',
    'version',
    'tarball',
    'repository',
    'workflow',
    'ref',
    'sha',
  ]) {
    if (!flags[key]) throw new ReleaseToolError(`missing --${key} flag`);
  }
  let tarball;
  try {
    tarball = readFileSync(flags.tarball);
  } catch {
    throw new ReleaseToolError('tarball could not be read');
  }
  const repository = flags.repository.startsWith('https://')
    ? flags.repository
    : `https://github.com/${flags.repository}`;
  emitJson(
    verifyProvenanceAudit(readJson(flags.audit, 'npm provenance audit'), {
      package: flags.package,
      version: flags.version,
      predicateType: flags['predicate-type'] ?? 'https://slsa.dev/provenance/v1',
      subjectDigest: {
        algorithm: 'sha512',
        value: createHash('sha512').update(tarball).digest('hex'),
      },
      repository,
      workflowPath: flags.workflow,
      ref: flags.ref,
      commitSha: flags.sha,
      builderId: flags['builder-id'] ?? 'https://github.com/actions/runner/github-hosted',
    }),
  );
}

if (isMain(import.meta.url)) runCli(main);
