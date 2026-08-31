/**
 * Execute scriptspect and a lockfile-pinned scripts-doctor over one owned
 * fixture corpus. This captures observations only; it never decides which
 * tool is more accurate.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../corpus-lib';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

interface FixtureIndex {
  schemaVersion: 1;
  fixtures: Array<{ id: string; question: string }>;
}

interface Toolchain {
  schemaVersion: 1;
  nodeVersion: string;
  scriptsDoctor: {
    package: string;
    version: string;
    integrity: string;
    repository: string;
  };
}

interface ToolObservation {
  command: string[];
  exitCode: number;
  stdoutFile: string;
  stderrFile: string;
  reportFile?: string;
}

interface FixtureObservation {
  id: string;
  question: string;
  fixturePath: string;
  fixtureSha256: string;
  scriptspect: ToolObservation;
  scriptsDoctor: ToolObservation;
}

export interface ComparisonManifest {
  schemaVersion: 1;
  generatedAt: string;
  corpus: { index: string; indexSha256: string };
  tools: {
    scriptspect: { version: string; sourceCommit: string };
    scriptsDoctor: Toolchain['scriptsDoctor'];
  };
  environment: {
    expectedNode: string;
    actualNode: string;
    platform: NodeJS.Platform;
    arch: string;
    matchedPinnedNode: boolean;
    cleanCheckout: boolean;
  };
  fixtures: FixtureObservation[];
  normalization: string[];
  artifactSha256: Record<string, string>;
  promotable: boolean;
  reviewStatus: 'pending-human-adjudication';
  reproduction: string;
}

export interface ComparisonOptions {
  outputDir: string;
  sourceCommit: string;
  enforcePinnedNode?: boolean;
  generatedAt?: string;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function exactCommit(value: string): string {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error('source commit must be an exact SHA');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (value !== head) throw new Error('source commit must equal the checked-out HEAD');
  return value;
}

function sanitized(value: string, outputDir: string, fixturePath: string): string {
  const replacements: Array<[string, string]> = [
    [fixturePath, '$FIXTURE'],
    [outputDir, '$OUTPUT'],
    [root, '$REPOSITORY'],
  ];
  let result = value;
  for (const [source, replacement] of replacements) {
    result = result
      .replaceAll(source, replacement)
      .replaceAll(source.replaceAll('\\', '/'), replacement)
      .replaceAll(source.replaceAll('\\', '\\\\'), replacement);
  }
  return result;
}

function runNode(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 5 * 1024 * 1024,
    env: {
      CI: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
    },
  });
  if (result.error !== undefined) throw result.error;
  if (result.status === null)
    throw new Error(`comparison process ended without a status: ${args[0]}`);
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

function cleanStatus(): boolean {
  return (
    execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() === ''
  );
}

export function runComparison(options: ComparisonOptions): ComparisonManifest {
  const sourceCommit = exactCommit(options.sourceCommit);
  const toolchainPath = resolve(root, 'comparison/toolchain.json');
  const corpusPath = resolve(root, 'tests/fixtures/comparison/corpus.json');
  const toolchain = readJson<Toolchain>(toolchainPath);
  const corpus = readJson<FixtureIndex>(corpusPath);
  if (toolchain.schemaVersion !== 1 || corpus.schemaVersion !== 1) {
    throw new Error('unsupported comparison contract version');
  }
  const actualNode = process.version.slice(1);
  const matchedPinnedNode = actualNode === toolchain.nodeVersion;
  if ((options.enforcePinnedNode ?? true) && !matchedPinnedNode) {
    throw new Error(`comparison requires Node ${toolchain.nodeVersion}`);
  }

  const pkg = readJson<{ version: string; devDependencies?: Record<string, string> }>(
    resolve(root, 'package.json'),
  );
  if (pkg.devDependencies?.[toolchain.scriptsDoctor.package] !== toolchain.scriptsDoctor.version) {
    throw new Error('scripts-doctor package version does not match comparison/toolchain.json');
  }
  const lock = readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8');
  if (!lock.includes(toolchain.scriptsDoctor.integrity)) {
    throw new Error('scripts-doctor integrity is not pinned in pnpm-lock.yaml');
  }

  const outputDir = resolve(options.outputDir);
  mkdirSync(outputDir, { recursive: false });
  const artifactSha256: Record<string, string> = {};
  const writeArtifact = (name: string, content: string): void => {
    writeFileSync(resolve(outputDir, name), content, { encoding: 'utf8', flag: 'wx' });
    artifactSha256[name] = sha256(content);
  };

  const ids = new Set<string>();
  const observations: FixtureObservation[] = [];
  for (const fixture of corpus.fixtures) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fixture.id) || ids.has(fixture.id)) {
      throw new Error(`invalid or duplicate comparison fixture id: ${fixture.id}`);
    }
    ids.add(fixture.id);
    const fixturePath = resolve(root, 'tests/fixtures/comparison', fixture.id);
    const packageFile = resolve(fixturePath, 'package.json');
    if (!existsSync(packageFile) || !statSync(packageFile).isFile()) {
      throw new Error(`comparison fixture ${fixture.id} has no package.json`);
    }
    const packageBytes = readFileSync(packageFile);
    const fixtureDigest = sha256(packageBytes);
    const prefix = fixture.id;

    const scriptspectArgs = [
      resolve(root, 'dist/cli.mjs'),
      fixturePath,
      '--format',
      'json',
      '--no-color',
    ];
    const scriptspect = runNode(scriptspectArgs);
    if (scriptspect.exitCode !== 0 && scriptspect.exitCode !== 1) {
      throw new Error(`scriptspect failed to analyze comparison fixture ${fixture.id}`);
    }
    let scriptspectStdout = sanitized(scriptspect.stdout, outputDir, fixturePath);
    try {
      const report = JSON.parse(scriptspectStdout) as Record<string, unknown>;
      report.root = '$FIXTURE';
      scriptspectStdout = `${JSON.stringify(report, null, 2)}\n`;
    } catch {
      throw new Error(`scriptspect emitted invalid JSON for comparison fixture ${fixture.id}`);
    }
    writeArtifact(`${prefix}.scriptspect.stdout.json`, scriptspectStdout);
    writeArtifact(
      `${prefix}.scriptspect.stderr.txt`,
      sanitized(scriptspect.stderr, outputDir, fixturePath),
    );

    const competitorReport = resolve(outputDir, `${prefix}.scripts-doctor.report.json`);
    const scriptsDoctorArgs = [
      resolve(root, 'node_modules/scripts-doctor/bin/scripts-doctor.js'),
      'lint',
      '--path',
      fixturePath,
      '--report-json',
      competitorReport,
    ];
    const scriptsDoctor = runNode(scriptsDoctorArgs);
    if (scriptsDoctor.exitCode !== 0) {
      throw new Error(`scripts-doctor failed to analyze comparison fixture ${fixture.id}`);
    }
    writeArtifact(
      `${prefix}.scripts-doctor.stdout.txt`,
      sanitized(scriptsDoctor.stdout, outputDir, fixturePath),
    );
    writeArtifact(
      `${prefix}.scripts-doctor.stderr.txt`,
      sanitized(scriptsDoctor.stderr, outputDir, fixturePath),
    );
    let reportFile: string | undefined;
    if (existsSync(competitorReport)) {
      const normalized = sanitized(readFileSync(competitorReport, 'utf8'), outputDir, fixturePath);
      writeFileSync(competitorReport, normalized, 'utf8');
      artifactSha256[basename(competitorReport)] = sha256(normalized);
      reportFile = basename(competitorReport);
    }
    if (sha256(readFileSync(packageFile)) !== fixtureDigest) {
      throw new Error(`comparison tool modified fixture ${fixture.id}`);
    }

    observations.push({
      id: fixture.id,
      question: fixture.question,
      fixturePath: `$REPOSITORY/tests/fixtures/comparison/${fixture.id}`,
      fixtureSha256: fixtureDigest,
      scriptspect: {
        command: [
          '$NODE',
          '$REPOSITORY/dist/cli.mjs',
          `$REPOSITORY/tests/fixtures/comparison/${fixture.id}`,
          '--format',
          'json',
          '--no-color',
        ],
        exitCode: scriptspect.exitCode,
        stdoutFile: `${prefix}.scriptspect.stdout.json`,
        stderrFile: `${prefix}.scriptspect.stderr.txt`,
      },
      scriptsDoctor: {
        command: [
          '$NODE',
          '$REPOSITORY/node_modules/scripts-doctor/bin/scripts-doctor.js',
          'lint',
          '--path',
          `$REPOSITORY/tests/fixtures/comparison/${fixture.id}`,
          '--report-json',
          `$OUTPUT/${prefix}.scripts-doctor.report.json`,
        ],
        exitCode: scriptsDoctor.exitCode,
        stdoutFile: `${prefix}.scripts-doctor.stdout.txt`,
        stderrFile: `${prefix}.scripts-doctor.stderr.txt`,
        ...(reportFile === undefined ? {} : { reportFile }),
      },
    });
  }

  const adjudicationDraft = observations.flatMap((fixture) =>
    (['scriptspect', 'scriptsDoctor'] as const).map((tool) => {
      const observation = fixture[tool];
      return {
        schemaVersion: 1,
        fixtureId: fixture.id,
        fixtureSha256: fixture.fixtureSha256,
        tool,
        observationFiles: [
          observation.stdoutFile,
          observation.stderrFile,
          ...(observation.reportFile === undefined ? [] : [observation.reportFile]),
        ],
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
      };
    }),
  );
  writeArtifact(
    'comparison-adjudication-draft.jsonl',
    `${adjudicationDraft.map((record) => JSON.stringify(record)).join('\n')}\n`,
  );

  const checkoutClean = cleanStatus();
  const manifest: ComparisonManifest = {
    schemaVersion: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    corpus: {
      index: '$REPOSITORY/tests/fixtures/comparison/corpus.json',
      indexSha256: sha256(readFileSync(corpusPath)),
    },
    tools: {
      scriptspect: { version: pkg.version, sourceCommit },
      scriptsDoctor: toolchain.scriptsDoctor,
    },
    environment: {
      expectedNode: toolchain.nodeVersion,
      actualNode,
      platform: process.platform,
      arch: process.arch,
      matchedPinnedNode,
      cleanCheckout: checkoutClean,
    },
    fixtures: observations,
    normalization: [
      'absolute repository, output, and fixture paths are replaced with stable placeholders',
      'scriptspect JSON root is replaced with $FIXTURE',
      'NO_COLOR=1 and FORCE_COLOR=0 are set for both tools',
    ],
    artifactSha256,
    promotable: matchedPinnedNode && checkoutClean,
    reviewStatus: 'pending-human-adjudication',
    reproduction: `SCRIPTSPECT_SOURCE_COMMIT=${sourceCommit} pnpm exec tsx tools/comparison/run.ts comparison-output`,
  };
  writeFileSync(
    resolve(outputDir, 'comparison-run.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    {
      encoding: 'utf8',
      flag: 'wx',
    },
  );
  return manifest;
}

function main(): void {
  const outputDir = process.argv[2];
  if (outputDir === undefined) {
    throw new Error('usage: tsx tools/comparison/run.ts output-directory');
  }
  runComparison({
    outputDir,
    sourceCommit: process.env.SCRIPTSPECT_SOURCE_COMMIT ?? process.env.GITHUB_SHA ?? '',
  });
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  try {
    main();
  } catch (error) {
    console.error(
      `scriptspect comparison: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
