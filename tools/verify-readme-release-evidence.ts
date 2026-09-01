import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type ReadmeReleaseReceipt,
  validateReadmeReleaseReceipt,
  validateReceiptAgainstStatus,
} from './readme-release-receipt.js';
import {
  type ConsumedState,
  canonicalJsonDigest,
  type FinalVerification,
  validateReleaseState,
  verifyFinalIdempotency,
  verifyPublishedRelease,
} from './release/release-state.mjs';

const defaultRepositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const githubApiVersion = '2022-11-28';

type JsonObject = Record<string, unknown>;

type BaseReadmeStatus = {
  schemaVersion: 1;
  packageName: 'scriptspect';
  packageVersion: string;
  sourceCommit: string;
  nodeMajor: number;
  repository: 'https://github.com/Tom409114/scriptspect';
};

type PreReleaseReadmeStatus = BaseReadmeStatus & {
  releaseState: 'pre-release';
};

type PublishedReadmeStatus = BaseReadmeStatus & {
  releaseState: 'published';
  releaseEvidence: { receiptPath: string; digest: string };
};

type ReadmeStatus = PreReleaseReadmeStatus | PublishedReadmeStatus;

export type VerifyReadmeReleaseEvidenceOptions = {
  repositoryRoot?: string;
  statusPath?: string;
  githubToken?: string;
  fetchImpl?: typeof fetch;
};

export type VerifiedReadmeReleaseEvidence =
  | {
      releaseState: 'pre-release';
      remoteVerification: 'not-required';
      repository: BaseReadmeStatus['repository'];
      packageName: BaseReadmeStatus['packageName'];
      packageVersion: string;
      sourceCommit: string;
    }
  | {
      releaseState: 'published';
      remoteVerification: 'verified';
      repository: ReadmeReleaseReceipt['repository'];
      packageName: string;
      version: string;
      tag: string;
      commit: string;
      releaseId: number;
      intentCheckRunId: number;
      publishRunId: number;
      finalVerificationAssetId: number;
      finalVerificationDigest: string;
    };

