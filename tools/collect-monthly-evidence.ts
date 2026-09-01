/** Build an unreviewed monthly evidence draft from public GitHub and npm APIs. */
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { sha256 } from './corpus-lib';

const GITHUB_API = 'https://api.github.com';
const NPM_REGISTRY = 'https://registry.npmjs.org';
const NPM_DOWNLOADS_API = 'https://api.npmjs.org';
const USER_AGENT = 'scriptspect-monthly-evidence/1';
const PARTIAL_COLLECTION_MESSAGE =
  'Monthly evidence collection was partial; review the generated draft artifact.';

class PartialMonthlyEvidenceError extends Error {
  constructor() {
    super(PARTIAL_COLLECTION_MESSAGE);
    this.name = 'PartialMonthlyEvidenceError';
  }
}

type Completeness = 'complete' | 'partial' | 'missing';
type MetricStatus = 'observed' | 'missing' | 'partial' | 'not-collected' | 'not-applicable';
type JsonValue = Record<string, unknown> | unknown[];

export interface EvidenceMetric {
  value: number | string | null;
  status: MetricStatus;
  sources: string[];
  note: string;
}

export interface EvidenceSource {
  id: string;
  provider: 'github' | 'npm';
  method: 'GET';
  url: string;
  query: Record<string, string>;
  completeness: Completeness;
  httpStatus: number | null;
  response: {
    sha256: string | null;
    byteLength: number | null;
    jsonType: 'object' | 'array' | null;
    topLevelKeys: string[];
    recordCount: number | null;
  };
  note: string;
}

export interface EvidenceCategory {
  reviewState: 'unreviewed';
  reviewer: null;
  reviewedAt: null;
  metrics: Record<string, EvidenceMetric>;
}

export interface MonthlyEvidenceDraft {
  schemaVersion: 'scriptspect-monthly-evidence-draft/v1';
  repository: string;
  package: string;
  period: string;
  collectedAt: string;
  generation: {
    status: 'complete' | 'partial';
    automated: true;
    commitSha: string | null;
    workflowRunUrl: string | null;
  };
  sources: EvidenceSource[];
  ledger: {
    adoption: EvidenceCategory;
    community: EvidenceCategory;
    maintenance: EvidenceCategory;
    quality: EvidenceCategory;
    impact: EvidenceCategory;
    aiLeverage: EvidenceCategory;
  };
  review: {
    state: 'unreviewed';
    reviewer: null;
    reviewedAt: null;
    approvedForPublication: false;
  };
  warnings: string[];
}

export interface CollectMonthlyEvidenceOptions {
  repository: string;
  packageName: string;
  githubToken: string;
  now?: Date;
  commitSha?: string | null;
  workflowRunUrl?: string | null;
  fetchImpl?: typeof fetch;
}

interface CollectedResponse {
  source: EvidenceSource;
  data: JsonValue | null;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a JSON array`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${label} must be a string`);
  return value;
}

function validRepository(value: string): boolean {
  return (
    /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,38})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/.test(value) &&
    !value.includes('..') &&
    !value.endsWith('.')
  );
}

function validPackageName(value: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value);
}

