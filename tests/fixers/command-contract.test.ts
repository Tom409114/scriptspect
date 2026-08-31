import { describe, expect, it } from 'vitest';
import { DEFAULT_TARGETS } from '../../src/core/targets';
import { applicableFixes, applyToScript } from '../../src/fixers/apply';
import { analyzeScript } from '../../src/rules';
import type { Finding, RuleContext } from '../../src/rules/types';

const AUTOMATIC_COMMAND_RULES = [
  'PS010',
  'PS011',
  'PS012',
  'PS013',
  'PS017',
  'PS018',
  'PS019',
] as const;

type AutomaticCommandRule = (typeof AUTOMATIC_COMMAND_RULES)[number];

interface CommandContractCase {
  ruleId: AutomaticCommandRule;
  dependency: 'rimraf' | 'shx';
  supported: { before: string; after: string };
  unsupportedOption: string;
  semanticBoundary: string;
}

/**
 * One complete contract row per automatic POSIX-command fixer. Requiring every
 * field here makes the coverage-count test a guard against shipping a new
 * automatic command rewrite without supported, missing-dependency,
 * unsupported-option, semantic-boundary, and idempotency evidence.
 */
const COMMAND_CONTRACTS: readonly CommandContractCase[] = [
  {
    ruleId: 'PS010',
    dependency: 'rimraf',
    supported: { before: 'rm -rf dist', after: 'rimraf dist' },
    unsupportedOption: 'rm --no-preserve-root -rf /',
    semanticBoundary: 'rm -rf ../shared',
  },
  {
    ruleId: 'PS011',
    dependency: 'shx',
    supported: { before: 'cp -r src dist', after: 'shx cp -r src dist' },
    unsupportedOption: 'cp -a src dist',
    semanticBoundary: 'cp -r -p src dist',
  },
  {
    ruleId: 'PS012',
    dependency: 'shx',
    supported: { before: 'mv -n old.txt new.txt', after: 'shx mv -n old.txt new.txt' },
    unsupportedOption: 'mv -T old.txt new.txt',
    semanticBoundary: 'mv only-source.txt',
  },
  {
    ruleId: 'PS013',
    dependency: 'shx',
    supported: { before: 'mkdir -p dist/assets', after: 'shx mkdir -p dist/assets' },
    unsupportedOption: 'mkdir --parents dist/assets',
    semanticBoundary: 'mkdir -p',
  },
  {
    ruleId: 'PS017',
    dependency: 'shx',
    supported: {
      before: 'grep -in TODO src/app.ts',
      after: 'shx grep -in TODO src/app.ts',
    },
    unsupportedOption: 'grep -r TODO src',
    semanticBoundary: 'grep "[[:digit:]]" data.txt',
  },
  {
    ruleId: 'PS018',
    dependency: 'shx',
    supported: { before: 'sed "s/a/b/g" x.txt', after: 'shx sed "s/a/b/g" x.txt' },
    unsupportedOption: 'sed -n "s/a/b/" x.txt',
    semanticBoundary: "sed 's/a/b/' x.txt",
  },
  {
    ruleId: 'PS019',
    dependency: 'shx',
    supported: { before: 'cat -n a.txt', after: 'shx cat -n a.txt' },
    unsupportedOption: 'cat -A a.txt',
    semanticBoundary: "cat 'a b.txt'",
  },
];

function run(script: string, deps: string[] = []): Finding[] {
  const ctx: RuleContext = {
    script,
    scriptName: 'test',
    packagePath: 'package.json',
    targets: DEFAULT_TARGETS,
    dependencies: new Set(deps),
    workspaceBins: new Set(),
  };
  return analyzeScript(script, ctx);
}

function finding(script: string, ruleId: AutomaticCommandRule, deps: string[] = []): Finding {
  const match = run(script, deps).find((candidate) => candidate.ruleId === ruleId);
  expect(match, `expected ${ruleId} for ${JSON.stringify(script)}`).toBeDefined();
  return match as Finding;
}

function fixed(script: string, deps: string[] = []): string {
  return applyToScript(script, run(script, deps)).script;
}