function objectValue(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

function sha256(value: unknown, label: string): string {
  const digest = stringValue(value, label);
  if (!/^[0-9a-f]{64}$/u.test(digest)) throw new Error(`${label} must be a SHA-256 digest`);
  return digest;
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label} does not match the terminal release state`);
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

async function readJson(path: string, label: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new Error(`${label} could not be read`);
  }
  return parseJson(text, label);
}

function validateStatus(value: unknown): ReadmeStatus {
  const status = objectValue(value, 'README status');
  if (status.schemaVersion !== 1) throw new Error('README status schemaVersion is unsupported');
  if (status.packageName !== 'scriptspect')
    throw new Error('README status packageName is unexpected');
  const packageVersion = stringValue(status.packageVersion, 'README status packageVersion');
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(packageVersion)) {
    throw new Error('README status packageVersion must be stable semver');
  }
  const sourceCommit = stringValue(status.sourceCommit, 'README status sourceCommit');
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) {
    throw new Error('README status sourceCommit must be an exact lowercase SHA');
  }
  if (!Number.isInteger(status.nodeMajor) || (status.nodeMajor as number) < 22) {
    throw new Error('README status nodeMajor must be at least 22');
  }
  if (status.repository !== 'https://github.com/Tom409114/scriptspect') {
    throw new Error('README status repository is unexpected');
  }
  const base = {
    schemaVersion: 1 as const,
    packageName: 'scriptspect' as const,
    packageVersion,
    sourceCommit,
    nodeMajor: status.nodeMajor as number,
    repository: 'https://github.com/Tom409114/scriptspect' as const,
  };
  if (status.releaseState === 'pre-release') {
    if (status.releaseEvidence !== undefined) {
      throw new Error('pre-release README status must not contain releaseEvidence');
    }
    return { ...base, releaseState: 'pre-release' };
  }
  if (status.releaseState !== 'published') {
    throw new Error('README status releaseState is unsupported');
  }
  if (packageVersion === '0.0.0') {
    throw new Error('published README status needs a released packageVersion');
  }
  const releaseEvidence = objectValue(status.releaseEvidence, 'README status releaseEvidence');
  const digest = sha256(releaseEvidence.digest, 'README status receipt digest');
  const receiptPath = stringValue(releaseEvidence.receiptPath, 'README status receiptPath');
  if (isAbsolute(receiptPath)) throw new Error('README status receiptPath must be relative');
  return {
    ...base,
    releaseState: 'published',
    releaseEvidence: { receiptPath, digest },
  };
}

function isInside(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent !== '' && !pathFromParent.startsWith('..') && !isAbsolute(pathFromParent);
}

async function loadLocalEvidence(
  repositoryRoot: string,
  statusPath: string,
): Promise<{
  statusValue: unknown;
  status: ReadmeStatus;
  receipt?: ReadmeReleaseReceipt;
}> {
  const canonicalRoot = await realpath(repositoryRoot);
  const canonicalStatusPath = await realpath(statusPath);
  const statusValue = await readJson(canonicalStatusPath, 'README status');
  const status = validateStatus(statusValue);
  if (status.releaseState === 'pre-release') return { statusValue, status };
  const allowedReceiptRoot = await realpath(
    resolve(canonicalRoot, 'docs', 'validation', 'releases'),
  );
  const receiptCandidate = resolve(
    dirname(canonicalStatusPath),
    status.releaseEvidence.receiptPath,
  );
  const canonicalReceiptPath = await realpath(receiptCandidate);
  if (!isInside(allowedReceiptRoot, canonicalReceiptPath)) {
    throw new Error('README release receipt must stay under docs/validation/releases');
  }
  const receiptValue = await readJson(canonicalReceiptPath, 'README release receipt');
  const receipt = validateReadmeReleaseReceipt(receiptValue);
  equal(
    canonicalJsonDigest(receipt),
    status.releaseEvidence.digest,
    'README status receipt digest',
  );
  validateReceiptAgainstStatus(receipt, statusValue);
  equal(status.repository, receipt.repository, 'README status repository');
  equal(status.packageName, 'scriptspect', 'README status packageName');
  equal(status.packageVersion, receipt.finalVerification.version, 'README status packageVersion');
  equal(status.sourceCommit, receipt.finalVerification.commit, 'README status sourceCommit');
  return { statusValue, status, receipt };
}

function githubHeaders(githubToken: string | undefined, accept: string): Record<string, string> {
  return {
    accept,
    ...(githubToken === undefined ? {} : { authorization: `Bearer ${githubToken}` }),
    'user-agent': 'scriptspect-readme-release-evidence',
    'x-github-api-version': githubApiVersion,
  };
}

async function request(
  fetchImpl: typeof fetch,
  url: string,
  label: string,
  init?: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw new Error(`${label} request failed: ${String(error)}`);
  }
  if (!response.ok) throw new Error(`${label} request failed with HTTP ${response.status}`);
  return response;
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  label: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await request(fetchImpl, url, label, init);
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new Error(`${label} response is not valid JSON`);
  }
}

function validateCheckRun(value: unknown, receipt: ReadmeReleaseReceipt): ConsumedState {
  const check = objectValue(value, 'intent check run');
  equal(
    positiveInteger(check.id, 'intent check run id'),
    receipt.intentCheckRunId,
    'intent check run id',
  );
  equal(
    stringValue(check.name, 'intent check run name'),
    'release-intent',
    'intent check run name',
  );
  equal(
    stringValue(check.status, 'intent check run status'),
    'completed',
    'intent check run status',
  );
  equal(
    stringValue(check.conclusion, 'intent check run conclusion'),
    'success',
    'intent check run conclusion',
  );
  const app = objectValue(check.app, 'intent check run app');
  equal(
    stringValue(app.slug, 'intent check run app slug'),
    'github-actions',
    'intent check run app slug',
  );
  const output = objectValue(check.output, 'intent check run output');
  const state = validateReleaseState(
    parseJson(
      stringValue(output.text, 'intent check run output.text'),
      'intent check run output.text',
    ),
  );
  if (state.state !== 'consumed') throw new Error('intent check run state must be consumed');
  equal(
    stringValue(check.head_sha, 'intent check run head_sha'),
    state.intent.mergeCommitSha,
    'intent check run head_sha',
  );
  equal(
    stringValue(check.external_id, 'intent check run external_id'),
    state.intent.intentId,
    'intent check run external_id',
  );
  return state;
}

function normalizedAliases(aliases: Array<{ name: string; target: string }>): string {
  return JSON.stringify([...aliases].sort((left, right) => left.name.localeCompare(right.name)));
}

function bindReceiptToState(receipt: ReadmeReleaseReceipt, state: ConsumedState): void {
  const final = receipt.finalVerification;
  equal(final.intentId, state.intent.intentId, 'final verification intentId');
  equal(final.version, state.intent.version, 'final verification version');
  equal(final.tag, state.intent.tag, 'final verification tag');
  equal(final.commit, state.intent.mergeCommitSha, 'final verification commit');
  equal(final.releaseId, state.stagedDraft.releaseId, 'final verification releaseId');
  equal(
    final.candidateManifestDigest,
    state.retainedCandidate.candidateManifestDigest,
    'final verification candidateManifestDigest',
  );
  equal(
    final.releaseManifestDigest,
    state.stagedDraft.releaseManifestDigest,
    'final verification releaseManifestDigest',
  );
  equal(
    final.candidateNpmSRI,
    state.retainedCandidate.npmSRI,
    'final verification candidateNpmSRI',
  );
  equal(final.candidateNpmSRI, state.npmPublished.npmSRI, 'published npm SRI');
  equal(final.version, state.npmPublished.publishedVersion, 'published npm version');
  equal(
    final.registryNpmSRI,
    state.npmVerified.registryNpmSRI,
    'final verification registryNpmSRI',
  );
  equal(
    final.provenanceDigest,
    state.npmVerified.provenanceDigest,
    'final verification provenanceDigest',
  );
  equal(receipt.publishRunId, state.npmPublished.publishRunId, 'receipt publishRunId');
  equal(
    receipt.finalVerificationDigest,
    state.finalPlanned.finalVerificationDigest,
    'receipt finalVerificationDigest',
  );
  equal(
    receipt.finalVerificationDigest,
    state.consumed.finalVerificationDigest,
    'consumed finalVerificationDigest',
  );
  equal(
    receipt.finalVerificationAssetId,
    state.consumed.finalVerificationAssetId,
    'receipt finalVerificationAssetId',
  );
  equal(
    normalizedAliases(final.aliases),
    normalizedAliases(state.aliasesVerified.aliases.map(({ name, target }) => ({ name, target }))),
    'final verification aliases',
  );
}

function parseRepository(repository: string): { apiRoot: string } {
  const url = new URL(repository);
  const segments = url.pathname.split('/').filter(Boolean);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    segments.length !== 2 ||
    url.search ||
    url.hash
  ) {
    throw new Error('README release receipt repository must be an exact GitHub repository URL');
  }
  return { apiRoot: `https://api.github.com/repos/${segments[0]}/${segments[1]}` };
}

