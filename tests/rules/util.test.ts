import { describe, expect, it } from 'vitest';
import type { ParseMatrix } from '../../src/parser/ir';
import { parseForTarget, parseMatrix } from '../../src/parser/parse';
import {
  availabilityRule,
  collectSequenceOps,
  commandsOf,
  flagsOf,
  isCommand,
} from '../../src/rules/util';
import { makeCtx } from './helpers';

describe('rule traversal utilities', () => {
  it('collects nested sequence operators through groups, booleans, and pipelines', () => {
    const root = parseForTarget('(a; b) && (c | d)\ne', 'posix-sh').root;

    expect(collectSequenceOps(root)).toEqual([
      { op: '\n', span: [17, 18] },
      { op: ';', span: [2, 3] },
    ]);
  });

  it('accepts an existing accumulator and leaves command leaves unchanged', () => {
    const existing = [{ op: '&', span: [10, 11] as [number, number] }];
    const root = parseForTarget('node app.js', 'posix-sh').root;

    expect(collectSequenceOps(root, existing)).toBe(existing);
    expect(existing).toEqual([{ op: '&', span: [10, 11] }]);
  });

  it('returns target-local commands and handles an absent evidence graph', () => {
    const parsed = parseForTarget('node app.js', 'posix-sh');
    const matrix: ParseMatrix = {
      source: 'node app.js',
      activeTargets: new Set(['posix-sh']),
      byTarget: new Map([['posix-sh', parsed]]),
    };

    expect(commandsOf(matrix).map((command) => command.argv[0]?.value)).toEqual(['node']);
    expect(commandsOf(matrix, 'cmd')).toEqual([]);
  });

  it('compares executable names case-insensitively and extracts only flags', () => {
    const [command] = commandsOf(parseMatrix('Git -C repo status --short', ['posix-sh'], []));

    if (command === undefined) throw new Error('expected a parsed command');
    expect(isCommand(command, 'git')).toBe(true);
    expect(isCommand(command, 'node')).toBe(false);
    expect(flagsOf(command)).toEqual(['-C', '--short']);
  });
});

describe('availability rule factory', () => {
  const metadata = {
    id: 'PS999',
    title: 'TEST_AVAILABILITY',
    summary: 'Exercises the shared availability contract.',
    severity: 'warn' as const,
    confidence: 'high' as const,
    affectedTargets: ['cmd'] as const,
    badExamples: ['tool input', 'tool --flag input'],
    goodExamples: ['node helper.js', 'portable-tool input'],
    falsePositiveNotes: 'Only the exact command name is matched.',
    fixSafety: 'manual' as const,
    provenance: [{ source: 'https://example.test/tool', claim: 'test contract' }],
  };

  it('uses the default manual fix only for matching commands on active targets', () => {
    const rule = availabilityRule(metadata, {
      names: new Set(['tool']),
      message: (command) => `replace ${command.argv[0]?.value}`,
      fixSummary: 'replace with a portable command',
      matches: (command) => flagsOf(command).includes('--portable-risk'),
    });
    const source = 'tool safe && tool --portable-risk input';
    const matrix = parseMatrix(source, ['cmd'], [rule.id]);

    expect(rule.check(matrix, makeCtx({ script: source, targets: ['cmd'] }))).toEqual([
      expect.objectContaining({
        message: 'replace tool',
        span: [13, 17],
        fix: expect.objectContaining({
          ruleId: 'PS999',
          safety: 'manual',
          description: 'replace with a portable command',
        }),
      }),
    ]);
    const inactiveMatrix = parseMatrix(source, ['posix-sh'], [rule.id]);
    expect(rule.check(inactiveMatrix, makeCtx({ script: source, targets: ['posix-sh'] }))).toEqual(
      [],
    );
  });

  it('supports a custom fix builder and ignores redirection-only commands', () => {
    const rule = availabilityRule(metadata, {
      names: new Set(['tool']),
      message: () => 'replace tool',
      fixSummary: 'unused when the custom builder is present',
      fix: (_command, context) => ({
        ruleId: 'PS999',
        safety: context.dependencies.has('portable-tool') ? 'safe' : 'conditional',
        description: 'use portable-tool',
      }),
    });
    const source = '> output && tool input';
    const matrix = parseMatrix(source, ['cmd'], [rule.id]);

    expect(
      rule.check(
        matrix,
        makeCtx({ script: source, targets: ['cmd'], dependencies: new Set(['portable-tool']) }),
      ),
    ).toEqual([expect.objectContaining({ fix: expect.objectContaining({ safety: 'safe' }) })]);
  });
});
