/**
 * CLI entry point (spec §4). Commands: default check, `check [path]`,
 * `explain <ruleId>`. Exit codes: 0 = below failure threshold, 1 = findings
 * above threshold (any configured error, or warnings over --max-warnings),
 * 2 = tool errors (config, I/O, invalid options).
 *
 * `runCli` returns the exit code and writes through the injected sinks so
 * integration tests never need to spawn a process.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import cac from 'cac';
import { ConfigError, loadConfig } from '../config/load';
import type { AnalysisResult } from '../core/analyze';
import { analyze, resolveRoot } from '../core/analyze';
import { version } from '../core/version';
import { renderPatch } from '../fixers/diff';
import { planFixes, rewritesByPackage } from '../fixers/fix-plan';
import type { ScriptRewrite } from '../fixers/package-json';
import { planRewritesForFile } from '../fixers/package-json';
import {
  finalizeWriteTransaction,
  installWriteTransaction,
  prepareWriteTransaction,
  recoverTransaction,
  rollbackWriteTransaction,
  TransactionError,
} from '../fixers/transaction';
import { renderAnnotations, writeJobSummary } from '../reporters/github';
import { renderJson } from '../reporters/json';
import { renderStylish } from '../reporters/stylish';
import { getRule } from '../rules';
import type { Finding } from '../rules/types';
import { renderExplain } from './explain';
import type { CliOptions } from './options';
import { normalizeOptions, SEVERITY_ORDER } from './options';

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

const DEFAULT_IO: CliIo = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
};

function applySeverityFilter(findings: Finding[], min: CliOptions['severity']): Finding[] {
  const threshold = SEVERITY_ORDER[min];
  return findings.filter((f) => SEVERITY_ORDER[f.severity] <= threshold);
}

function exitCodeFor(result: AnalysisResult, options: CliOptions): number {
  const failing = result.findings.some((f) => f.severity === 'error');
  if (failing) return 1;
  if (result.summary.warnings > options.maxWarnings) return 1;
  return 0;
}

async function runCheck(
  pathArg: string | undefined,
  raw: Record<string, unknown>,
  io: CliIo,
): Promise<number> {
  let options: CliOptions;
  try {
    options = normalizeOptions(raw);
    const targetDir = resolve(pathArg ?? process.cwd());
    const root = resolveRoot(targetDir);
    const { config, source } = loadConfig(root, options.configPath);

    // CLI --target overrides config targets.
    const effectiveConfig =
      options.targets !== undefined ? { ...config, targets: options.targets } : config;

    const result = analyze(root, { config: effectiveConfig, onlyRules: options.rules });

    // --fix / --fix-dry-run: plan replacements, write (or just print) them,
    // then re-analyze so the report reflects post-fix reality.
    if (options.fix || options.fixDryRun) {
      const plans = planFixes(result);
      if (options.fixDryRun) {
        for (const plan of plans) {
          io.out(renderPatch(plan.packagePath, plan.scriptName, plan.before, plan.after));
        }
        if (plans.length === 0) io.err('scriptspect: no safe fixes available (nothing to dry-run)');
      } else {
        const rewrites = rewritesByPackage(plans);
        const writes = [];
        const writtenRewrites = new Map<string, ScriptRewrite[]>();
        for (const [packagePath, list] of rewrites) {
          const file = join(root, packagePath);
          const planned = planRewritesForFile(root, file, list);
          if (planned !== null) {
            writes.push({ path: file, ...planned });
            writtenRewrites.set(packagePath, list);
          }
        }
        let transactionPath: string | undefined;
        let rerun: AnalysisResult;
        try {
          if (writes.length > 0) {
            const prepared = prepareWriteTransaction(root, writes);
            transactionPath = prepared.journalPath;
            installWriteTransaction(transactionPath);
          } else {
            io.err('scriptspect: no safe fixes available (nothing changed)');
          }
          rerun = analyze(root, { config: effectiveConfig, onlyRules: options.rules });
          const remainingPlans = planFixes(rerun);
          for (const plan of plans.filter((candidate) =>
            writtenRewrites.has(candidate.packagePath),
          )) {
            const script = rerun.packages.find((unit) => unit.relPath === plan.packagePath)
              ?.manifest.scripts?.[plan.scriptName];
            const appliedRuleIds = new Set(plan.applied.map((applied) => applied.ruleId));
            const unresolved = remainingPlans.some(
              (candidate) =>
                candidate.packagePath === plan.packagePath &&
                candidate.scriptName === plan.scriptName &&
                candidate.applied.some((applied) => appliedRuleIds.has(applied.ruleId)),
            );
            if (script !== plan.after || unresolved) {
              throw new Error(
                `post-fix verification failed for ${plan.packagePath} scripts.${plan.scriptName}`,
              );
            }
          }
          if (transactionPath !== undefined) finalizeWriteTransaction(transactionPath);
          transactionPath = undefined;
        } catch (error) {
          if (transactionPath !== undefined && existsSync(transactionPath)) {
            const rollback = rollbackWriteTransaction(transactionPath);
            if (rollback.state !== 'rollback-success') {
              throw new TransactionError(
                `${error instanceof Error ? error.message : String(error)}\nwrite transaction ended in ${rollback.state}\njournal: ${rollback.journalPath}\n${rollback.backupPaths.map((path) => `backup: ${path}`).join('\n')}`,
                rollback,
              );
            }
          }
          throw error;
        }
        if (writes.length > 0) {
          for (const [packagePath, list] of writtenRewrites) {
            io.err(`scriptspect: fixed ${list.length} script(s) in ${packagePath}`);
          }
        }
        result.findings = rerun.findings;
        result.summary = rerun.summary;
      }
    }

    // Failure is decided after config/ignores and post-fix analysis, but before
    // presentation filtering. Hidden warnings still consume the warning budget.
    const exitCode = exitCodeFor(result, options);
    const visible = applySeverityFilter(result.findings, options.severity);
    // Recount so the summary reflects what was actually reported.
    const finalResult: AnalysisResult = {
      ...result,
      findings: visible,
      summary: {
        ...result.summary,
        errors: visible.filter((f) => f.severity === 'error').length,
        warnings: visible.filter((f) => f.severity === 'warn').length,
        advisories: visible.filter((f) => f.severity === 'advisory').length,
      },
    };

    if (source !== 'defaults' && options.format !== 'json' && !options.quiet) {
      // surface which config file shaped the run (transparency, spec §9)
      io.err(`scriptspect: config from ${source}`);
    }

    switch (options.format) {
      case 'json':
        io.out(renderJson(finalResult, effectiveConfig.targets).trimEnd());
        break;
      case 'github':
        io.out(renderAnnotations(finalResult));
        if (finalResult.findings.length === 0) io.out('');
        writeJobSummary(finalResult);
        break;
      default:
        io.out(renderStylish(finalResult, { color: options.color, quiet: options.quiet }));
    }
    return exitCode;
  } catch (err) {
    if (err instanceof ConfigError || err instanceof Error) {
      io.err(`scriptspect: ${err.message}`);
      return 2;
    }
    throw err;
  }
}

async function runExplain(ruleId: string, io: CliIo): Promise<number> {
  const rule = getRule(ruleId.toUpperCase());
  if (rule === undefined) {
    io.err(`scriptspect: unknown rule "${ruleId}"`);
    return 2;
  }
  io.out(renderExplain(rule));
  return 0;
}

async function runRecover(raw: Record<string, unknown>, io: CliIo): Promise<number> {
  if (typeof raw.transaction !== 'string' || raw.transaction.trim() === '') {
    io.err('scriptspect: recover requires --transaction <journal>');
    return 2;
  }
  if (raw.acknowledgeManual === true && raw.apply !== true) {
    io.err('scriptspect: --acknowledge-manual requires --apply');
    return 2;
  }
  try {
    const result = recoverTransaction(raw.transaction, {
      apply: raw.apply === true,
      acknowledgeManual: raw.acknowledgeManual === true,
    });
    for (const action of result.actions) io.out(action);
    if (result.state !== 'success') {
      io.err(`scriptspect: recovery state ${result.state}`);
      io.err(`scriptspect: journal ${result.journalPath}`);
      for (const backup of result.backupPaths) io.err(`scriptspect: backup ${backup}`);
      return 2;
    }
    return 0;
  } catch (error) {
    io.err(`scriptspect: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

export async function runCli(argv: string[], io: CliIo = DEFAULT_IO): Promise<number> {
  const cli = cac('scriptspect');
  cli.help();
  cli.version(version);
  cli.option('--format <kind>', 'output format: stylish | json | github');
  cli.option('--target <list>', 'target shells, e.g. posix-sh,cmd,powershell');
  cli.option('--severity <level>', 'minimum severity to display: error | warn | advisory');
  cli.option('--rule <ids>', 'run only these rules, e.g. PS001,PS010');
  cli.option('--quiet', 'compact output: findings and summary only');
  cli.option('--no-color', 'disable ANSI colors');
  cli.option('--max-warnings <n>', 'exit 1 when warnings exceed this number');
  cli.option('--config <path>', 'explicit config file path');
  cli.option('--fix', 'apply safe fixes (never installs dependencies or touches lockfiles)');
  cli.option('--fix-dry-run', 'print the fixes --fix would apply, without writing');

  const checkAction = (path: string | undefined, raw: Record<string, unknown>): Promise<number> =>
    runCheck(path, raw, io);

  let outcome: Promise<number> | undefined;

  cli
    .command('[path]', 'analyze package.json scripts for cross-platform portability')
    .action((path: string | undefined, raw) => {
      outcome = checkAction(path, raw);
      return outcome;
    });

  const check = cli.command('check [path]', 'analyze (explicit form of the default command)');
  check.action((path: string | undefined, raw) => {
    outcome = checkAction(path, raw);
    return outcome;
  });

  cli.command('explain <ruleId>', 'show rule documentation offline').action((ruleId: string) => {
    outcome = runExplain(ruleId, io);
    return outcome;
  });

  const recover = cli.command('recover', 'preview or complete a recorded fixer rollback');
  recover.option('--transaction <journal>', 'transaction journal to recover');
  recover.option('--apply', 'apply the previewed rollback');
  recover.option(
    '--acknowledge-manual',
    'archive a manual-recovery journal after maintainer acknowledgement',
  );
  recover.action((raw) => {
    outcome = runRecover(raw, io);
    return outcome;
  });

  try {
    cli.parse(['node', 'scriptspect.mjs', ...argv], { run: true });
  } catch (err) {
    io.err(`scriptspect: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  if (outcome === undefined) {
    // cac printed help/version; nothing to run
    return 0;
  }
  return outcome;
}