function validateTagRef(value: unknown, tag: string, commit: string): void {
  const tagRef = objectValue(value, `${tag} tag ref`);
  const object = objectValue(tagRef.object, `${tag} tag ref object`);
  equal(stringValue(tagRef.ref, `${tag} tag ref name`), `refs/tags/${tag}`, `${tag} tag ref name`);
  equal(
    stringValue(object.type, `${tag} tag ref object type`),
    'commit',
    `${tag} tag ref object type`,
  );
  equal(stringValue(object.sha, `${tag} tag ref target`), commit, `${tag} tag ref target`);
}

function releaseSnapshot(
  value: unknown,
  tagRefValue: unknown,
): {
  releaseId: number;
  tag: string;
  commit: string;
  draft: boolean;
  assets: Array<{ name: string; assetId: number; sha256: string }>;
} {
  const release = objectValue(value, 'GitHub Release');
  const tag = stringValue(release.tag_name, 'GitHub Release tag_name');
  const tagRef = objectValue(tagRefValue, `${tag} tag ref`);
  const tagObject = objectValue(tagRef.object, `${tag} tag ref object`);
  const assets = arrayValue(release.assets, 'GitHub Release assets').map((value, index) => {
    const asset = objectValue(value, `GitHub Release assets[${index}]`);
    const digest = stringValue(asset.digest, `GitHub Release assets[${index}].digest`);
    if (!digest.startsWith('sha256:')) {
      throw new Error(`GitHub Release assets[${index}].digest must use sha256`);
    }
    return {
      name: stringValue(asset.name, `GitHub Release assets[${index}].name`),
      assetId: positiveInteger(asset.id, `GitHub Release assets[${index}].id`),
      sha256: sha256(digest.slice('sha256:'.length), `GitHub Release assets[${index}].digest`),
    };
  });
  if (typeof release.draft !== 'boolean') throw new Error('GitHub Release draft must be boolean');
  if (release.prerelease !== false) throw new Error('GitHub Release prerelease must be false');
  return {
    releaseId: positiveInteger(release.id, 'GitHub Release id'),
    tag,
    commit: stringValue(tagObject.sha, `${tag} tag ref target`),
    draft: release.draft,
    assets,
  };
}

function validateNpmMetadata(value: unknown, packageName: string, final: FinalVerification): void {
  const metadata = objectValue(value, 'npm exact-version metadata');
  equal(stringValue(metadata.name, 'npm metadata name'), packageName, 'npm metadata name');
  equal(
    stringValue(metadata.version, 'npm metadata version'),
    final.version,
    'npm metadata version',
  );
  const dist = objectValue(metadata.dist, 'npm metadata dist');
  equal(
    stringValue(dist.integrity, 'npm metadata dist.integrity'),
    final.registryNpmSRI,
    'npm metadata dist.integrity',
  );
}