function apiUrl(base: string, path: string, query: Record<string, string> = {}): string {
  const url = new URL(path, `${base.replace(/\/$/u, '')}/`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

function responseShape(
  value: JsonValue,
): Pick<EvidenceSource['response'], 'jsonType' | 'topLevelKeys' | 'recordCount'> {
  if (Array.isArray(value)) {
    return { jsonType: 'array', topLevelKeys: [], recordCount: value.length };
  }
  const recordCount = Array.isArray(value.items)
    ? value.items.length
    : Array.isArray(value.workflow_runs)
      ? value.workflow_runs.length
      : null;
  return {
    jsonType: 'object',
    topLevelKeys: Object.keys(value).toSorted(),
    recordCount,
  };
}

async function collectResponse(
  fetchImpl: typeof fetch,
  request: {
    id: string;
    provider: EvidenceSource['provider'];
    url: string;
    token?: string;
  },
): Promise<CollectedResponse> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
  };
  if (request.provider === 'github') {
    headers.Accept = 'application/vnd.github+json';
    headers['X-GitHub-Api-Version'] = '2022-11-28';
    if (request.token !== undefined && request.token !== '') {
      headers.Authorization = `Bearer ${request.token}`;
    }
  }
  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: 'GET',
      headers,
      redirect: 'error',
    });
  } catch {
    const url = new URL(request.url);
    return {
      data: null,
      source: {
        id: request.id,
        provider: request.provider,
        method: 'GET',
        url: `${url.origin}${url.pathname}`,
        query: Object.fromEntries(url.searchParams.entries()),
        completeness: 'partial',
        httpStatus: null,
        response: {
          sha256: null,
          byteLength: null,
          jsonType: null,
          topLevelKeys: [],
          recordCount: null,
        },
        note: 'The public request failed before a response; exception text is not persisted.',
      },
    };
  }
  let responseText: string;
  try {
    responseText = await response.text();
  } catch {
    const url = new URL(request.url);
    const completeness: Completeness = response.status === 404 ? 'missing' : 'partial';
    return {
      data: null,
      source: {
        id: request.id,
        provider: request.provider,
        method: 'GET',
        url: `${url.origin}${url.pathname}`,
        query: Object.fromEntries(url.searchParams.entries()),
        completeness,
        httpStatus: response.status,
        response: {
          sha256: null,
          byteLength: null,
          jsonType: null,
          topLevelKeys: [],
          recordCount: null,
        },
        note: 'The public endpoint responded but its body could not be read; exception text is not persisted.',
      },
    };
  }
  let data: JsonValue | null = null;
  try {
    data = JSON.parse(responseText) as JsonValue;
  } catch {
    // The raw bytes are hashed below, but malformed response text is never persisted.
  }
  if (typeof data !== 'object' || data === null) data = null;
  const url = new URL(request.url);
  const hasNextPage = /<[^>]+>;\s*rel="next"/u.test(response.headers.get('link') ?? '');
  const completeness: Completeness =
    response.status === 404
      ? 'missing'
      : response.ok && data !== null && !hasNextPage
        ? 'complete'
        : 'partial';
  const shape =
    data === null ? { jsonType: null, topLevelKeys: [], recordCount: null } : responseShape(data);
  return {
    data,
    source: {
      id: request.id,
      provider: request.provider,
      method: 'GET',
      url: `${url.origin}${url.pathname}`,
      query: Object.fromEntries(url.searchParams.entries()),
      completeness,
      httpStatus: response.status,
      response: {
        sha256: sha256(responseText),
        byteLength: Buffer.byteLength(responseText),
        ...shape,
      },
      note:
        completeness === 'complete'
          ? 'Complete response under endpoint pagination metadata; no raw body is persisted.'
          : completeness === 'missing'
            ? 'The public endpoint returned 404; no metric is inferred from absence.'
            : hasNextPage
              ? 'Additional pages exist; first-page counts are not promoted to metrics.'
              : `The public endpoint returned HTTP ${response.status} or invalid JSON; metrics remain null.`,
    },
  };
}

function metric(
  value: number | string | null,
  source: string,
  note: string,
  status: MetricStatus = 'observed',
): EvidenceMetric {
  return { value, status, sources: source === '' ? [] : [source], note };
}

function placeholder(note: string): EvidenceMetric {
  return metric(null, '', note, 'not-collected');
}

function sourceMetric(
  source: EvidenceSource,
  value: number | string | null | undefined,
  note: string,
  emptyStatus: MetricStatus = 'not-applicable',
): EvidenceMetric {
  if (source.completeness === 'missing') return metric(null, source.id, note, 'missing');
  if (source.completeness !== 'complete' || value === undefined) {
    return metric(null, source.id, note, 'partial');
  }
  if (value === null) return metric(null, source.id, note, emptyStatus);
  return metric(value, source.id, note);
}

