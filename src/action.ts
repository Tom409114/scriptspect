import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ActionInputError, isWithinWorkspace, parseActionInputs } from './action-inputs';
import type { ActionIo } from './action-output';
import { ACTION_OUTPUT_NAMES, createActionIo } from './action-output';
import { loadConfig } from './config/load';
import type { AnalysisResult } from './core/analyze';
import { analyze, resolveRoot, summarize } from './core/analyze';
import { renderAnnotations, renderSummary } from './reporters/github';
import type { Finding } from './rules/types';

export interface ActionRunResult {
  exitCode: 0 | 1 | 2;
}

export function isMainModule(importMetaUrl: string, entry = process.argv[1]): boolean {
  if (entry === undefined) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return pathToFileURL(resolve(entry)).href === importMetaUrl;
  }
}

const HIDDEN_WARNING_SUMMARY_NOTE = '> Hidden warnings still count toward the failure budget.';

function visibleFindings(findings: Finding[], severity: 'error' | 'warn' | 'advisory'): Finding[] {
  const rank = { error: 0, warn: 1, advisory: 2 } as const;
  return findings.filter((finding) => rank[finding.severity] <= rank[severity]);
}

function emptyResult(root: string): AnalysisResult {
  return {
    root,
    packages: [],
    findings: [],
    summary: { packagesScanned: 0, scriptsScanned: 0, errors: 0, warnings: 0, advisories: 0 },
  };
}

function exitCodeFor(result: AnalysisResult, maxWarnings: number): 0 | 1 {
  if (result.findings.some((finding) => finding.severity === 'error')) return 1;
  return result.summary.warnings > maxWarnings ? 1 : 0;
}

function writeOutputs(io: ActionIo, result: AnalysisResult, exitCode: 0 | 1 | 2): void {
  const values: Record<(typeof ACTION_OUTPUT_NAMES)[number], number> = {
    'exit-code': exitCode,
    packages: result.summary.packagesScanned,
    scripts: result.summary.scriptsScanned,
    errors: result.summary.errors,
    warnings: result.summary.warnings,
    advisories: result.summary.advisories,
  };
  for (const name of ACTION_OUTPUT_NAMES) io.output(name, values[name]);
}

/**
 * Run the Action directly against the checked-out repository. This has no
 * shell interpolation, child processes, dependency installation, or network
 * access; it invokes the same analyzer, config loader, and reporters as CLI.
 */
export function runAction(
  env: NodeJS.ProcessEnv = process.env,
  providedIo?: ActionIo,
): ActionRunResult {
  const io = providedIo ?? createActionIo(env);
  let result = emptyResult(env.GITHUB_WORKSPACE ?? process.cwd());
  let exitCode: 0 | 1 | 2 = 2;
  let summaryNote = '';

  try {
    const inputs = parseActionInputs(env);
    const root = resolveRoot(inputs.path, inputs.workspace);
    if (!isWithinWorkspace(inputs.workspace, root))
      throw new ActionInputError('path must be within workspace');

    const { config } = loadConfig(root);
    const effectiveConfig =
      inputs.targets === undefined ? config : { ...config, targets: inputs.targets };
    const analyzed = analyze(root, { config: effectiveConfig });
    exitCode = exitCodeFor(analyzed, inputs.maxWarnings);
    const findings = visibleFindings(analyzed.findings, inputs.severity ?? 'advisory');
    result = {
      ...analyzed,
      findings,
      summary: summarize(
        findings,
        analyzed.summary.scriptsScanned,
        analyzed.summary.packagesScanned,
      ),
    };
    if (
      analyzed.summary.warnings > inputs.maxWarnings &&
      result.summary.warnings <= inputs.maxWarnings
    ) {
      summaryNote = HIDDEN_WARNING_SUMMARY_NOTE;
    }
    const annotations = renderAnnotations(result);
    if (annotations !== '') io.annotation(annotations);
  } catch {
    // Never include an attacker-controlled input or arbitrary environment data.
    exitCode = 2;
  }

  io.summary([renderSummary(result), summaryNote].filter((part) => part !== '').join('\n\n'));
  try {
    writeOutputs(io, result, exitCode);
  } catch {
    // GITHUB_OUTPUT is part of the Action contract, not a best-effort diagnostic.
    exitCode = 2;
  }
  if (exitCode !== 0) io.fail();
  return { exitCode };
}

if (isMainModule(import.meta.url)) {
  runAction();
}