export async function verifyReadmeReleaseEvidence(
  options: VerifyReadmeReleaseEvidenceOptions = {},
): Promise<VerifiedReadmeReleaseEvidence> {
  const repositoryRoot = resolve(options.repositoryRoot ?? defaultRepositoryRoot);
  const statusPath = resolve(repositoryRoot, options.statusPath ?? 'docs/readme-status.json');
  const localEvidence = await loadLocalEvidence(repositoryRoot, statusPath);
  if (localEvidence.status.releaseState === 'pre-release') {
    return {
      releaseState: 'pre-release',
      remoteVerification: 'not-required',
      repository: localEvidence.status.repository,
      packageName: localEvidence.status.packageName,
      packageVersion: localEvidence.status.packageVersion,
      sourceCommit: localEvidence.status.sourceCommit,
    };
  }
  const { status, receipt } = localEvidence;
  if (receipt === undefined) throw new Error('published README status is missing its receipt');
  const githubToken = options.githubToken ?? process.env.GITHUB_TOKEN;
  if (githubToken === undefined || githubToken.trim() === '') {
    throw new Error('published README evidence verification requires GITHUB_TOKEN');
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const { apiRoot } = parseRepository(receipt.repository);
  const githubJsonInit: RequestInit = {
    headers: githubHeaders(githubToken, 'application/vnd.github+json'),
  };

  const checkRunValue = await requestJson(
    fetchImpl,
    `${apiRoot}/check-runs/${receipt.intentCheckRunId}`,
    'intent check run',
    githubJsonInit,
  );
  const state = validateCheckRun(checkRunValue, receipt);
  bindReceiptToState(receipt, state);

  const exactTagUrl = `${apiRoot}/git/ref/tags/${encodeURIComponent(receipt.finalVerification.tag)}`;
  const [releaseValue, exactTagValue] = await Promise.all([
    requestJson(
      fetchImpl,
      `${apiRoot}/releases/tags/${encodeURIComponent(receipt.finalVerification.tag)}`,
      'GitHub Release',
      githubJsonInit,
    ),
    requestJson(fetchImpl, exactTagUrl, 'exact tag ref', githubJsonInit),
  ]);
  validateTagRef(exactTagValue, receipt.finalVerification.tag, receipt.finalVerification.commit);
  const observedRelease = releaseSnapshot(releaseValue, exactTagValue);
  verifyPublishedRelease({ state, observed: observedRelease });

  const assetInit: RequestInit = {
    headers: githubHeaders(githubToken, 'application/octet-stream'),
    redirect: 'follow',
  };
  const finalAssetResponse = await request(
    fetchImpl,
    `${apiRoot}/releases/assets/${receipt.finalVerificationAssetId}`,
    'final verification asset',
    assetInit,
  );
  const finalAssetBytes = Buffer.from(await finalAssetResponse.arrayBuffer());
  equal(
    createHash('sha256').update(finalAssetBytes).digest('hex'),
    receipt.finalVerificationDigest,
    'downloaded final verification SHA-256',
  );
  const downloadedFinal = parseJson(
    finalAssetBytes.toString('utf8'),
    'downloaded final verification',
  );
  verifyFinalIdempotency(receipt.finalVerification, downloadedFinal);

  const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(status.packageName)}/${encodeURIComponent(receipt.finalVerification.version)}`;
  const aliasRequests = receipt.finalVerification.aliases.map(async ({ name, target }) => {
    const refValue = await requestJson(
      fetchImpl,
      `${apiRoot}/git/ref/tags/${encodeURIComponent(name)}`,
      `${name} alias ref`,
      githubJsonInit,
    );
    validateTagRef(refValue, name, target);
  });
  const [npmMetadata] = await Promise.all([
    requestJson(fetchImpl, registryUrl, 'npm exact-version metadata', {
      headers: { accept: 'application/json' },
    }),
    ...aliasRequests,
  ]);
  validateNpmMetadata(npmMetadata, status.packageName, receipt.finalVerification);

  return {
    releaseState: 'published',
    remoteVerification: 'verified',
    repository: receipt.repository,
    packageName: status.packageName,
    version: receipt.finalVerification.version,
    tag: receipt.finalVerification.tag,
    commit: receipt.finalVerification.commit,
    releaseId: receipt.finalVerification.releaseId,
    intentCheckRunId: receipt.intentCheckRunId,
    publishRunId: receipt.publishRunId,
    finalVerificationAssetId: receipt.finalVerificationAssetId,
    finalVerificationDigest: receipt.finalVerificationDigest,
  };
}

function parseCliStatusPath(arguments_: string[]): string | undefined {
  if (arguments_.length === 0) return undefined;
  if (arguments_.length === 2 && arguments_[0] === '--status' && arguments_[1]) {
    return arguments_[1];
  }
  throw new Error('usage: verify-readme-release-evidence.ts [--status path]');
}

function isMain(): boolean {
  if (process.argv[1] === undefined) return false;
  return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMain()) {
  verifyReadmeReleaseEvidence({ statusPath: parseCliStatusPath(process.argv.slice(2)) })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${JSON.stringify({ error: message })}\n`);
      process.exitCode = 1;
    });
}