function category(metrics: Record<string, EvidenceMetric>): EvidenceCategory {
  return { reviewState: 'unreviewed', reviewer: null, reviewedAt: null, metrics };
}

function externalHuman(value: unknown, owner: string): { external: boolean; pullRequest: boolean } {
  const issue = record(value, 'GitHub issue');
  const user = record(issue.user, 'GitHub issue user');
  const login = string(user.login, 'GitHub issue user login');
  const type = string(user.type, 'GitHub issue user type');
  return {
    external:
      login.toLowerCase() !== owner.toLowerCase() && type !== 'Bot' && !login.endsWith('[bot]'),
    pullRequest: typeof issue.pull_request === 'object' && issue.pull_request !== null,
  };
}

/** Collect only machine-observable data. The returned draft is never a reviewed public claim. */
export async function collectMonthlyEvidence(
  options: CollectMonthlyEvidenceOptions,
): Promise<MonthlyEvidenceDraft> {
  if (!validRepository(options.repository)) throw new Error('repository must be owner/name');
  if (!validPackageName(options.packageName)) throw new Error('package name is invalid');
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('collection time is invalid');
  const [owner, repositoryName] = options.repository.split('/') as [string, string];
  const encodedRepository = `${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}`;
  const encodedPackage = encodeURIComponent(options.packageName);
  const fetchImpl = options.fetchImpl ?? fetch;

  const [repository, issues, releases, actions, npmPackage, npmDownloads] = await Promise.all([
    collectResponse(fetchImpl, {
      id: 'github-repository',
      provider: 'github',
      url: apiUrl(GITHUB_API, `repos/${encodedRepository}`),
      token: options.githubToken,
    }),
    collectResponse(fetchImpl, {
      id: 'github-issues',
      provider: 'github',
      url: apiUrl(GITHUB_API, `repos/${encodedRepository}/issues`, {
        state: 'all',
        per_page: '100',
      }),
      token: options.githubToken,
    }),
    collectResponse(fetchImpl, {
      id: 'github-releases',
      provider: 'github',
      url: apiUrl(GITHUB_API, `repos/${encodedRepository}/releases`, { per_page: '100' }),
      token: options.githubToken,
    }),
    collectResponse(fetchImpl, {
      id: 'github-actions-ci',
      provider: 'github',
      url: apiUrl(GITHUB_API, `repos/${encodedRepository}/actions/workflows/ci.yml/runs`, {
        per_page: '100',
      }),
      token: options.githubToken,
    }),
    collectResponse(fetchImpl, {
      id: 'npm-package',
      provider: 'npm',
      url: apiUrl(NPM_REGISTRY, encodedPackage),
    }),
    collectResponse(fetchImpl, {
      id: 'npm-downloads',
      provider: 'npm',
      url: apiUrl(NPM_DOWNLOADS_API, `downloads/point/last-month/${encodedPackage}`),
    }),
  ]);

  let stars: number | undefined;
  let forks: number | undefined;
  if (repository.source.completeness === 'complete') {
    const repositoryData = record(repository.data, 'GitHub repository response');
    if (string(repositoryData.full_name, 'GitHub repository full_name') !== options.repository) {
      throw new Error('GitHub repository response did not match the requested repository');
    }
    stars = integer(repositoryData.stargazers_count, 'GitHub repository stars');
    forks = integer(repositoryData.forks_count, 'GitHub repository forks');
  }

  let externalIssues: number | undefined;
  let externalPullRequests: number | undefined;
  if (issues.source.completeness === 'complete') {
    externalIssues = 0;
    externalPullRequests = 0;
    for (const value of array(issues.data, 'GitHub issues response')) {
      const classification = externalHuman(value, owner);
      if (!classification.external) continue;
      if (classification.pullRequest) externalPullRequests += 1;
      else externalIssues += 1;
    }
  }

  const releaseRows =
    releases.source.completeness === 'complete'
      ? array(releases.data, 'GitHub releases response').map((value) =>
          record(value, 'GitHub release'),
        )
      : undefined;
  const publishedReleaseDates = (releaseRows ?? [])
    .filter((value) => value.draft === false && typeof value.published_at === 'string')
    .map((value) => value.published_at as string)
    .toSorted()
    .reverse();

  let totalRuns: number | undefined;
  let successfulRuns: number | undefined;
  if (actions.source.completeness === 'complete') {
    const actionsData = record(actions.data, 'GitHub Actions response');
    const workflowRuns = array(actionsData.workflow_runs, 'GitHub Actions workflow_runs').map(
      (value) => record(value, 'GitHub Actions workflow run'),
    );
    const advertisedRuns = integer(actionsData.total_count, 'GitHub Actions total_count');
    if (advertisedRuns === workflowRuns.length) {
      totalRuns = advertisedRuns;
      successfulRuns = workflowRuns.filter(
        (value) => value.status === 'completed' && value.conclusion === 'success',
      ).length;
    } else {
      actions.source.completeness = 'partial';
      actions.source.note =
        'The workflow total exceeds the returned page; partial counts are not promoted.';
    }
  }

  let latestNpmVersion: string | undefined;
  if (npmPackage.source.completeness === 'complete') {
    const npmPackageData = record(npmPackage.data, 'npm package response');
    if (string(npmPackageData.name, 'npm package name') !== options.packageName) {
      throw new Error('npm package response did not match the requested package');
    }
    const distTags = record(npmPackageData['dist-tags'], 'npm dist-tags');
    latestNpmVersion = string(distTags.latest, 'npm latest dist-tag');
  }
  const downloadCount =
    npmDownloads.source.completeness === 'complete'
      ? integer(record(npmDownloads.data, 'npm downloads response').downloads, 'npm downloads')
      : undefined;

  const sources = [
    repository.source,
    issues.source,
    releases.source,
    actions.source,
    npmPackage.source,
    npmDownloads.source,
  ];
  return {
    schemaVersion: 'scriptspect-monthly-evidence-draft/v1',
    repository: options.repository,
    package: options.packageName,
    period: now.toISOString().slice(0, 7),
    collectedAt: now.toISOString(),
    generation: {
      status: sources.every((source) => source.completeness === 'complete')
        ? 'complete'
        : 'partial',
      automated: true,
      commitSha: options.commitSha ?? null,
      workflowRunUrl: options.workflowRunUrl ?? null,
    },
    sources,
    ledger: {
      adoption: category({
        stars: sourceMetric(
          repository.source,
          stars,
          'Repository stargazer count at collection time.',
        ),
        forks: sourceMetric(repository.source, forks, 'Repository fork count at collection time.'),
        npmDownloadsLastMonth: sourceMetric(
          npmDownloads.source,
          downloadCount,
          'npm public downloads API last-month window.',
        ),
        latestNpmVersion: sourceMetric(
          npmPackage.source,
          latestNpmVersion,
          'Public npm latest dist-tag at collection time.',
        ),
        publicActionUses: placeholder('Requires a separately reviewed public-code query.'),
        publicCliUses: placeholder('Requires a separately reviewed public-code query.'),
        repeatDownstream: placeholder('Requires longitudinal, reviewed downstream evidence.'),
      }),
      community: category({
        externalIssues: sourceMetric(
          issues.source,
          externalIssues,
          'Complete issue page, excluding owner and bot authors.',
        ),
        externalPullRequests: sourceMetric(
          issues.source,
          externalPullRequests,
          'Complete issue page pull requests, excluding owner and bot authors.',
        ),
        externalContributors: placeholder('Requires a complete contributors query and review.'),
        repeatContributors: placeholder('Requires longitudinal, reviewed contributor evidence.'),
        firstResponseTimeHours: placeholder('Requires reviewed issue-event timelines.'),
      }),
      maintenance: category({
        publicReleases: sourceMetric(
          releases.source,
          releaseRows?.filter((value) => value.draft === false).length,
          'Non-draft GitHub Releases in the complete response.',
        ),
        latestReleaseAt: sourceMetric(
          releases.source,
          releaseRows === undefined ? undefined : (publishedReleaseDates[0] ?? null),
          publishedReleaseDates[0] === undefined
            ? 'No published release exists.'
            : 'Newest public release timestamp in the complete response.',
        ),
        triagedIssues: placeholder('Requires reviewed issue labels and timelines.'),
        regressionFixes: placeholder('Requires reviewed pull request and fixture evidence.'),
        ruleChanges: placeholder('Requires reviewed release and rule-registry evidence.'),
      }),
      quality: category({
        hostedCiRuns: sourceMetric(actions.source, totalRuns, 'Complete CI workflow run response.'),
        hostedCiSuccessfulRuns: sourceMetric(
          actions.source,
          successfulRuns,
          'Completed CI runs whose conclusion is success.',
        ),
        hostedCiPassRate:
          totalRuns === 0 && actions.source.completeness === 'complete'
            ? sourceMetric(actions.source, null, 'No CI runs exist in the period.')
            : sourceMetric(
                actions.source,
                totalRuns === undefined || successfulRuns === undefined
                  ? undefined
                  : successfulRuns / totalRuns,
                'Successful completed runs divided by all returned CI runs.',
              ),
        parserRuleCoverage: placeholder('Requires an immutable hosted coverage artifact.'),
        criticalVulnerabilities: placeholder('Requires an authorized, reviewed security query.'),
        falsePositiveRate: placeholder('Requires completed human adjudication.'),
      }),
      impact: category({
        confirmedCrossPlatformBugs: placeholder('Requires reviewed public issue evidence.'),
        acceptedUpstreamFixes: placeholder('Requires explicit public upstream links and review.'),
      }),
      aiLeverage: category({
        assistedChanges: placeholder('Requires maintainer-reviewed AI usage records.'),
        rejectedSuggestions: placeholder('Requires maintainer-reviewed rejection records.'),
      }),
    },
    review: {
      state: 'unreviewed',
      reviewer: null,
      reviewedAt: null,
      approvedForPublication: false,
    },
    warnings: sources
      .filter((source) => source.completeness !== 'complete')
      .map(
        (source) =>
          `${source.id}: ${source.completeness}; affected metrics remain null pending review`,
      ),
  };
}

