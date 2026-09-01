import { describe, expect, it } from 'vitest';
import { DEFAULT_TARGETS } from '../../src/core/targets';
import { applicableFixes, applyToScript } from '../../src/fixers/apply';
import { analyzeScript } from '../../src/rules';
import {
  AUTOMATIC_COMMAND_FIXERS,
  STATIC_PATH_REJECTION_CATEGORIES,
} from '../../src/rules/fix-builders';
import type { Finding, RuleContext } from '../../src/rules/types';

const AUTOMATIC_COMMAND_RULES = AUTOMATIC_COMMAND_FIXERS.map(({ ruleId }) => ruleId);

type AutomaticCommandRule = (typeof AUTOMATIC_COMMAND_FIXERS)[number]['ruleId'];
type StaticPathRejectionCategory = (typeof STATIC_PATH_REJECTION_CATEGORIES)[number];

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
    semanticBoundary: 'cp -p src dist',
  },
  {
    ruleId: 'PS012',
    dependency: 'shx',
    supported: { before: 'mv old.txt new.txt', after: 'shx mv old.txt new.txt' },
    unsupportedOption: 'mv -T old.txt new.txt',
    semanticBoundary: 'mv -n old.txt new.txt',
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

function expectManual(script: string, ruleId: AutomaticCommandRule): void {
  const candidate = finding(script, ruleId, ['rimraf', 'shx']);
  expect(candidate.fix).toMatchObject({ safety: 'manual' });
  expect(candidate.fix?.replacement).toBeUndefined();
  expect(fixed(script, ['rimraf', 'shx'])).toBe(script);
}

describe('automatic command fixer contract coverage', () => {
  it('has exactly one complete contract row for every production automatic command rule', () => {
    expect(COMMAND_CONTRACTS).toHaveLength(AUTOMATIC_COMMAND_FIXERS.length);
    expect(new Set(COMMAND_CONTRACTS.map(({ ruleId }) => ruleId))).toEqual(
      new Set(AUTOMATIC_COMMAND_RULES),
    );
    expect(COMMAND_CONTRACTS.map(({ ruleId, dependency }) => ({ ruleId, dependency }))).toEqual(
      AUTOMATIC_COMMAND_FIXERS.map(({ ruleId, primaryDependency }) => ({
        ruleId,
        dependency: primaryDependency,
      })),
    );
  });

  it('declares the enforced path-safety categories on every production fixer', () => {
    expect(new Set(UNSAFE_PATH_CASES.map(([, , category]) => category))).toEqual(
      new Set(STATIC_PATH_REJECTION_CATEGORIES),
    );
    for (const metadata of AUTOMATIC_COMMAND_FIXERS) {
      expect(metadata.pathSafetyPolicy).toBe('static-project-relative');
      expect(new Set(metadata.rejectedPathCategories)).toEqual(
        new Set(STATIC_PATH_REJECTION_CATEGORIES),
      );
    }
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
    'rm -rf ./.',
    'rm -rf foo/.',
    'rm -rf ././',
    'rm -rf .//./',
    'rm -rf foo//.',
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

  it.each([
    'rm -rf foo/*',
    'rm -rf "foo/*"',
    'rm -rf foo/**',
    'rm -rf "foo/{a,b}"',
    'rm -rf "foo/[ab]"',
    'rm -rf "foo/@(a|b)"',
    'rm -rf foo/\\*',
  ])('never routes a nested or quoted glob through rimraf or shx: %s', (script) => {
    expectManual(script, 'PS010');
  });
});

const UNSAFE_PATH_CASES = [
  ['POSIX absolute path', '/tmp/file', 'absolute-or-drive'],
  ['drive-absolute path', 'C:/temp/file', 'absolute-or-drive'],
  ['drive-relative path', 'C:temp/file', 'absolute-or-drive'],
  ['slash-form UNC path', '//server/share/file', 'absolute-or-drive'],
  ['backslash-form UNC path', '\\\\server\\share\\file', 'absolute-or-drive'],
  ['parent traversal', 'safe/../outside', 'parent-traversal'],
  ['current directory', './.', 'empty-or-current-directory'],
  ['home path', '~/file', 'home-relative'],
  ['nested glob', 'safe/*.txt', 'glob'],
  ['brace expansion', 'safe/{a,b}.txt', 'glob'],
  ['bracket glob', 'safe/[ab].txt', 'glob'],
  ['extended glob', '"safe/@(a|b).txt"', 'glob'],
  ['backtick substitution', '`pwd`/file', 'runtime-expansion'],
  ['POSIX variable expansion', '$HOME/file', 'runtime-expansion'],
  ['POSIX command substitution', '$(pwd)/file', 'runtime-expansion'],
  ['cmd variable expansion', '%TEMP%/file', 'runtime-expansion'],
  ['cmd substring expansion', '%CD:~0,2%/file', 'runtime-expansion'],
  ['cmd delayed expansion', '!TEMP!/file', 'runtime-expansion'],
  ['PowerShell environment expansion', '$env:TEMP/file', 'runtime-expansion'],
  ['dash-prefixed/stdin path', '-', 'dash-prefixed-or-stdin'],
] as const satisfies readonly (readonly [string, string, StaticPathRejectionCategory])[];

const PATH_OPERAND_COMMANDS: readonly {
  ruleId: AutomaticCommandRule;
  scripts: (unsafePath: string) => string[];
}[] = [
  { ruleId: 'PS010', scripts: (path) => [`rm -rf ${path}`] },
  {
    ruleId: 'PS011',
    scripts: (path) => [`cp -r ${path} dist`, `cp -r src ${path}`],
  },
  {
    ruleId: 'PS012',
    scripts: (path) => [`mv ${path} dist`, `mv src ${path}`],
  },
  { ruleId: 'PS013', scripts: (path) => [`mkdir -p ${path}`] },
  { ruleId: 'PS017', scripts: (path) => [`grep TODO ${path}`] },
  { ruleId: 'PS018', scripts: (path) => [`sed "s/a/b/" ${path}`] },
  { ruleId: 'PS019', scripts: (path) => [`cat ${path}`] },
];

describe('shared static project-relative path boundary', () => {
  for (const command of PATH_OPERAND_COMMANDS) {
    describe(command.ruleId, () => {
      it.each(UNSAFE_PATH_CASES)(
        'refuses %s in every file operand',
        (_description, path, _category) => {
          for (const script of command.scripts(path)) {
            expectManual(script, command.ruleId);
          }
        },
      );
    });
  }

  it('does not mistake grep patterns or sed expressions for file operands', () => {
    expect(fixed('grep literal/path src/app.ts', ['shx'])).toBe('shx grep literal/path src/app.ts');
    expect(fixed('sed "s/old/~new/" src/app.ts', ['shx'])).toBe('shx sed "s/old/~new/" src/app.ts');
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

  it.each(['cp -u src dist', 'cp -p src dist', 'mv -n old new'])(
    'refuses flags whose filesystem and exit behavior is not proven equivalent: %s',
    (script) => {
      const ruleId = script.startsWith('cp ') ? 'PS011' : 'PS012';
      expectManual(script, ruleId);
    },
  );

  it.each(['grep -vl TODO src/app.ts', 'grep -lv TODO src/app.ts'])(
    'refuses grep -v/-l combinations with different output behavior: %s',
    (script) => {
      expectManual(script, 'PS017');
    },
  );

  it('refuses grep with multiple explicit files because shx changes filename prefixes', () => {
    expectManual('grep TODO src/a.ts src/b.ts', 'PS017');
  });

  it('requires sed -i to have both an expression and a real file operand', () => {
    expectManual('sed -i "s/a/b/"', 'PS018');
    expectManual('sed -i "s/a/b/" -', 'PS018');
  });

  it.each([
    ['cat -', 'PS019'],
    ['grep TODO -', 'PS017'],
    ['sed "s/a/b/" -', 'PS018'],
  ] as const)('does not claim explicit stdin operand equivalence: %s', (script, ruleId) => {
    expectManual(script, ruleId);
  });

  it.each([
    ['rm -rf -- file', 'PS010'],
    ['cp -r -- src dist', 'PS011'],
    ['mv -- src dist', 'PS012'],
    ['mkdir -p -- dist', 'PS013'],
    ['grep -v -- TODO file', 'PS017'],
    ['sed -i -- "s/a/b/" file', 'PS018'],
    ['cat -- file', 'PS019'],
  ] as const)('refuses an unproven shx option-terminator path: %s', (script, ruleId) => {
    expectManual(script, ruleId);
  });
});
