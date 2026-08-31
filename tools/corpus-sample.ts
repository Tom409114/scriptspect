/** Build a deterministic, source-free human-adjudication draft. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type SampleFinding, stratifiedSample } from './corpus-lib';

interface FindingRecord extends SampleFinding {
  repository: string;
  commit: string;
  url: string;
  packagePath: string;
  scriptName: string;
}

interface AdjudicationDraft {
  schemaVersion: 1;
  findingId: string;
  repository: string;
  commit: string;
  packagePath: string;
  scriptName: string;
  ruleId: string;
  severity: SampleFinding['severity'];
  confidence: SampleFinding['confidence'];
  evidenceUrl: string;
  outcome: 'pending';
  rationale: null;
  reviewer: null;
  reviewedAt: null;
  secondaryReview: {
    outcome: null;
    rationale: null;
    reviewer: null;
    reviewedAt: null;
  };
}

function parseFinding(value: unknown, line: number): FindingRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`findings line ${line} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if ('source' in record || 'script' in record) {
    throw new Error(`findings line ${line} contains forbidden raw source`);
  }
  const findingId = record.findingId;
  const repository = record.repository;
  const commit = record.commit;
  const url = record.url;
  const packagePath = record.packagePath;
  const scriptName = record.scriptName;
  const ruleId = record.ruleId;
  const severity = record.severity;
  const confidence = record.confidence;
  if (typeof findingId !== 'string' || !/^[a-f0-9]{64}$/.test(findingId)) {
    throw new Error(`findings line ${line} has an invalid findingId`);
  }
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`findings line ${line} has an invalid repository`);
  }
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error(`findings line ${line} has an invalid commit`);
  }
  if (
    typeof url !== 'string' ||
    !url.startsWith(`https://github.com/${repository}/blob/${commit}/`)
  ) {
    throw new Error(`findings line ${line} has a mutable or mismatched evidence URL`);
  }
  if (typeof packagePath !== 'string' || packagePath === '') {
    throw new Error(`findings line ${line} has an invalid packagePath`);
  }
  if (typeof scriptName !== 'string') throw new Error(`findings line ${line} has no scriptName`);
  if (typeof ruleId !== 'string' || !/^PS[0-9]{3}$/.test(ruleId)) {
    throw new Error(`findings line ${line} has an invalid ruleId`);
  }
  if (severity !== 'error' && severity !== 'warn' && severity !== 'advisory') {
    throw new Error(`findings line ${line} has an invalid severity`);
  }
  if (confidence !== 'high' && confidence !== 'medium') {
    throw new Error(`findings line ${line} has an invalid confidence`);
  }
  return {
    findingId,
    repository,
    commit,
    url,
    packagePath,
    scriptName,
    ruleId,
    severity,
    confidence,
  };
}

export function createAdjudicationDraft(
  findingsFile: string,
  outputFile: string,
  size: number,
  seed: string,
): void {
  if (seed === '') throw new Error('sample seed must not be empty');
  const records = readFileSync(findingsFile, 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line !== '')
    .map((line, index) => {
      try {
        return parseFinding(JSON.parse(line) as unknown, index + 1);
      } catch (error) {
        if (error instanceof SyntaxError)
          throw new Error(`findings line ${index + 1} is invalid JSON`);
        throw error;
      }
    });
  const drafts: AdjudicationDraft[] = stratifiedSample(records, size, seed).map((finding) => ({
    schemaVersion: 1,
    findingId: finding.findingId,
    repository: finding.repository,
    commit: finding.commit,
    packagePath: finding.packagePath,
    scriptName: finding.scriptName,
    ruleId: finding.ruleId,
    severity: finding.severity,
    confidence: finding.confidence,
    evidenceUrl: finding.url,
    outcome: 'pending',
    rationale: null,
    reviewer: null,
    reviewedAt: null,
    secondaryReview: {
      outcome: null,
      rationale: null,
      reviewer: null,
      reviewedAt: null,
    },
  }));
  writeFileSync(outputFile, `${drafts.map((draft) => JSON.stringify(draft)).join('\n')}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
}

function positiveInteger(value: string | undefined): number {
  const parsed = Number(value ?? '100');
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('sample size must be positive');
  return parsed;
}

function main(): void {
  const findingsFile = process.argv[2];
  const outputFile = process.argv[3];
  if (findingsFile === undefined || outputFile === undefined) {
    throw new Error(
      'usage: tsx tools/corpus-sample.ts findings.jsonl adjudication-draft.jsonl [size] [seed]',
    );
  }
  createAdjudicationDraft(
    findingsFile,
    outputFile,
    positiveInteger(process.argv[4]),
    process.argv[5] ?? process.env.GITHUB_SHA ?? '',
  );
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  try {
    main();
  } catch (error) {
    console.error(
      `scriptspect corpus sample: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