const CATEGORY_LABELS: Array<[keyof MonthlyEvidenceDraft['ledger'], string]> = [
  ['adoption', 'Adoption'],
  ['community', 'Community'],
  ['maintenance', 'Maintenance'],
  ['quality', 'Quality'],
  ['impact', 'Impact'],
  ['aiLeverage', 'AI leverage'],
];

function markdownCell(value: unknown): string {
  return String(value).replaceAll('|', '\\|').replaceAll(/\r?\n/gu, ' ');
}

function queryString(query: Record<string, string>): string {
  return new URLSearchParams(
    Object.entries(query).toSorted(([left], [right]) => left.localeCompare(right)),
  ).toString();
}

/** Render a human-review surface. It deliberately labels automation output as unreviewed. */
export function renderMonthlyEvidenceMarkdown(draft: MonthlyEvidenceDraft): string {
  const lines = [
    `# Monthly evidence draft — ${draft.period}`,
    '',
    '> **UNREVIEWED — not approved for publication.** Missing or partial observations stay',
    '> `null`; a maintainer must validate every source before publishing any claim.',
    '',
    `- Repository: \`${draft.repository}\``,
    `- Package: \`${draft.package}\``,
    `- Collected at: \`${draft.collectedAt}\``,
    `- Generation status: \`${draft.generation.status}\``,
    `- Reviewer: _unassigned_`,
    `- Review state: \`${draft.review.state}\``,
    '',
    '## Source receipts',
    '',
    '| Source | URL | Query | Completeness | HTTP | SHA-256 | Response shape |',
    '| --- | --- | --- | --- | ---: | --- | --- |',
  ];

  for (const source of draft.sources) {
    const query = queryString(source.query);
    const shape =
      source.response.jsonType === null
        ? 'unavailable'
        : `${source.response.jsonType}; ${source.response.recordCount ?? 'n/a'} records; ${source.response.byteLength ?? 'n/a'} bytes`;
    lines.push(
      `| ${markdownCell(source.id)} | ${markdownCell(source.url)} | \`${markdownCell(query || '(none)')}\` | \`${source.completeness}\` | ${source.httpStatus ?? 'n/a'} | \`${source.response.sha256 ?? 'unavailable'}\` | ${markdownCell(shape)} |`,
    );
  }

  for (const [categoryKey, label] of CATEGORY_LABELS) {
    const evidenceCategory = draft.ledger[categoryKey];
    lines.push(
      '',
      `## ${label}`,
      '',
      `Review state: \`${evidenceCategory.reviewState}\`; reviewer: _unassigned_.`,
      '',
      '| Metric | Value | Status | Sources | Note |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const [metricName, evidenceMetric] of Object.entries(evidenceCategory.metrics)) {
      lines.push(
        `| ${markdownCell(metricName)} | \`${markdownCell(evidenceMetric.value === null ? 'null' : evidenceMetric.value)}\` | \`${evidenceMetric.status}\` | ${markdownCell(evidenceMetric.sources.join(', ') || 'none')} | ${markdownCell(evidenceMetric.note)} |`,
      );
    }
  }

  lines.push('', '## Warnings', '');
  if (draft.warnings.length === 0) lines.push('- None reported by the collector.');
  else lines.push(...draft.warnings.map((warning) => `- ${markdownCell(warning)}`));
  return `${lines.join('\n')}\n`;
}

