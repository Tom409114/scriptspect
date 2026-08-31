import { describe, expect, it } from 'vitest';
import { commandIs, walkCommands } from '../../src/parser/ir';
import { tokenizeForTarget } from '../../src/parser/lexer';
import { parseForTarget, parseScript } from '../../src/parser/parse';

describe('dialect edge contracts', () => {
  it('parses empty input and redirection-only input without inventing argv', () => {
    expect([...walkCommands(parseScript('').root)]).toEqual([
      expect.objectContaining({ argv: [], span: [0, 0] }),
    ]);

    const [redirectOnly] = [...walkCommands(parseForTarget('> out', 'posix-sh').root)];
    expect(redirectOnly).toMatchObject({
      argv: [],
      redirects: [{ op: '>', target: { value: 'out' } }],
      span: [0, 5],
    });
  });

  it('keeps supported PowerShell quote and escape forms target-local', () => {
    const [singleQuoted] = [
      ...walkCommands(parseForTarget("echo 'it''s ready'", 'powershell').root),
    ];
    expect(singleQuoted?.argv[1]?.value).toBe("it's ready");

    const [escaped] = [...walkCommands(parseForTarget('echo one` two', 'powershell').root)];
    expect(escaped?.argv[1]?.value).toBe('one two');
  });

  it('handles literal expansion markers and quoted text without phantom expansions', () => {
    const [posix] = [...walkCommands(parseForTarget('echo "$"', 'posix-sh').root)];
    const [cmd] = [...walkCommands(parseForTarget('echo "100%"', 'cmd').root)];

    expect(posix?.argv[1]?.expansions).toEqual([]);
    expect(cmd?.argv[1]?.expansions).toEqual([]);
  });

  it('keeps quoted regions intact while locating POSIX command substitutions', () => {
    const [command] = [
      ...walkCommands(parseForTarget('echo $(printf \'%s\' "x")', 'posix-sh').root),
    ];
    expect(command?.argv[1]?.expansions).toEqual([
      expect.objectContaining({ kind: 'command', raw: '$(printf \'%s\' "x")' }),
    ]);
  });

  it('recognizes descriptor duplication as a complete redirection', () => {
    const parsed = parseForTarget('node app.js 2>&1', 'posix-sh');
    const [command] = [...walkCommands(parsed.root)];

    expect(command?.redirects).toEqual([
      expect.objectContaining({ op: '2>&1', target: null, span: [12, 16] }),
    ]);
    expect(parsed.diagnostics).toEqual([]);
  });

  it('represents balanced, nested, and stray groups deterministically', () => {
    expect(parseForTarget('((echo ok))', 'posix-sh').root.kind).toBe('group');
    expect(parseForTarget(')', 'cmd').diagnostics).toContainEqual(
      expect.objectContaining({ code: 'unbalanced-group', span: [0, 1] }),
    );
  });

  it('matches command names case-insensitively and rejects empty command leaves', () => {
    const [named] = [...walkCommands(parseForTarget('Git status', 'posix-sh').root)];
    const [empty] = [...walkCommands(parseForTarget('> output', 'posix-sh').root)];

    if (named === undefined || empty === undefined)
      throw new Error('expected parsed command leaves');
    expect(commandIs(named, new Set(['git']))).toBe(true);
    expect(commandIs(named, new Set(['node']))).toBe(false);
    expect(commandIs(empty, new Set(['git']))).toBe(false);
  });

  it('stops PowerShell words at inline comments without emitting comment tokens', () => {
    expect(
      tokenizeForTarget('echo value# private note', 'powershell').map((token) => token.value),
    ).toEqual(['echo', 'value']);
  });

  it('keeps trailing PowerShell escape markers literal inside and outside quotes', () => {
    expect(tokenizeForTarget('echo value`', 'powershell')[1]?.value).toBe('value`');
    expect(tokenizeForTarget('echo "value`', 'powershell')[1]?.value).toBe('value`');
  });

  it('removes a POSIX escaped newline inside double quotes', () => {
    expect(tokenizeForTarget('echo "one\\\ntwo"', 'posix-sh')[1]?.value).toBe('onetwo');
  });

  it('keeps unterminated quoted command substitutions as one bounded expansion', () => {
    expect(tokenizeForTarget("echo $('unterminated", 'posix-sh')[1]?.expansions).toEqual([
      expect.objectContaining({ kind: 'command', raw: "$('unterminated" }),
    ]);
  });

  it('tracks nested braces until the matching parameter-expansion delimiter', () => {
    const expansion = ['$', '{OUT:-$', '{FALLBACK}}'].join('');
    expect(tokenizeForTarget(`echo ${expansion}`, 'posix-sh')[1]?.expansions).toEqual([
      expect.objectContaining({ kind: 'braced', raw: expansion }),
    ]);
  });
});

describe('translated wrapper IR branches', () => {
  it.each([
    ['bash -c "(echo hi)"', 'group'],
    ['bash -c "echo one; echo two"', 'sequence'],
    ['bash -c "echo one | cat"', 'pipeline'],
  ] as const)('source-maps a %s payload with a %s root', (source, rootKind) => {
    const [outer] = [...walkCommands(parseForTarget(source, 'posix-sh').root)];
    expect(outer?.wrapper?.inner?.root.kind).toBe(rootKind);
    const payloadSpan = outer?.wrapper?.payloadSourceSpan;
    expect(outer?.wrapper?.payloadRaw).toBe(
      payloadSpan === null || payloadSpan === undefined ? '' : source.slice(...payloadSpan),
    );
  });

  it('source-maps nested supported wrappers', () => {
    const [outer] = [...walkCommands(parseForTarget('bash -c "sh -c echo"', 'posix-sh').root)];
    const [inner] = [...walkCommands(outer?.wrapper?.inner?.root ?? parseScript('').root)];

    expect(inner?.wrapper).toMatchObject({
      shell: 'sh',
      payloadSupport: 'supported',
      payloadRaw: 'echo',
    });
  });
});
