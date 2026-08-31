/** Reproducible hosted-runner guardrail for 100-package workspace analysis. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../src/config/load';
import { analyze } from '../src/core/analyze';

export interface WorkspaceBenchmarkOptions {
  packageCount: number;
  thresholdMs: number;
  sourceCommit: string;
}

export interface WorkspaceBenchmarkResult {
  schemaVersion: 1;
  sourceCommit: string;
  packageCountRequested: number;
  packagesScanned: number;
  scriptsScanned: number;
  findings: number;
  elapsedMs: number;
  thresholdMs: number;
  passed: boolean;
  environment: { node: string; platform: NodeJS.Platform; arch: string; runnerOs?: string };
}

function validateOptions(options: WorkspaceBenchmarkOptions): void {
  if (
    !Number.isSafeInteger(options.packageCount) ||
    options.packageCount < 1 ||
    options.packageCount > 1_000
  ) {
    throw new Error('package count must be an integer from 1 through 1000');
  }
  if (!Number.isFinite(options.thresholdMs) || options.thresholdMs <= 0) {
    throw new Error('threshold must be a positive number of milliseconds');
  }
  if (!/^[a-f0-9]{40}$/.test(options.sourceCommit)) {
    throw new Error('source commit must be an exact 40-character SHA');
  }
}

export function runWorkspaceBenchmark(
  options: WorkspaceBenchmarkOptions,
): WorkspaceBenchmarkResult {
  validateOptions(options);
  const root = mkdtempSync(join(tmpdir(), 'scriptspect-workspace-benchmark-'));
  try {
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify({
        name: 'benchmark-root',
        private: true,
        workspaces: ['packages/*'],
        scripts: { build: 'node build.js' },
      })}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    for (let index = 0; index < options.packageCount; index += 1) {
      const directory = join(root, 'packages', `package-${index.toString().padStart(4, '0')}`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'package.json'),
        `${JSON.stringify({
          name: `@scriptspect-benchmark/package-${index}`,
          scripts: { build: 'vite build', test: 'node test.js' },
          devDependencies: { vite: '0.0.0' },
        })}\n`,
        { encoding: 'utf8', flag: 'wx' },
      );
    }

    const startedAt = performance.now();
    const analysis = analyze(root, { config: parseConfig({}, 'benchmark') });
    const elapsedMs = Math.round((performance.now() - startedAt) * 1_000) / 1_000;
    return {
      schemaVersion: 1,
      sourceCommit: options.sourceCommit,
      packageCountRequested: options.packageCount,
      packagesScanned: analysis.summary.packagesScanned,
      scriptsScanned: analysis.summary.scriptsScanned,
      findings: analysis.findings.length,
      elapsedMs,
      thresholdMs: options.thresholdMs,
      passed: elapsedMs < options.thresholdMs,
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        ...(process.env.RUNNER_OS === undefined ? {} : { runnerOs: process.env.RUNNER_OS }),
      },
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function positiveNumber(value: string | undefined, fallback: number, label: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be positive`);
  return parsed;
}

function main(): void {
  const outputFile = process.argv[2];
  if (outputFile === undefined) {
    throw new Error(
      'usage: tsx tools/benchmark-workspace.ts output.json [package-count] [threshold-ms]',
    );
  }
  const result = runWorkspaceBenchmark({
    packageCount: positiveNumber(process.argv[3], 100, 'package count'),
    thresholdMs: positiveNumber(process.argv[4], 2_000, 'threshold'),
    sourceCommit: process.env.SCRIPTSPECT_SOURCE_COMMIT ?? process.env.GITHUB_SHA ?? '',
  });
  writeFileSync(outputFile, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  if (!result.passed) process.exitCode = 1;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  try {
    main();
  } catch (error) {
    console.error(
      `scriptspect workspace benchmark: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