/** Persist only the generated draft artifact; callers remain responsible for review/publication. */
export function writeMonthlyEvidenceDraft(
  draft: MonthlyEvidenceDraft,
  paths: { jsonPath: string; markdownPath: string; workingDirectory?: string },
): void {
  const workingDirectory = paths.workingDirectory ?? process.cwd();
  const jsonPath = containedOutputPath(workingDirectory, paths.jsonPath);
  const markdownPath = containedOutputPath(workingDirectory, paths.markdownPath);
  if (jsonPath === markdownPath) throw new Error('JSON and Markdown output paths must differ');
  mkdirSync(dirname(jsonPath), { recursive: true });
  mkdirSync(dirname(markdownPath), { recursive: true });
  const outputs = [
    { path: jsonPath, contents: `${JSON.stringify(draft, null, 2)}\n` },
    { path: markdownPath, contents: renderMonthlyEvidenceMarkdown(draft) },
  ];
  const opened: Array<{ path: string; fd: number; dev: number; ino: number }> = [];
  try {
    for (const output of outputs) {
      const fd = openSync(output.path, 'wx', 0o600);
      const stat = fstatSync(fd);
      opened.push({ path: output.path, fd, dev: stat.dev, ino: stat.ino });
    }
    for (const [index, output] of outputs.entries()) {
      const target = opened[index];
      if (target === undefined) throw new Error('monthly evidence output was not reserved');
      writeFileSync(target.fd, output.contents, 'utf8');
    }
  } catch (error) {
    closeOutputs(opened);
    removeOwnedOutputs(opened);
    throw error;
  }
  closeOutputs(opened);
}

