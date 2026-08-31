/**
 * Conservative fix builders for POSIX command rules (spec §7.1).
 *
 * Merely having rimraf/shx in package.json is not enough to prove a rewrite:
 * the source invocation must also fit the replacement CLI's documented
 * option, arity, quoting, and semantic subset. ShellJS accepts at most one
 * leading short-option string, and each command supports a different set.
 * Unsupported or ambiguous forms remain manual and never carry a replacement.
 *
 * Contracts:
 * - https://github.com/isaacs/rimraf#command-line-interface
 * - https://github.com/shelljs/shx#command-reference
 * - https://github.com/shelljs/shelljs#command-reference
 */
import type { CommandNode } from '../parser/ir';
import type { Token } from '../parser/lexer';
import type { FixCandidate, RuleContext } from './types';

interface ParsedShxArgs {
  flags: string[];
  /** Positional arguments after removing a context-option value. */
  positionals: Token[];
  usedOptionTerminator: boolean;
}

interface ShxCommandContract {
  command: string;
  allowedFlags: ReadonlySet<string>;
  minPositionals: number;
  valueFlags?: ReadonlySet<string>;
  incompatibleFlagPairs?: ReadonlyArray<readonly [string, string]>;
  validate?: (args: ParsedShxArgs) => string | null;
}

const CONTEXT_FLAGS = new Set(['A', 'B', 'C']);
const REGEX_META = /[\\^$.*+?()[\]{}|]/;
const SED_REPLACEMENT_META = /[\\$&]/;
const GLOB_META = /[*?[\]{}]/;
const CMD_ENV_REFERENCE = /%[A-Za-z_][A-Za-z0-9_]*%/;

const SHX_CONTRACTS: Readonly<Record<string, ShxCommandContract>> = {
  PS011: {
    command: 'cp',
    allowedFlags: new Set(['f', 'n', 'u', 'r', 'R', 'L', 'P', 'p']),
    minPositionals: 2,
    incompatibleFlagPairs: [
      ['f', 'n'],
      ['L', 'P'],
    ],
  },
  PS012: {
    command: 'mv',
    allowedFlags: new Set(['f', 'n']),
    minPositionals: 2,
    incompatibleFlagPairs: [['f', 'n']],
  },
  PS013: {
    command: 'mkdir',
    allowedFlags: new Set(['p']),
    minPositionals: 1,
  },
  PS017: {
    command: 'grep',
    allowedFlags: new Set(['v', 'l', 'i', 'n', 'B', 'A', 'C']),
    valueFlags: CONTEXT_FLAGS,
    minPositionals: 1,
    validate: validateLiteralGrep,
  },
  PS018: {
    command: 'sed',
    allowedFlags: new Set(['i']),
    minPositionals: 1,
    validate: validateLiteralSed,
  },
  PS019: {
    command: 'cat',
    allowedFlags: new Set(['n']),
    minPositionals: 1,
  },
};

const SHX_RM_CONTRACT: ShxCommandContract = {
  command: 'rm',
  allowedFlags: new Set(['f', 'r', 'R']),
  minPositionals: 1,
};

function manual(ruleId: string, reason: string): FixCandidate {
  return {
    ruleId,
    safety: 'manual',
    description: `manual rewrite required: ${reason}`,
  };
}

function conditional(ruleId: string, dependency: 'rimraf' | 'shx'): FixCandidate {
  return {
    ruleId,
    safety: 'conditional',
    description: `add ${dependency} as a devDependency, then re-run --fix`,
    requiresDependency: dependency,
  };
}

function safePrefix(ruleId: string, first: Token): FixCandidate {
  return {
    ruleId,
    safety: 'safe',
    description: 'prefix with shx (already a dependency)',
    replacement: { span: [first.span[0], first.span[0]], text: 'shx ' },
  };
}

/**
 * ShellJS's wrapper parses only argv[1] as an option string. Long options,
 * multiple option tokens, unknown flags, and missing option values therefore
 * cannot be preserved by simply inserting `shx `.
 */
function parseShxArgs(cmd: CommandNode, contract: ShxCommandContract): ParsedShxArgs | string {
  const args = cmd.argv.slice(1);
  let positionals = args;
  let flags: string[] = [];
  let usedOptionTerminator = false;

  const firstArg = args[0];
  if (firstArg?.value === '--') {
    usedOptionTerminator = true;
    positionals = args.slice(1);
  } else if (firstArg?.value.startsWith('-')) {
    if (!/^-[A-Za-z]+$/.test(firstArg.value)) {
      return `option ${JSON.stringify(firstArg.raw)} is outside the ShellJS ${contract.command} contract`;
    }
    flags = firstArg.value.slice(1).split('');
    const unknown = flags.find((flag) => !contract.allowedFlags.has(flag));
    if (unknown !== undefined) {
      return `option -${unknown} is not supported by ShellJS ${contract.command}`;
    }
    positionals = args.slice(1);
  }

  if (!usedOptionTerminator && positionals.some((token) => token.value.startsWith('-'))) {
    return 'ShellJS accepts only one leading short-option string; use -- for dash-prefixed paths';
  }

  for (const [left, right] of contract.incompatibleFlagPairs ?? []) {
    if (flags.includes(left) && flags.includes(right)) {
      return `combined -${left}/-${right} semantics are not provably equivalent`;
    }
  }

  const valueFlags = flags.filter((flag) => contract.valueFlags?.has(flag) === true);
  if (valueFlags.length > 1) {
    return 'multiple context flags require distinct values that shx cannot infer from one option string';
  }
  if (valueFlags.length === 1) {
    const value = positionals[0];
    if (value === undefined || !/^\d+$/.test(value.value)) {
      return `-${valueFlags[0]} requires a non-negative integer argument`;
    }
    positionals = positionals.slice(1);
  }

  if (positionals.length < contract.minPositionals) {
    return `${contract.command} requires at least ${contract.minPositionals} positional argument(s)`;
  }

  if (cmd.argv.slice(1).some(hasUnportableArgumentSyntax)) {
    return 'single-quoted or runtime-expanded arguments are not equivalent across npm script shells';
  }

  const parsed = { flags, positionals, usedOptionTerminator };
  return contract.validate?.(parsed) ?? parsed;
}

