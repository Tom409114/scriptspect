/**
 * Immutable, read-only public-corpus scanner.
 *
 * Inputs are exact `owner/repo@40-character-commit` locators. Only bounded
 * package manifests are downloaded, scripts are never executed, and raw
 * script source is never written to evidence artifacts.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AnalysisResult, analyze } from '../src/core/analyze';
import { DEFAULT_TARGETS } from '../src/core/targets';
import { RULES } from '../src/rules';
import type { Finding } from '../src/rules/types';
import {
  type CorpusLimits,
  DEFAULT_CORPUS_LIMITS,
  gitBlobOid,
  parseRepoLocator,
  redactCorpusText,
  selectCorpusFiles,
  sha256,
  type TreeEntry,
} from './corpus-lib';
import {
  checkedResponse,
  type GitHubFailureEvidence,
  githubApiResponse,
  githubFailureEvidence,
  invalidGitHubResponse,
} from './github-api';

const GITHUB_API = 'https://api.github.com';
const GITHUB_RAW = 'https://raw.githubusercontent.com';

interface GitHubTreeResponse {
  tree?: TreeEntry[];
  truncated?: boolean;
}

interface CountSummary {
  repositories: number;
  packages: number;
  scripts: number;
  findings: number;
}

type RepositoryStatus = 'complete' | 'truncated' | 'failed';

interface RepositoryEvidence {
  repository: string;
  commit: string;
  status: RepositoryStatus;
  manifestPaths: string[];
  truncations: string[];
  error?: string;
  failure?: GitHubFailureEvidence;
  rootOnly: Omit<CountSummary, 'repositories'>;
  workspaceFull: Omit<CountSummary, 'repositories'>;
}

interface FindingEvidence {
  findingId: string;
  repository: string;
  commit: string;
  url: string;
  packagePath: string;
  scriptName: string;
  scriptSha256: string;
  ruleId: string;
  subtype?: string;
  severity: Finding['severity'];
  confidence: Finding['confidence'];
  affectedTargets: Finding['affectedTargets'];
  span: Finding['span'];
  message: string;
}

interface CorpusRunManifest {
  schemaVersion: 1;
  generatedAt: string;
  sourceCommit: string;
  scannerSha256: string;
  registrySha256: string;
  inputSha256: string;
  mode: 'root-and-workspace';
  targets: typeof DEFAULT_TARGETS;
  limits: CorpusLimits;
  sampling: {
    method: string;
    seed: string;
    candidateSnapshotSha256?: string;
    sampleEvidenceSha256?: string;
  };
  environment: { node: string; platform: NodeJS.Platform; arch: string; runnerOs?: string };
  repositories: RepositoryEvidence[];
  promotedTotals: { rootOnly: CountSummary; workspaceFull: CountSummary };
  artifactSha256: Record<string, string>;
  reproduction: string;
}

export interface CorpusScanOptions {
  inputFile: string;
  outputDir: string;
  token: string;
  sourceCommit: string;
  generatedAt?: string;
  limits?: CorpusLimits;
  sampleMethod?: string;
  sampleSeed?: string;
  candidateSnapshotFile?: string;
  sampleEvidenceFile?: string;
  fetchImpl?: typeof fetch;
}

function exactSourceCommit(value: string): string {
  if (!/^[a-f0-9]{40}$/.test(value)) {
    throw new Error(
      'SCRIPTSPECT_SOURCE_COMMIT (or GITHUB_SHA) must be an exact 40-character commit',
    );
  }
  return value;
}

function readLocatorSequence(inputFile: string): ReturnType<typeof parseRepoLocator>[] {
  return readFileSync(inputFile, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map(parseRepoLocator);
}

function sortedUniqueLocators(
  locators: readonly ReturnType<typeof parseRepoLocator>[],
): ReturnType<typeof parseRepoLocator>[] {
  const unique = new Map(locators.map((locator) => [`${locator.repo}@${locator.commit}`, locator]));
  return [...unique.values()].sort((left, right) =>
    `${left.repo}@${left.commit}`.localeCompare(`${right.repo}@${right.commit}`),
  );
}

function validateSampleEvidence(
  bytes: Buffer,
  candidateSnapshotSha256: string,
  sampleMethod: string,
  inputLocators: readonly ReturnType<typeof parseRepoLocator>[],
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('corpus sample evidence was not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('corpus sample evidence was invalid');
  }
  const evidence = parsed as {
    status?: unknown;
    method?: unknown;
    candidateSnapshotSha256?: unknown;
    selected?: unknown;
  };
  if (evidence.status !== 'complete') {
    throw new Error('corpus sample evidence status was not complete');
  }
  if (evidence.method !== sampleMethod) {
    throw new Error('corpus sample evidence method did not match the scanner method');
  }
  if (evidence.candidateSnapshotSha256 !== candidateSnapshotSha256) {
    throw new Error('corpus sample evidence candidate snapshot digest did not match');
  }
  if (!Array.isArray(evidence.selected)) {
    throw new Error('corpus sample evidence selected locators were invalid');
  }
  const selectedLocators = evidence.selected.map((value) => {
    if (typeof value !== 'object' || value === null) {
      throw new Error('corpus sample evidence selected locators were invalid');
    }
    const selected = value as { repository?: unknown; commit?: unknown };
    if (typeof selected.repository !== 'string' || typeof selected.commit !== 'string') {
      throw new Error('corpus sample evidence selected locators were invalid');
    }
    try {
      return parseRepoLocator(`${selected.repository}@${selected.commit}`);
    } catch {
      throw new Error('corpus sample evidence selected locators were invalid');
    }
  });
  const selectedSequence = selectedLocators.map((value) => `${value.repo}@${value.commit}`);
  const inputSequence = inputLocators.map((value) => `${value.repo}@${value.commit}`);
  if (JSON.stringify(selectedSequence) !== JSON.stringify(inputSequence)) {
    throw new Error('corpus sample evidence selected locators did not match repos.txt');
  }
}

async function fetchJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
): Promise<{ data: T; response: Response }> {
  const response = await githubApiResponse(fetchImpl, url, token, 'scriptspect-corpus-scan');
  try {
    return { data: (await response.json()) as T, response };
  } catch {
    throw invalidGitHubResponse(url, `GitHub API returned invalid JSON for ${url}`, response);
  }
}

function rawManifestUrl(repo: string, commit: string, path: string): string {
  const [owner, repository] = repo.split('/');
  if (owner === undefined || repository === undefined) {
    throw new Error(`invalid repository name: ${repo}`);
  }
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `${GITHUB_RAW}/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${commit}/${encodedPath}`;
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  overflowMessage: string,
): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(overflowMessage);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

async function downloadSelectedFiles(
  repo: string,
  commit: string,
  entries: readonly TreeEntry[],
  targetRoot: string,
  fetchImpl: typeof fetch,
  limits: CorpusLimits,
): Promise<void> {
  let actualTotal = 0;
  for (const entry of entries) {
    if (!/^[a-f0-9]{40}$/.test(entry.sha)) {
      throw new Error(
        `${entry.path}: immutable tree Git blob OID was not 40 lowercase hex characters`,
      );
    }
    if (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0) {
      throw new Error(`${entry.path}: immutable tree entry had no valid byte size`);
    }
    const expectedBytes = entry.size as number;
    const url = rawManifestUrl(repo, commit, entry.path);
    const response = await checkedResponse(
      fetchImpl,
      url,
      {
        headers: {
          Accept: 'application/octet-stream',
          'User-Agent': 'scriptspect-corpus-scan',
        },
        redirect: 'error',
      },
      'GitHub raw',
    );
    const hardCap = Math.min(
      expectedBytes,
      limits.maxFileBytes,
      limits.maxTotalBytes - actualTotal,
    );
    const sizeMismatchMessage = `${entry.path}: raw byte length did not match the immutable tree entry`;
    const bytes = await readBoundedBody(response, hardCap, sizeMismatchMessage);
    if (bytes.length !== expectedBytes) {
      throw new Error(`${entry.path}: raw byte length did not match the immutable tree entry`);
    }
    if (gitBlobOid(bytes) !== entry.sha) {
      throw new Error(`${entry.path}: raw bytes did not match the immutable tree Git blob OID`);
    }
    actualTotal += bytes.length;
    if (bytes.length > limits.maxFileBytes || actualTotal > limits.maxTotalBytes) {
      throw new Error(`${entry.path}: decoded blob exceeded the corpus byte limits`);
    }
    const destination = join(targetRoot, ...entry.path.split('/'));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes, { flag: 'wx' });
  }
}

function scriptsInPackage(result: AnalysisResult, packagePath: string): number {
  return Object.keys(
    result.packages.find((unit) => unit.relPath === packagePath)?.manifest.scripts ?? {},
  ).length;
}

function repositoryCounts(
  result: AnalysisResult,
): Pick<RepositoryEvidence, 'rootOnly' | 'workspaceFull'> {
  const rootFindings = result.findings.filter((finding) => finding.packagePath === 'package.json');
  return {
    rootOnly: {
      packages: 1,
      scripts: scriptsInPackage(result, 'package.json'),
      findings: rootFindings.length,
    },
    workspaceFull: {
      packages: result.summary.packagesScanned,
      scripts: result.summary.scriptsScanned,
      findings: result.findings.length,
    },
  };
}

function findingEvidence(
  repository: string,
  commit: string,
  result: AnalysisResult,
  finding: Finding,
): FindingEvidence {
  const script = result.packages.find((unit) => unit.relPath === finding.packagePath)?.manifest
    .scripts?.[finding.scriptName];
  if (typeof script !== 'string') throw new Error('finding did not map to an analyzed script');
  const scriptDigest = sha256(script);
  const stableKey = JSON.stringify([
    repository,
    commit,
    finding.packagePath,
    finding.scriptName,
    scriptDigest,
    finding.ruleId,
    finding.subtype ?? '',
    finding.span,
    finding.affectedTargets,
  ]);
  return {
    findingId: sha256(stableKey),
    repository,
    commit,
    url: `https://github.com/${repository}/blob/${commit}/${finding.packagePath}`,
    packagePath: finding.packagePath,
    scriptName: finding.scriptName,
    scriptSha256: scriptDigest,
    ruleId: finding.ruleId,
    ...(finding.subtype === undefined ? {} : { subtype: finding.subtype }),
    severity: finding.severity,
    confidence: finding.confidence,
    affectedTargets: finding.affectedTargets,
    span: finding.span,
    message: redactCorpusText(finding.message),
  };
}

function emptyCounts(): Omit<CountSummary, 'repositories'> {
  return { packages: 0, scripts: 0, findings: 0 };
}

function sumComplete(
  repositories: readonly RepositoryEvidence[],
  field: 'rootOnly' | 'workspaceFull',
): CountSummary {
  const complete = repositories.filter((repo) => repo.status === 'complete');
  return complete.reduce<CountSummary>(
    (total, repo) => ({
      repositories: total.repositories + 1,
      packages: total.packages + repo[field].packages,
      scripts: total.scripts + repo[field].scripts,
      findings: total.findings + repo[field].findings,
    }),
    { repositories: 0, packages: 0, scripts: 0, findings: 0 },
  );
}

function renderSummary(manifest: CorpusRunManifest): string {
  const full = manifest.promotedTotals.workspaceFull;
  const root = manifest.promotedTotals.rootOnly;
  const statusCounts = new Map<RepositoryStatus, number>();
  for (const repo of manifest.repositories) {
    statusCounts.set(repo.status, (statusCounts.get(repo.status) ?? 0) + 1);
  }
  return [
    '# Corpus scan data draft',
    '',
    '> Not product evidence until a maintainer completes the documented adjudication sample.',
    '',
    `- Source commit: \`${manifest.sourceCommit}\``,
    `- Complete repositories: ${statusCounts.get('complete') ?? 0}`,
    `- Truncated repositories (excluded): ${statusCounts.get('truncated') ?? 0}`,
    `- Failed repositories (excluded): ${statusCounts.get('failed') ?? 0}`,
    `- Root-only: ${root.packages} packages, ${root.scripts} scripts, ${root.findings} findings`,
    `- Workspace-full: ${full.packages} packages, ${full.scripts} scripts, ${full.findings} findings`,
    '',
    'The durable machine-readable run manifest is `corpus-run.json`; findings contain hashes and',
    'immutable locators, never raw script source.',
    '',
  ].join('\n');
}

export async function runCorpusScan(options: CorpusScanOptions): Promise<CorpusRunManifest> {
  if (options.token === '') throw new Error('GITHUB_TOKEN is required (read-only public access)');
  const sourceCommit = exactSourceCommit(options.sourceCommit);
  const limits = options.limits ?? DEFAULT_CORPUS_LIMITS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sampleMethod = options.sampleMethod ?? 'popularity-strata-round-robin-v1';
  const candidateSnapshotBytes =
    options.candidateSnapshotFile === undefined
      ? undefined
      : readFileSync(options.candidateSnapshotFile);
  const sampleEvidenceBytes =
    options.sampleEvidenceFile === undefined ? undefined : readFileSync(options.sampleEvidenceFile);
  const candidateSnapshotSha256 =
    candidateSnapshotBytes === undefined ? undefined : sha256(candidateSnapshotBytes);
  const sampleEvidenceSha256 =
    sampleEvidenceBytes === undefined ? undefined : sha256(sampleEvidenceBytes);
  const locatorSequence = readLocatorSequence(options.inputFile);
  if (locatorSequence.length === 0) throw new Error('repository list is empty');
  if (
    candidateSnapshotBytes !== undefined &&
    candidateSnapshotSha256 !== undefined &&
    sampleEvidenceBytes !== undefined
  ) {
    validateSampleEvidence(
      sampleEvidenceBytes,
      candidateSnapshotSha256,
      sampleMethod,
      locatorSequence,
    );
  }
  const locators = sortedUniqueLocators(locatorSequence);
  const outputDir = resolve(options.outputDir);
  mkdirSync(outputDir, { recursive: true });

  const repositories: RepositoryEvidence[] = [];
  const findings: FindingEvidence[] = [];
  for (const locator of locators) {
    const tempRoot = mkdtempSync(join(tmpdir(), 'scriptspect-corpus-'));
    let manifestPaths: string[] = [];
    let truncations: string[] = [];
    try {
      const treeUrl = `${GITHUB_API}/repos/${locator.repo}/git/trees/${locator.commit}?recursive=1`;
      const { data: treeResponse, response: treeHttpResponse } =
        await fetchJson<GitHubTreeResponse>(fetchImpl, treeUrl, options.token);
      if (!Array.isArray(treeResponse.tree)) {
        throw invalidGitHubResponse(treeUrl, 'GitHub tree response had no tree', treeHttpResponse);
      }
      const selected = selectCorpusFiles(treeResponse.tree, limits);
      truncations = [...selected.truncations];
      if (treeResponse.truncated === true) truncations.unshift('github-tree-truncated');
      manifestPaths = selected.files.map((entry) => entry.path);
      if (!manifestPaths.includes('package.json'))
        throw new Error('root package.json was unavailable');
      if (truncations.length !== 0) {
        repositories.push({
          repository: locator.repo,
          commit: locator.commit,
          status: 'truncated',
          manifestPaths,
          truncations,
          rootOnly: emptyCounts(),
          workspaceFull: emptyCounts(),
        });
        continue;
      }
      await downloadSelectedFiles(
        locator.repo,
        locator.commit,
        selected.files,
        tempRoot,
        fetchImpl,
        limits,
      );
      const result = analyze(tempRoot, {
        config: { targets: DEFAULT_TARGETS, severity: new Map(), ignore: [] },
      });
      const counts = repositoryCounts(result);
      const status: RepositoryStatus = 'complete';
      repositories.push({
        repository: locator.repo,
        commit: locator.commit,
        status,
        manifestPaths,
        truncations,
        ...counts,
      });
      if (status === 'complete') {
        for (const finding of result.findings) {
          findings.push(findingEvidence(locator.repo, locator.commit, result, finding));
        }
      }
    } catch (error) {
      const failure = githubFailureEvidence(error);
      repositories.push({
        repository: locator.repo,
        commit: locator.commit,
        status: 'failed',
        manifestPaths,
        truncations,
        error: redactCorpusText(error instanceof Error ? error.message : String(error)),
        ...(failure === undefined ? {} : { failure }),
        rootOnly: emptyCounts(),
        workspaceFull: emptyCounts(),
      });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  findings.sort((left, right) => left.findingId.localeCompare(right.findingId));
  const findingsText = findings.map((finding) => JSON.stringify(finding)).join('\n');
  const findingsArtifact = findingsText === '' ? '' : `${findingsText}\n`;
  const scannerPath = fileURLToPath(import.meta.url);
  const registryPayload = RULES.map((rule) => ({
    id: rule.id,
    severity: rule.severity,
    confidence: rule.confidence,
    affectedTargets: rule.affectedTargets,
    fixSafety: rule.fixSafety,
  }));
  const partialManifest: Omit<CorpusRunManifest, 'artifactSha256'> = {
    schemaVersion: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    sourceCommit,
    scannerSha256: sha256(readFileSync(scannerPath)),
    registrySha256: sha256(JSON.stringify(registryPayload)),
    inputSha256: sha256(readFileSync(options.inputFile)),
    mode: 'root-and-workspace',
    targets: DEFAULT_TARGETS,
    limits,
    sampling: {
      method: sampleMethod,
      seed: options.sampleSeed ?? 'none',
      ...(candidateSnapshotSha256 === undefined ? {} : { candidateSnapshotSha256 }),
      ...(sampleEvidenceSha256 === undefined ? {} : { sampleEvidenceSha256 }),
    },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      ...(process.env.RUNNER_OS === undefined ? {} : { runnerOs: process.env.RUNNER_OS }),
    },
    repositories,
    promotedTotals: {
      rootOnly: sumComplete(repositories, 'rootOnly'),
      workspaceFull: sumComplete(repositories, 'workspaceFull'),
    },
    reproduction: `SCRIPTSPECT_SOURCE_COMMIT=${sourceCommit} pnpm exec tsx tools/corpus-scan.ts ${basename(options.inputFile)}`,
  };
  const provisional = { ...partialManifest, artifactSha256: {} } satisfies CorpusRunManifest;
  const summaryText = renderSummary(provisional);
  const manifest: CorpusRunManifest = {
    ...partialManifest,
    artifactSha256: {
      'findings.jsonl': sha256(findingsArtifact),
      'summary.md': sha256(summaryText),
      ...(options.candidateSnapshotFile === undefined || candidateSnapshotSha256 === undefined
        ? {}
        : { [basename(options.candidateSnapshotFile)]: candidateSnapshotSha256 }),
      ...(options.sampleEvidenceFile === undefined || sampleEvidenceSha256 === undefined
        ? {}
        : { [basename(options.sampleEvidenceFile)]: sampleEvidenceSha256 }),
    },
  };
  writeFileSync(join(outputDir, 'findings.jsonl'), findingsArtifact, {
    encoding: 'utf8',
    flag: 'wx',
  });
  writeFileSync(join(outputDir, 'summary.md'), summaryText, { encoding: 'utf8', flag: 'wx' });
  writeFileSync(join(outputDir, 'corpus-run.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });

  if (repositories.some((repo) => repo.status === 'failed')) {
    throw new Error('one or more repositories failed; inspect corpus-run.json');
  }
  return manifest;
}

async function main(): Promise<void> {
  const inputFile = process.argv[2];
  if (inputFile === undefined) {
    throw new Error('usage: tsx tools/corpus-scan.ts repos.txt [output-directory]');
  }
  await runCorpusScan({
    inputFile,
    outputDir: process.argv[3] ?? process.cwd(),
    token: process.env.GITHUB_TOKEN ?? '',
    sourceCommit: process.env.SCRIPTSPECT_SOURCE_COMMIT ?? process.env.GITHUB_SHA ?? '',
    sampleMethod: process.env.CORPUS_SAMPLE_METHOD,
    sampleSeed: process.env.CORPUS_SAMPLE_SEED,
    candidateSnapshotFile: process.env.CORPUS_CANDIDATE_SNAPSHOT,
    sampleEvidenceFile: process.env.CORPUS_SAMPLE_EVIDENCE,
  });
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error: unknown) => {
    console.error(
      `scriptspect corpus scan: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
