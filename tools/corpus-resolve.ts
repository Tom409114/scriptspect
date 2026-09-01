/**
 * Resolve a deterministic corpus sample to immutable commits before scanning.
 *
 * A repository is eligible only when the exact resolved commit exposes a
 * bounded, non-symlink root package.json. API and response-shape errors remain
 * hard failures; only a verified missing/ineligible root manifest is replaced.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CORPUS_LIMITS,
  redactCorpusText,
  selectCorpusFiles,
  type TreeEntry,
} from './corpus-lib';

const GITHUB_API = 'https://api.github.com';

interface GitHubRepositoryResponse {
  default_branch?: string;
}

interface GitHubCommitResponse {
  sha?: string;
}

interface GitHubTreeResponse {
  tree?: TreeEntry[];
  truncated?: boolean;
}

interface CorpusSampleExclusion {
  repository: string;
  commit: string;
  reason: 'root-package-json-unavailable';
}

export interface CorpusSampleEvidence {
  schemaVersion: 1;
  requested: number;
  actual: number;
  candidatesConsidered: number;
  status: 'complete' | 'failed';
  exclusions: CorpusSampleExclusion[];
  error?: string;
}

export interface CorpusResolveOptions {
  candidateFile: string;
  outputFile: string;
  evidenceFile: string;
  requested: number;
  token: string;
  fetchImpl?: typeof fetch;
}

function headers(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'scriptspect-corpus-resolve',
  };
}

async function fetchJson<T>(fetchImpl: typeof fetch, url: string, token: string): Promise<T> {
  const response = await fetchImpl(url, { headers: headers(token) });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}`);
  return (await response.json()) as T;
}

function validRepositoryName(value: string): boolean {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9_.-]{0,38})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99}))$/.exec(
    value,
  );
  return match !== null && !value.includes('..') && !value.endsWith('.');
}

function readCandidates(candidateFile: string): string[] {
  const candidates = readFileSync(candidateFile, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  for (const repository of candidates) {
    if (!validRepositoryName(repository)) {
      throw new Error(`invalid repository name: ${repository}`);
    }
  }
  return [...new Set(candidates)].sort();
}

function exactCommit(value: unknown, repository: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) {
    throw new Error(`${repository}: GitHub commit response had no exact commit`);
  }
  return value;
}

function writeEvidence(
  outputFile: string,
  evidenceFile: string,
  locators: readonly string[],
  evidence: CorpusSampleEvidence,
): void {
  mkdirSync(dirname(resolve(outputFile)), { recursive: true });
  mkdirSync(dirname(resolve(evidenceFile)), { recursive: true });
  writeFileSync(outputFile, locators.length === 0 ? '' : `${locators.join('\n')}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
}

function evidence(
  requested: number,
  locators: readonly string[],
  candidatesConsidered: number,
  exclusions: CorpusSampleExclusion[],
  error?: string,
): CorpusSampleEvidence {
  return {
    schemaVersion: 1,
    requested,
    actual: locators.length,
    candidatesConsidered,
    status: error === undefined ? 'complete' : 'failed',
    exclusions,
    ...(error === undefined ? {} : { error }),
  };
}

/** Select exactly `requested` root-eligible repositories at immutable commits. */
export async function resolveCorpusSample(
  options: CorpusResolveOptions,
): Promise<CorpusSampleEvidence> {
  if (options.token === '') throw new Error('GITHUB_TOKEN is required (read-only public access)');
  if (
    !Number.isSafeInteger(options.requested) ||
    options.requested < 1 ||
    options.requested > 100
  ) {
    throw new Error('requested repository count must be an integer from 1 through 100');
  }

  const candidates = readCandidates(options.candidateFile);
  if (candidates.length < options.requested) {
    throw new Error(
      `requested ${options.requested} repositories but only ${candidates.length} unique candidates were returned`,
    );
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const locators: string[] = [];
  const exclusions: CorpusSampleExclusion[] = [];
  let candidatesConsidered = 0;

  try {
    for (const repository of candidates) {
      candidatesConsidered += 1;
      const metadata = await fetchJson<GitHubRepositoryResponse>(
        fetchImpl,
        `${GITHUB_API}/repos/${repository}`,
        options.token,
      );
      if (typeof metadata.default_branch !== 'string' || metadata.default_branch === '') {
        throw new Error(`${repository}: GitHub repository response had no default branch`);
      }
      const commits = await fetchJson<GitHubCommitResponse[]>(
        fetchImpl,
        `${GITHUB_API}/repos/${repository}/commits?sha=${encodeURIComponent(metadata.default_branch)}&per_page=1`,
        options.token,
      );
      const commit = exactCommit(commits[0]?.sha, repository);
      const rootTree = await fetchJson<GitHubTreeResponse>(
        fetchImpl,
        `${GITHUB_API}/repos/${repository}/git/trees/${commit}`,
        options.token,
      );
      if (!Array.isArray(rootTree.tree)) {
        throw new Error(`${repository}@${commit}: GitHub root tree response had no tree`);
      }
      if (rootTree.truncated === true) {
        throw new Error(`${repository}@${commit}: GitHub root tree response was truncated`);
      }

      const rootManifest = selectCorpusFiles(rootTree.tree, DEFAULT_CORPUS_LIMITS).files.some(
        (entry) => entry.path === 'package.json',
      );
      if (!rootManifest) {
        exclusions.push({
          repository,
          commit,
          reason: 'root-package-json-unavailable',
        });
        continue;
      }

      locators.push(`${repository}@${commit}`);
      if (locators.length === options.requested) break;
    }

    if (locators.length !== options.requested) {
      throw new Error(
        `requested ${options.requested} root-eligible repositories but only ${locators.length} were resolved`,
      );
    }
  } catch (error) {
    const message = redactCorpusText(error instanceof Error ? error.message : String(error));
    const failedEvidence = evidence(
      options.requested,
      locators,
      candidatesConsidered,
      exclusions,
      message,
    );
    writeEvidence(options.outputFile, options.evidenceFile, locators, failedEvidence);
    throw new Error(message);
  }

  const completeEvidence = evidence(options.requested, locators, candidatesConsidered, exclusions);
  writeEvidence(options.outputFile, options.evidenceFile, locators, completeEvidence);
  return completeEvidence;
}

async function main(): Promise<void> {
  const [candidateFile, outputFile, evidenceFile, requestedText] = process.argv.slice(2);
  if (
    candidateFile === undefined ||
    outputFile === undefined ||
    evidenceFile === undefined ||
    requestedText === undefined
  ) {
    throw new Error(
      'usage: tsx tools/corpus-resolve.ts candidates.txt repos.txt repository-sample.json count',
    );
  }
  await resolveCorpusSample({
    candidateFile,
    outputFile,
    evidenceFile,
    requested: Number(requestedText),
    token: process.env.GITHUB_TOKEN ?? '',
  });
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error: unknown) => {
    console.error(
      `scriptspect corpus resolver: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