function closeOutputs(outputs: ReadonlyArray<{ fd: number }>): void {
  for (const output of outputs) {
    try {
      closeSync(output.fd);
    } catch {
      // Preserve the original write/open failure when cleanup is best-effort.
    }
  }
}

function removeOwnedOutputs(
  outputs: ReadonlyArray<{ path: string; dev: number; ino: number }>,
): void {
  for (const output of outputs) {
    try {
      const current = lstatSync(output.path);
      if (current.isFile() && current.dev === output.dev && current.ino === output.ino) {
        unlinkSync(output.path);
      }
    } catch {
      // Never remove a replacement path merely to hide a partial draft.
    }
  }
}

export interface MonthlyEvidenceCliOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: Date;
  workingDirectory?: string;
}

function escapesDirectory(base: string, target: string): boolean {
  const pathFromBase = relative(base, target);
  return pathFromBase === '..' || pathFromBase.startsWith(`..${sep}`) || isAbsolute(pathFromBase);
}

function containedOutputPath(workingDirectory: string, candidate: string): string {
  const root = resolve(workingDirectory);
  const output = resolve(root, candidate);
  if (output === root || escapesDirectory(root, output)) {
    throw new Error('output path must stay within the working directory');
  }

  let existingAncestor = dirname(output);
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new Error('output path has no existing ancestor');
    }
    existingAncestor = parent;
  }
  const realRoot = realpathSync(root);
  const realAncestor = realpathSync(existingAncestor);
  if (escapesDirectory(realRoot, realAncestor)) {
    throw new Error('output path must not escape through a symbolic link');
  }
  return output;
}