describe('automatic command fixer contract coverage', () => {
  it('has exactly one complete contract row for every automatic command rule', () => {
    expect(COMMAND_CONTRACTS).toHaveLength(AUTOMATIC_COMMAND_RULES.length);
    expect(new Set(COMMAND_CONTRACTS.map(({ ruleId }) => ruleId))).toEqual(
      new Set(AUTOMATIC_COMMAND_RULES),
    );
  });

  for (const contract of COMMAND_CONTRACTS) {
    describe(contract.ruleId, () => {
      it('applies its documented supported subset and is idempotent', () => {
        const { before, after } = contract.supported;
        const candidate = finding(before, contract.ruleId, [contract.dependency]);
        expect(candidate.fix).toMatchObject({ safety: 'safe' });
        expect(candidate.fix?.replacement).toBeDefined();

        const once = fixed(before, [contract.dependency]);
        expect(once).toBe(after);
        expect(fixed(once, [contract.dependency])).toBe(once);
      });

      it('is a conditional no-op when the supported tool is missing', () => {
        const candidate = finding(contract.supported.before, contract.ruleId);
        expect(candidate.fix).toMatchObject({
          safety: 'conditional',
          requiresDependency: contract.dependency,
        });
        expect(candidate.fix?.replacement).toBeUndefined();
        expect(fixed(contract.supported.before)).toBe(contract.supported.before);
      });

      it('refuses an option outside the replacement tool contract', () => {
        const candidate = finding(contract.unsupportedOption, contract.ruleId, ['rimraf', 'shx']);
        expect(candidate.fix).toMatchObject({ safety: 'manual' });
        expect(candidate.fix?.replacement).toBeUndefined();
        expect(fixed(contract.unsupportedOption, ['rimraf', 'shx'])).toBe(
          contract.unsupportedOption,
        );
      });

      it('refuses a syntactically supported form whose semantics are not provable', () => {
        const candidate = finding(contract.semanticBoundary, contract.ruleId, ['rimraf', 'shx']);
        expect(candidate.fix).toMatchObject({ safety: 'manual' });
        expect(candidate.fix?.replacement).toBeUndefined();
        expect(fixed(contract.semanticBoundary, ['rimraf', 'shx'])).toBe(contract.semanticBoundary);
      });
    });
  }
});

describe('rm replacement boundaries', () => {
  it('uses shx for supported rm forms that are not rimraf-equivalent', () => {
    expect(fixed('rm -r build', ['shx'])).toBe('shx rm -r build');
    expect(fixed('rm temp.log', ['shx'])).toBe('shx rm temp.log');

    const withOnlyRimraf = finding('rm -r build', 'PS010', ['rimraf']);
    expect(withOnlyRimraf.fix).toMatchObject({
      safety: 'conditional',
      requiresDependency: 'shx',
    });
    expect(withOnlyRimraf.fix?.replacement).toBeUndefined();
  });

  it('falls back to shx for rm -rf when rimraf is absent', () => {
    expect(fixed('rm -rf dist', ['shx'])).toBe('shx rm -rf dist');
  });

  it.each([
    'rm -rf .',
    'rm -rf *',
    'rm -rf C:\\',
    'rm -rf C:temp',
    'rm -rf $HOME/cache',
    'rm -rf ~other/cache',
  ])('keeps dangerous or runtime-dependent target manual: %s', (script) => {
    const candidate = finding(script, 'PS010', ['rimraf', 'shx']);
    expect(candidate.fix).toMatchObject({ safety: 'manual' });
    expect(candidate.fix?.replacement).toBeUndefined();
    expect(applicableFixes([candidate])).toHaveLength(0);
  });
});

describe('documented ShellJS subset boundaries', () => {
  it('accepts grep context options with their required numeric operand', () => {
    expect(fixed('grep -A 2 TODO app.txt', ['shx'])).toBe('shx grep -A 2 TODO app.txt');
  });

  it.each(['cp -LP src dist', 'mv -fn old new'])(
    'refuses contradictory option combinations: %s',
    (script) => {
      const candidate = run(script, ['shx']).find((entry) =>
        ['PS011', 'PS012'].includes(entry.ruleId),
      );
      expect(candidate?.fix).toMatchObject({ safety: 'manual' });
      expect(candidate?.fix?.replacement).toBeUndefined();
    },
  );
});
