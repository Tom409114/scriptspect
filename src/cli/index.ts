/**
 * CLI entry point (spec §4). Commands: default check, `check [path]`,
 * `explain <ruleId>`. Exit codes: 0 = below failure threshold, 1 = findings
 * above threshold (high-confidence errors, or warnings over --max-warnings),
 * 2 = tool errors (config, I/O, invalid options).
 *
 * `runCli` returns the exit code and writes through the injected sinks so
 * integration tests never need to spawn a process.
 */
import { resolve } from 'node:path';
import cac from 'cac';
import { version } from '../core/version';
import { analyze, resolveRoot } from '../core/analyze';
import type { AnalysisResult } from '../core/analyze';
import { loadConfig, ConfigError } from '../config/load';
import { normalizeOptions, SEVERITY_ORDER } from './options';
import type { CliOptions } from './options';
import { renderStylish } from '../reporters/stylish';
import { renderJson } from '../reporters/json';
import { renderAnnotations, writeJobSummary } from '../reporters/github';
import { renderExplain } from './explain';
import { getRule } from '../rules';
import type { Finding } from '../rules/types';

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
  const failing = result.findings.some((f) => f.severity === 'error' && f.confidence === 'high');
  if (failing) return 1;
  if (result.summary.warnings > options.maxWarnings) return 1;
  return 0;
}

interface CheckArgs {
  path?: string;
}

async function runCheck(pathArg: string | undefined, raw: Record<string, unknown>, io: CliIo): Promise<number> {
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
    return exitCodeFor(finalResult, options);
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

  const checkAction = (args: CheckArgs, raw: Record<string, unknown>): Promise<number> =>
    runCheck(args.path, raw, io);

  let outcome: Promise<number> | undefined;

  cli.command('[path]', 'analyze package.json scripts for cross-platform portability').action(
    (args: CheckArgs, raw) => {
      outcome = checkAction(args, raw);
      return outcome;
    },
  );

  const check = cli.command('check [path]', 'analyze (explicit form of the default command)');
  check.action((args: CheckArgs, raw) => {
    outcome = checkAction(args, raw);
    return outcome;
  });

  cli.command('explain <ruleId>', 'show rule documentation offline').action((args: { ruleId: string }) => {
    outcome = runExplain(args.ruleId, io);
    return outcome;
  });

  try {
    cli.parse(argv, { run: true });
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