function requiredCliValue(
  values: Record<string, string | boolean | undefined>,
  name: string,
): string {
  const value = values[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function workflowRunUrlFromEnvironment(env: NodeJS.ProcessEnv): string | null {
  const serverUrl = env.GITHUB_SERVER_URL;
  const repository = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  if (!serverUrl || !repository || !runId || !/^\d+$/u.test(runId)) return null;
  if (serverUrl !== 'https://github.com' || !validRepository(repository)) return null;
  return `${serverUrl}/${repository}/actions/runs/${runId}`;
}

/** CLI entry used by the artifact-only workflow. Credentials are intentionally env-only. */
export async function runMonthlyEvidenceCli(
  options: MonthlyEvidenceCliOptions = {},
): Promise<void> {
  const { values } = parseArgs({
    args: options.argv ?? process.argv.slice(2),
    options: {
      repository: { type: 'string' },
      package: { type: 'string' },
      json: { type: 'string' },
      markdown: { type: 'string' },
    },
    allowPositionals: false,
    strict: true,
  });
  const repository = requiredCliValue(values, 'repository');
  const packageName = requiredCliValue(values, 'package');
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const jsonPath = containedOutputPath(workingDirectory, requiredCliValue(values, 'json'));
  const markdownPath = containedOutputPath(workingDirectory, requiredCliValue(values, 'markdown'));
  if (jsonPath === markdownPath) throw new Error('JSON and Markdown output paths must differ');
  const env = options.env ?? process.env;
  const commitSha = /^[a-f0-9]{40}$/u.test(env.GITHUB_SHA ?? '') ? env.GITHUB_SHA : null;
  const draft = await collectMonthlyEvidence({
    repository,
    packageName,
    githubToken: env.GITHUB_TOKEN ?? '',
    now: options.now,
    commitSha,
    workflowRunUrl: workflowRunUrlFromEnvironment(env),
    fetchImpl: options.fetchImpl,
  });
  writeMonthlyEvidenceDraft(draft, { jsonPath, markdownPath, workingDirectory });
  if (draft.generation.status === 'partial') {
    throw new PartialMonthlyEvidenceError();
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  runMonthlyEvidenceCli().catch((error: unknown) => {
    // Never echo exception text: a transport layer may include credential-bearing headers.
    console.error(
      error instanceof PartialMonthlyEvidenceError
        ? PARTIAL_COLLECTION_MESSAGE
        : 'Monthly evidence draft collection failed.',
    );
    process.exitCode = 1;
  });
}
