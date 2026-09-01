import {
  canonicalJsonDigest,
  type FinalVerification,
  verifyFinalIdempotency,
} from './release/release-state.mjs';

export interface ReadmeReleaseReceipt {
  schemaVersion: 'scriptspect-readme-release-receipt/v1';
  repository: 'https://github.com/Tom409114/scriptspect';
  intentCheckRunId: number;
  finalVerificationAssetId: number;
  finalVerificationDigest: string;
  publishRunId: number;
  finalVerification: FinalVerification;
}

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
const scriptspectRepository = 'https://github.com/Tom409114/scriptspect';

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

function sha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`README release receipt ${field} must be a SHA-256 digest`);
  }
  return value;
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
  if (input.packageVersion !== normalized.finalVerification.version) {
    throw new Error('README release receipt status packageVersion does not match');
  }
  if (input.sourceCommit !== normalized.finalVerification.commit) {
    throw new Error('README release receipt status sourceCommit does not match');
  }
  if (input.repository !== normalized.repository) {
    throw new Error('README release receipt status repository does not match');
  }
  if (normalized.finalVerification.tag !== `v${input.packageVersion}`) {
    throw new Error('README release receipt status tag does not match');
  }
  const evidence = releaseEvidence(input.releaseEvidence);
  if (evidence.digest !== canonicalJsonDigest(normalized)) {
    throw new Error('README release receipt status releaseEvidence digest does not match');
  }
  return normalized;
}
