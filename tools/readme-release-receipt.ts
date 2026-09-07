import {
  canonicalJsonDigest,
  type FinalVerification,
  verifyFinalIdempotency,
} from './release/release-state.mjs';

export interface TerminalReadmeReleaseReceipt {
  schemaVersion: 'scriptspect-readme-release-receipt/v1';
  repository: 'https://github.com/Tom409114/scriptspect';
  intentCheckRunId: number;
  finalVerificationAssetId: number;
  finalVerificationDigest: string;
  publishRunId: number;
  finalVerification: FinalVerification;
}

export interface ManualFinalizationReadmeReleaseReceipt {
  schemaVersion: 'scriptspect-readme-manual-finalization-receipt/v1';
  repository: 'https://github.com/Tom409114/scriptspect';
  packageName: 'scriptspect';
  version: string;
  tag: string;
  commit: string;
  releaseId: number;
  publishRunId: number;
  finalizationRunId: number;
  finalizationWorkflowPath: '.github/workflows/finalize-published-0.1.2.yml';
  registryNpmSRI: string;
  assets: Array<{ name: string; assetId: number; sha256: string }>;
  aliases: Array<{ name: string; target: string }>;
}

export type ReadmeReleaseReceipt =
  | TerminalReadmeReleaseReceipt
  | ManualFinalizationReadmeReleaseReceipt;

export interface ReadmeReleaseStatus {
  releaseState: 'pre-release' | 'published';
  packageName: string;
  packageVersion: string;
  sourceCommit: string;
  repository: string;
  releaseEvidence?: {
    receiptPath: string;
    digest: string;
  };
}

const receiptKeys = [
  'schemaVersion',
  'repository',
  'intentCheckRunId',
  'finalVerificationAssetId',
  'finalVerificationDigest',
  'publishRunId',
  'finalVerification',
] as const;
const receiptSchema = 'scriptspect-readme-release-receipt/v1';
const manualReceiptSchema = 'scriptspect-readme-manual-finalization-receipt/v1';
const scriptspectRepository = 'https://github.com/Tom409114/scriptspect';
const manualReleaseVersion = '0.1.2';
const manualPublishRunId = 34139934545;
const manualFinalizationRunId = 34140851653;
const manualReceiptKeys = [
  'schemaVersion',
  'repository',
  'packageName',
  'version',
  'tag',
  'commit',
  'releaseId',
  'publishRunId',
  'finalizationRunId',
  'finalizationWorkflowPath',
  'registryNpmSRI',
  'assets',
  'aliases',
] as const;

function exactReceiptObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('README release receipt must be an object with exact keys');
  }
  const actual = Object.keys(value).sort();
  const expected = [...receiptKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('README release receipt must contain exact keys');
  }
  return value as Record<string, unknown>;
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  const input = objectRecord(value, label);
  const actual = Object.keys(input).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`README release receipt ${label} must contain exact keys`);
  }
  return input;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`README release receipt ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`README release receipt ${field} must be a positive integer`);
  }
  return value as number;
}

function trustedPositiveInteger(value: unknown, expected: number, field: string): number {
  const normalized = positiveInteger(value, field);
  if (normalized !== expected) {
    throw new Error(`README release receipt ${field} is not trusted`);
  }
  return normalized;
}

function sha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`README release receipt ${field} must be a SHA-256 digest`);
  }
  return value;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`README release receipt ${field} must be a non-empty string`);
  }
  return value;
}

function exactSha(value: unknown, field: string): string {
  const commit = nonEmptyString(value, field);
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error(`README release receipt ${field} must be an exact lowercase SHA`);
  }
  return commit;
}

function validateManualReceipt(
  input: Record<string, unknown>,
): ManualFinalizationReadmeReleaseReceipt {
  const exact = exactObject(input, manualReceiptKeys, 'manual-finalization receipt');
  if (exact.repository !== scriptspectRepository) {
    throw new Error('README release receipt repository is unexpected');
  }
  if (exact.packageName !== 'scriptspect') {
    throw new Error('README release receipt packageName is unexpected');
  }
  const version = nonEmptyString(exact.version, 'version');
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version)) {
    throw new Error('README release receipt version must be stable semver');
  }
  if (version !== manualReleaseVersion) {
    throw new Error('README release receipt version is not the bounded manual release');
  }
  const tag = nonEmptyString(exact.tag, 'tag');
  if (tag !== `v${version}`) throw new Error('README release receipt tag must match version');
  const commit = exactSha(exact.commit, 'commit');
  if (exact.finalizationWorkflowPath !== '.github/workflows/finalize-published-0.1.2.yml') {
    throw new Error('README release receipt finalizationWorkflowPath is not trusted');
  }
  const registryNpmSRI = nonEmptyString(exact.registryNpmSRI, 'registryNpmSRI');
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(registryNpmSRI)) {
    throw new Error('README release receipt registryNpmSRI must be sha512 SRI');
  }
  if (!Array.isArray(exact.assets) || exact.assets.length !== 4) {
    throw new Error('README release receipt assets must contain the exact four release assets');
  }
  const expectedAssetNames = [
    `scriptspect-${version}.tgz`,
    'SHA256SUMS',
    'candidate-manifest.json',
    'release-manifest.json',
  ].sort();
  const assets = exact.assets.map((value, index) => {
    const asset = exactObject(value, ['name', 'assetId', 'sha256'], `assets[${index}]`);
    return {
      name: nonEmptyString(asset.name, `assets[${index}].name`),
      assetId: positiveInteger(asset.assetId, `assets[${index}].assetId`),
      sha256: sha256(asset.sha256, `assets[${index}].sha256`),
    };
  });
  if (
    JSON.stringify(assets.map(({ name }) => name).sort()) !== JSON.stringify(expectedAssetNames)
  ) {
    throw new Error('README release receipt assets must contain the exact four release assets');
  }
  if (!Array.isArray(exact.aliases) || exact.aliases.length !== 2) {
    throw new Error('README release receipt aliases must contain the major and minor aliases');
  }
  const [major, minor] = version.split('.');
  const expectedAliases = [`v${major}`, `v${major}.${minor}`].sort();
  const aliases = exact.aliases.map((value, index) => {
    const alias = exactObject(value, ['name', 'target'], `aliases[${index}]`);
    return {
      name: nonEmptyString(alias.name, `aliases[${index}].name`),
      target: exactSha(alias.target, `aliases[${index}].target`),
    };
  });
  if (
    JSON.stringify(aliases.map(({ name }) => name).sort()) !== JSON.stringify(expectedAliases) ||
    aliases.some(({ target }) => target !== commit)
  ) {
    throw new Error('README release receipt aliases must target the release commit');
  }
  return {
    schemaVersion: manualReceiptSchema,
    repository: scriptspectRepository,
    packageName: 'scriptspect',
    version,
    tag,
    commit,
    releaseId: positiveInteger(exact.releaseId, 'releaseId'),
    publishRunId: trustedPositiveInteger(exact.publishRunId, manualPublishRunId, 'publishRunId'),
    finalizationRunId: trustedPositiveInteger(
      exact.finalizationRunId,
      manualFinalizationRunId,
      'finalizationRunId',
    ),
    finalizationWorkflowPath: '.github/workflows/finalize-published-0.1.2.yml',
    registryNpmSRI,
    assets,
    aliases,
  };
}

function releaseEvidence(value: unknown): { receiptPath: string; digest: string } {
  const input = objectRecord(value, 'status releaseEvidence');
  const keys = Object.keys(input).sort();
  if (keys.length !== 2 || keys[0] !== 'digest' || keys[1] !== 'receiptPath') {
    throw new Error('README release receipt status releaseEvidence must contain exact keys');
  }
  if (
    typeof input.receiptPath !== 'string' ||
    input.receiptPath.trim() === '' ||
    input.receiptPath.includes('\\') ||
    input.receiptPath.startsWith('/') ||
    /^[A-Za-z]:/u.test(input.receiptPath) ||
    input.receiptPath.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('README release receipt status receiptPath must be repository-relative');
  }
  return {
    receiptPath: input.receiptPath,
    digest: sha256(input.digest, 'status releaseEvidence digest'),
  };
}

export function validateReadmeReleaseReceipt(value: unknown): ReadmeReleaseReceipt {
  const candidate = objectRecord(value, 'receipt');
  if (candidate.schemaVersion === manualReceiptSchema) return validateManualReceipt(candidate);
  const input = exactReceiptObject(value);
  if (input.schemaVersion !== receiptSchema) {
    throw new Error('README release receipt schemaVersion is unsupported');
  }
  if (input.repository !== scriptspectRepository) {
    throw new Error('README release receipt repository is unexpected');
  }
  const finalVerification = verifyFinalIdempotency(null, input.finalVerification).verification;
  const finalVerificationDigest = sha256(input.finalVerificationDigest, 'finalVerificationDigest');
  if (finalVerificationDigest !== canonicalJsonDigest(finalVerification)) {
    throw new Error('README release receipt finalVerificationDigest does not match');
  }
  return {
    schemaVersion: receiptSchema,
    repository: scriptspectRepository,
    intentCheckRunId: positiveInteger(input.intentCheckRunId, 'intentCheckRunId'),
    finalVerificationAssetId: positiveInteger(
      input.finalVerificationAssetId,
      'finalVerificationAssetId',
    ),
    finalVerificationDigest,
    publishRunId: positiveInteger(input.publishRunId, 'publishRunId'),
    finalVerification,
  };
}

export function validateReceiptAgainstStatus(
  receipt: unknown,
  status: unknown,
): ReadmeReleaseReceipt {
  const input = objectRecord(status, 'status');
  if (input.releaseState === 'pre-release') {
    throw new Error('README release receipt is not allowed for pre-release status');
  }
  if (input.releaseState !== 'published') {
    throw new Error('README release receipt status releaseState is unsupported');
  }
  const normalized = validateReadmeReleaseReceipt(receipt);
  if (input.packageName !== 'scriptspect') {
    throw new Error('README release receipt status packageName does not match');
  }
  const version =
    normalized.schemaVersion === receiptSchema
      ? normalized.finalVerification.version
      : normalized.version;
  const commit =
    normalized.schemaVersion === receiptSchema
      ? normalized.finalVerification.commit
      : normalized.commit;
  const tag =
    normalized.schemaVersion === receiptSchema ? normalized.finalVerification.tag : normalized.tag;
  if (input.packageVersion !== version) {
    throw new Error('README release receipt status packageVersion does not match');
  }
  if (input.sourceCommit !== commit) {
    throw new Error('README release receipt status sourceCommit does not match');
  }
  if (input.repository !== normalized.repository) {
    throw new Error('README release receipt status repository does not match');
  }
  if (tag !== `v${input.packageVersion}`) {
    throw new Error('README release receipt status tag does not match');
  }
  const evidence = releaseEvidence(input.releaseEvidence);
  if (evidence.digest !== canonicalJsonDigest(normalized)) {
    throw new Error('README release receipt status releaseEvidence digest does not match');
  }
  return normalized;
}