function hasUnportableArgumentSyntax(token: Token): boolean {
  return (
    token.raw.includes("'") ||
    token.expansions.length > 0 ||
    token.raw.includes('$') ||
    CMD_ENV_REFERENCE.test(token.raw)
  );
}

/** ShellJS grep uses JavaScript RegExp, so auto-fix only literal patterns. */
function validateLiteralGrep(args: ParsedShxArgs): string | null {
  const pattern = args.positionals[0]?.value ?? '';
  if (pattern === '' || REGEX_META.test(pattern)) {
    return 'grep pattern is outside the literal subset shared by POSIX grep and JavaScript RegExp';
  }
  return null;
}

/** shx accepts only s/search/replacement/[g], with JavaScript RegExp semantics. */
function validateLiteralSed(args: ParsedShxArgs): string | null {
  const expression = args.positionals[0]?.value ?? '';
  const match = /^s\/([^/]*)\/([^/]*)\/(g?)$/.exec(expression);
  if (match === null) {
    return 'sed expression is outside the shx s/search/replacement/[g] grammar';
  }
  const search = match[1] ?? '';
  const replacement = match[2] ?? '';
  if (search === '' || REGEX_META.test(search) || SED_REPLACEMENT_META.test(replacement)) {
    return 'sed expression is outside the provably equivalent literal substitution subset';
  }
  return null;
}

function unsafeRemovalTarget(token: Token): boolean {
  if (hasUnportableArgumentSyntax(token)) return true;

  const slashNormalized = token.value.replace(/\\/g, '/');
  const normalized = slashNormalized.replace(/\/+$/, '');
  if (normalized === '' || normalized === '.' || normalized === '..') return true;
  if (normalized.startsWith('~')) return true;
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(slashNormalized)) return true;

  const segments = normalized.replace(/^\.\//, '').split('/');
  if (segments.includes('..')) return true;
  const stablePrefix = segments[0] ?? '';
  return stablePrefix === '' || GLOB_META.test(stablePrefix);
}

function rimrafEquivalent(args: ParsedShxArgs): boolean {
  if (args.usedOptionTerminator) return false;
  const recursive = args.flags.includes('r') || args.flags.includes('R');
  const force = args.flags.includes('f');
  if (!recursive || !force) return false;
  // rimraf's CLI does not have stable cross-version glob defaults.
  return args.positionals.every((token) => !GLOB_META.test(token.value));
}

/** `rm -rf <safe-relative-path>` → `rimraf <safe-relative-path>`. */
export function rimrafFix(cmd: CommandNode, ctx: RuleContext): FixCandidate {
  const first = cmd.argv[0];
  if (first === undefined) {
    return manual('PS010', 'missing rm command token');
  }

  const parsed = parseShxArgs(cmd, SHX_RM_CONTRACT);
  if (typeof parsed === 'string') return manual('PS010', parsed);
  if (parsed.positionals.some(unsafeRemovalTarget)) {
    return manual(
      'PS010',
      'destructive target is absolute, parent-traversing, broad, or runtime-dependent',
    );
  }

  if (rimrafEquivalent(parsed)) {
    if (ctx.dependencies.has('rimraf')) {
      const firstTarget = parsed.positionals[0];
      if (firstTarget === undefined) return manual('PS010', 'missing removal target');
      return {
        ruleId: 'PS010',
        safety: 'safe',
        description: 'rewrite as `rimraf …` (rimraf is already a dependency)',
        replacement: { span: [first.span[0], firstTarget.span[0]], text: 'rimraf ' },
      };
    }
    if (ctx.dependencies.has('shx')) return safePrefix('PS010', first);
    return conditional('PS010', 'rimraf');
  }

  if (ctx.dependencies.has('shx')) return safePrefix('PS010', first);
  return conditional('PS010', 'shx');
}

/** Prefix a command only after its exact ShellJS/shx subset is verified. */
export function shxPrefixFix(ruleId: string, cmd: CommandNode, ctx: RuleContext): FixCandidate {
  const first = cmd.argv[0];
  if (first === undefined) return manual(ruleId, 'missing command token');

  const contract = SHX_CONTRACTS[ruleId];
  if (contract === undefined || first.value.toLowerCase() !== contract.command) {
    return manual(ruleId, 'no declared ShellJS contract for this command');
  }

  const parsed = parseShxArgs(cmd, contract);
  if (typeof parsed === 'string') return manual(ruleId, parsed);
  if (ctx.dependencies.has('shx')) return safePrefix(ruleId, first);
  return conditional(ruleId, 'shx');
}
